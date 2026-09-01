#!/usr/bin/env node
// Envoi des fiches et des transcripts. Tourne detache du hook, donc il a le droit d'etre lent :
// personne ne l'attend. Il ne parle jamais a GCS directement (aucun credential Google sur le poste),
// il demande au service une URL signee a duree de vie courte et y depose le fichier.
//
// Deux modes, cumulables :
//   --drain    envoie ce qui attend dans la file (defaut du SessionEnd)
//   --rescan   rattrape les sessions terminees dont le hook n'a jamais tire

import * as fs from 'node:fs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync, createReadStream, createWriteStream } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { analyzeTranscript, readEvents, scanSidechains } from './telemetry-lib.mjs';
import { STATE_DIR, QUEUE_DIR, SENT_FILE, LOCK_FILE, PROJECTS_DIR, loadConfig, projectAllowed, scopeActive } from './paths.mjs';
import { localDetector, redactCard, shareTranscripts } from './privacy.mjs';

const LOCK_TTL_MS = 15 * 60 * 1000;
const RESCAN_WINDOW_MS = 7 * 24 * 3600 * 1000;
const RESCAN_SETTLE_MS = 30 * 60 * 1000;   // en deca, la session est peut-etre encore ouverte
const RESCAN_MAX = 20;
// Premier demarrage : on prend TOUT l'historique present sur la machine, sans fenetre. C'est la
// seule occasion de le faire (Claude Code purge ses propres transcripts au bout d'un moment), et
// c'est ce qui donne un point de comparaison AVANT installation. Etale sur plusieurs passages pour
// ne pas saturer la connexion de quelqu'un le jour de son installation.
const BOOTSTRAP_WINDOW_MS = 3650 * 24 * 3600 * 1000;
const BOOTSTRAP_MAX = 60;
const MAX_ATTEMPTS = 5;
const HTTP_TIMEOUT_MS = 120 * 1000;

const cfg = loadConfig();
const TMP_DIR = join(STATE_DIR, 'tmp');
const BOOTSTRAP_FLAG = join(STATE_DIR, 'bootstrapped');

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }

// Verrou best-effort : deux sessions fermees coup sur coup ne doivent pas televerser en double.
function takeLock() {
  try {
    const cur = readJson(LOCK_FILE, null);
    if (cur && Date.now() - cur.ts < LOCK_TTL_MS) return false;
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch { return false; }
}
function releaseLock() { try { unlinkSync(LOCK_FILE); } catch { /* deja parti */ } }

async function post(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.endpoint.replace(/\/$/, '') + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return await res.json().catch(() => ({}));
  } finally { clearTimeout(timer); }
}

// Fichiers d'une session : le transcript mere, les agents, les runs de workflow. C'est ce qui permet
// de relire la conversation exacte plus tard, y compris ce qu'ont fait les sous-agents.
function sessionFiles(transcriptPath, sessionDir) {
  const out = [];
  if (existsSync(transcriptPath)) out.push({ rel: basename(transcriptPath), abs: transcriptPath });
  for (const sub of ['subagents', 'workflows']) {
    const dir = join(sessionDir, sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const abs = join(dir, n);
      try { if (statSync(abs).isFile()) out.push({ rel: `${sub}/${n}`, abs }); } catch { /* volatil */ }
    }
  }
  return out;
}

async function gzipToTmp(abs, tag) {
  mkdirSync(TMP_DIR, { recursive: true });
  const dest = join(TMP_DIR, tag.replace(/[^\w.-]/g, '_') + '.gz');
  await pipeline(createReadStream(abs), createGzip(), createWriteStream(dest));
  return dest;
}

async function putSigned(url, filePath) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/gzip' },
      body: readFileSync(filePath),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`PUT -> ${res.status}`);
  } finally { clearTimeout(timer); }
}

async function sendOne(item) {
  const { card } = item;
  await post('/v1/sessions', { card });

  // La fiche part toujours ; le transcript seulement si le poste l'a demande. C'est tout ce que ce
  // reglage change cote reseau : la fiche est deja partie a la ligne du dessus, complete.
  if (!shareTranscripts(cfg)) return;

  const files = sessionFiles(item.transcript_path, item.session_dir);
  if (!files.length) return;

  const signed = await post('/v1/transcripts/sign', {
    user: card.user, date: card.date, sid: card.sid,
    files: files.map(f => ({ name: f.rel })),
  });
  const urls = new Map((signed.urls || []).map(u => [u.name, u.url]));

  for (const f of files) {
    const url = urls.get(f.rel);
    if (!url) continue;
    let gz;
    try {
      gz = await gzipToTmp(f.abs, `${card.sid}_${f.rel}`);
      await putSigned(url, gz);
    } finally { if (gz) { try { unlinkSync(gz); } catch { /* deja parti */ } } }
  }
}

function markSent(sid) {
  const sent = readJson(SENT_FILE, {});
  sent[sid] = new Date().toISOString();
  // Bornage : l'index sert a ne pas renvoyer deux fois, pas a garder l'histoire.
  const keys = Object.keys(sent).sort((a, b) => (sent[a] < sent[b] ? 1 : -1)).slice(0, 5000);
  const trimmed = {};
  for (const k of keys) trimmed[k] = sent[k];
  try { writeFileSync(SENT_FILE, JSON.stringify(trimmed)); } catch { /* disque plein */ }
}

// Le detecteur local se choisit AUSSI a l'envoi, et pour la meme raison que le caviardage : la fiche
// a pu etre calculee quand le transcript partait encore. Elle sort alors `judged:false`, ce qui est
// voulu -- la passe haiku fait mieux, et elle la reprendra depuis le transcript stocke. Mais si le
// poste a coupe `transcripts` entre-temps, ce transcript ne partira plus : le juge n'aura jamais de
// matiere et `signals.friction` resterait null POUR TOUJOURS, exactement le trou que ce reglage
// devait eviter. Meme cas pour une fiche enfilee par une version anterieure du capteur.
//
// On repasse donc le detecteur deterministe sur le transcript, encore present sur le disque, et on
// ne releve que le verdict -- les compteurs de la fiche, eux, ont ete calcules par le hook avec les
// sidechains sous la main, et ils font foi. A appeler AVANT redactCard : les frictions produites ici
// portent leur texte.
function judgeLocally(item, detector) {
  try {
    const fresh = analyzeTranscript(readEvents(readFileSync, item.transcript_path), { sid: item.card.sid }, detector);
    const { friction, regression, correction, validation } = fresh.signals || {};
    item.card.signals = { ...(item.card.signals || {}), friction, regression, correction, validation };
    item.card.friction_prompts = fresh.friction_prompts || [];
    item.card.judged = true;
    item.card.judged_by = 'regex-local';
  } catch { /* transcript purge depuis : la fiche part telle quelle, judged:false */ }
}

// Et le sens inverse : le transcript repart, donc la passe haiku aura de la matiere et fera mieux
// que la regex. Le verdict local qu'on avait pose empecherait justement de la reprendre -- cette
// passe filtre sur `judged` -- et on garderait le moins bon des deux verdicts pour toujours.
//
// Effacer un verdict est ce qui a coute 84 verdicts le 27/07, mais c'etait AVANT carryOverVerdict :
// une fiche qui repart `judged:false` se voit desormais reposer le verdict deja stocke par le
// serveur, s'il en existe un. Le seul intervalle a nu est celui d'avant la passe haiku, qui est
// l'etat normal de toute fiche d'un poste qui partage ses transcripts.
//
// UNIQUEMENT le verdict qu'on a pose nous-memes : un `judged:true` sans provenance ne vient pas
// d'ici, on n'y touche pas. Les signaux repassent a null et pas a zero -- `judged:false` avec
// friction:0 dirait "juge, rien trouve" la ou il faut lire "pas encore juge", et confondre les deux
// est la panne du 16/07.
function unjudgeLocal(card) {
  card.signals = { ...(card.signals || {}), friction: null, regression: null, correction: null, validation: null };
  card.friction_prompts = [];
  card.judged = false;
  delete card.judged_by;
}

async function drain() {
  let names = [];
  try { names = readdirSync(QUEUE_DIR).filter(n => n.endsWith('.json')); } catch { return; }
  for (const n of names) {
    const p = join(QUEUE_DIR, n);
    const item = readJson(p, null);
    if (!item || !item.card) { try { unlinkSync(p); } catch {} continue; }
    // Filet : un item hors perimetre (enfile avant l'activation de l'allowlist, ou par une version
    // anterieure du capteur) est retire de la file sans etre envoye.
    if (!projectAllowed(basename(dirname(item.transcript_path || '')), cfg)) { try { unlinkSync(p); } catch {} continue; }
    // Le reglage s'applique a l'instant ou la fiche PART, pas a celui ou elle a ete calculee. Une
    // fiche peut avoir attendu ici plusieurs jours (cinq tentatives), avoir ete enfilee par une
    // version anterieure du capteur -- donc avec tout son verbatim et sans `shares` -- ou avoir
    // traverse un changement d'avis du poste. Sans ce second passage, une mise a jour vers le defaut
    // `false` enverrait quand meme le verbatim de tout ce qui trainait dans la file, et couper le
    // reglage ne couperait rien pour les fiches deja calculees. Repasser le caviardage ne peut que
    // retirer : c'est le seul endroit qui sait ce que le poste veut aujourd'hui.
    //
    // Le detecteur suit la meme regle, et `localDetector` porte deja la decision : il rend le
    // detecteur regex quand le transcript ne part pas, null quand il part. LES DEUX SENS comptent,
    // parce qu'une fiche peut avoir change de monde entre son calcul et son envoi : sans transcript
    // il faut poser un verdict que personne d'autre ne posera, avec transcript il faut retirer le
    // notre pour que la passe haiku puisse faire mieux. En regime normal aucun des deux ne se
    // declenche, le hook ayant pris la meme decision sur la meme config.
    const detector = localDetector(cfg);
    if (detector && !item.card.judged) judgeLocally(item, detector);
    else if (!detector && item.card.judged_by === 'regex-local') unjudgeLocal(item.card);
    redactCard(item.card, cfg);
    try {
      await sendOne(item);
      markSent(item.card.sid);
      try { unlinkSync(p); } catch {}
    } catch {
      item.attempts = (item.attempts || 0) + 1;
      // Au-dela, l'echec est structurel (fiche rejetee, poste hors ligne depuis des jours) :
      // on abandonne cette session plutot que de retenter a chaque demarrage jusqu'a la fin des temps.
      if (item.attempts >= MAX_ATTEMPTS) { try { unlinkSync(p); } catch {} }
      else { try { writeFileSync(p, JSON.stringify(item)); } catch {} }
    }
  }
}

// Rattrapage. Le SessionEnd ne tire pas toujours (fermeture brutale, machine eteinte, crash) et
// contrairement au poste de Lucas on ne peut pas rejouer l'historique a distance : c'est le seul
// filet. Borne en nombre et en fenetre pour rester invisible.
function rescan() {
  const sent = readJson(SENT_FILE, {});
  let queued = [];
  try { queued = readdirSync(QUEUE_DIR).map(n => n.replace(/\.json$/, '')); } catch { /* pas de file */ }
  const known = new Set([...Object.keys(sent), ...queued]);
  const now = Date.now();
  const candidates = [];

  // Premier setup : tout ce que la machine porte encore. Claude Code purge ses propres transcripts
  // au bout de `cleanupPeriodDays` (30 par defaut, verifie sur poste : rien au-dela de ~35 jours),
  // donc "tout l'historique" veut dire le dernier mois, pas la vie entiere du poste.
  const bootstrapping = !existsSync(BOOTSTRAP_FLAG);
  const windowMs = bootstrapping ? BOOTSTRAP_WINDOW_MS : RESCAN_WINDOW_MS;
  const maxItems = bootstrapping ? BOOTSTRAP_MAX : RESCAN_MAX;

  let projects = [];
  try { projects = readdirSync(PROJECTS_DIR); } catch { return; }
  for (const proj of projects) {
    if (!projectAllowed(proj, cfg)) continue;   // hors perimetre : pas de rattrapage
    const dir = join(PROJECTS_DIR, proj);
    let names = [];
    try { names = readdirSync(dir).filter(n => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const sid = n.replace(/\.jsonl$/, '');
      if (known.has(sid)) continue;
      const abs = join(dir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const age = now - st.mtimeMs;
      if (age > windowMs || age < RESCAN_SETTLE_MS) continue;
      candidates.push({ sid, abs, proj, mtime: st.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates.slice(0, maxItems)) {
    try {
      const events = readEvents(readFileSync, c.abs);
      const sessionDir = c.abs.replace(/\.jsonl$/, '');
      const card = analyzeTranscript(events, {
        sid: c.sid,
        project: c.proj.replace(/^-/, '').split('-').pop() || c.proj,
        sidechains: scanSidechains(fs, sessionDir),
      }, localDetector(cfg));
      if (!card.subject || (card.user_prompts < 1 && !card.automated)) { markSent(c.sid); continue; }
      card.user = cfg.user || userInfo().username;
      card.host = hostname();
      card.platform = process.platform;
      card.client_version = cfg.version || null;
      card.scoped = scopeActive(cfg);
      card.recovered = true;
      if (card.judged) card.judged_by = 'regex-local';
      redactCard(card, cfg);
      mkdirSync(QUEUE_DIR, { recursive: true });
      writeFileSync(join(QUEUE_DIR, `${c.sid}.json`), JSON.stringify({
        card, transcript_path: c.abs, session_dir: sessionDir,
        queued_at: new Date().toISOString(), attempts: 0,
      }));
    } catch { /* transcript illisible, on passe */ }
  }

  if (bootstrapping && candidates.length <= maxItems) {
    try { writeFileSync(BOOTSTRAP_FLAG, new Date().toISOString()); } catch { /* retente au prochain demarrage */ }
  }
}

async function main() {
  if (!cfg.endpoint || !cfg.token) process.exit(0);
  if (!takeLock()) process.exit(0);
  try {
    if (process.argv.includes('--rescan')) rescan();
    await drain();
  } finally {
    try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* rien a nettoyer */ }
    releaseLock();
  }
  process.exit(0);
}

main().catch(() => { releaseLock(); process.exit(0); });
