#!/usr/bin/env node
// Recalcule les fiches d'un poste A PARTIR DES TRANSCRIPTS DEJA STOCKES, et les renvoie.
//
// Raison d'etre : quand on corrige la lib d'analyse, les fiches deja envoyees restent fausses, et
// le poste ne les renverra jamais (son index `sent.json` les considere comme faites). Comme les
// transcripts bruts sont conserves, on peut tout rejouer sans toucher a la machine de personne.
//
//   node tools/recompute-from-bucket.mjs --user mathilde [--since 2026-07-20] [--until 2026-07-25] [--dry]
//
// Compter ~4 s par session : le temps part en demarrages de gcloud, pas en calcul. Sur un poste qui
// a des centaines de sessions stockees, passer `--since` pour rejouer d'abord la fenetre qu'on
// regarde (le cockpit s'ouvre sur 7 ou 30 jours) plutot que d'attendre tout l'historique.
//
// `--until` (borne haute, exclue) sert a decouper une passe longue en tranches de dates DISJOINTES
// qu'on lance en parallele : une fiche est ecrite par une seule tranche, donc pas de course. C'est
// le seul moyen de rejouer les ~1 600 sessions d'un poste CLI ailleurs qu'en une heure et demie de
// file d'attente, puisque le cout est un demarrage de gcloud par fichier et pas du calcul.

import * as fs from 'node:fs';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { analyzeTranscript, readEvents, scanSidechains } from '../client/telemetry-lib.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const user = arg('user');
const since = arg('since', '0000-00-00');
const until = arg('until', '9999-99-99');
const dry = process.argv.includes('--dry');
const bucket = process.env.LATRACE_TELEMETRY_BUCKET || 'latrace-claude-telemetry';
if (!user) { console.error('usage: --user <nom> [--since AAAA-MM-JJ] [--until AAAA-MM-JJ] [--dry]'); process.exit(1); }

const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.latrace-telemetry', 'config.json'), 'utf8'));

const gs = (...a) => execFileSync('gcloud', ['storage', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));

const sessions = new Map();
for (const line of gs('ls', '-r', `gs://${bucket}/transcripts/${user}/`).split('\n')) {
  const m = line.trim().match(/^gs:\/\/[^/]+\/transcripts\/[^/]+\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/(.+)\.gz$/);
  if (!m) continue;
  const [, date, sid, rel] = m;
  if (date < since || date >= until) continue;
  if (!sessions.has(sid)) sessions.set(sid, { sid, date, files: [] });
  sessions.get(sid).files.push({ rel, url: line.trim() });
}
console.log(`${sessions.size} session(s) de ${user} dans le stockage`);

let sent = 0, skipped = 0;
for (const s of sessions.values()) {
  const tmp = mkdtempSync(join(tmpdir(), 'recompute-'));
  try {
    // Reconstitue l'arborescence locale attendue par scanSidechains : <sid>.jsonl + <sid>/subagents/...
    for (const f of s.files) {
      const dest = join(tmp, f.rel);
      fs.mkdirSync(dirname(dest), { recursive: true });
      gs('cp', f.url, dest + '.gz');
      await pipeline(createReadStream(dest + '.gz'), createGunzip(), createWriteStream(dest));
      rmSync(dest + '.gz', { force: true });
    }
    const main = join(tmp, `${s.sid}.jsonl`);
    if (!existsSync(main)) { skipped++; continue; }

    const card = analyzeTranscript(readEvents(readFileSync, main), {
      sid: s.sid,
      sidechains: scanSidechains(fs, join(tmp, s.sid)),
    });
    if (!card.subject) { skipped++; continue; }

    // Champs que seul le poste connait : on les reprend de la fiche existante plutot que de les inventer.
    let old = {};
    try { old = JSON.parse(gs('cat', `gs://${bucket}/cards/${user}/${s.date}_${s.sid}.json`)); } catch { /* pas de fiche */ }
    // `plugin_version` en fait partie et c'est important : cette passe reecrit `schema` avec la lib
    // de la machine qui rejoue, donc le schema ne dit RIEN de la version installee chez le poste.
    // Ecraser le stamp du poste rendrait un capteur gele indetectable, ce qu'il a deja ete 5 jours.
    for (const k of ['user', 'host', 'platform', 'project', 'client_version', 'plugin_version', 'scoped', 'recovered']) {
      if (old[k] !== undefined) card[k] = old[k];
    }
    // Le VERDICT de friction se reprend aussi. Il est produit ailleurs (juge haiku, machine d'audit)
    // et cette passe ne sait pas le recalculer : sans ca, un recompute repose `judged:false` et efface
    // en silence tout le travail du juge. Vu deux fois en une heure le 22/07, les deux passes tournant
    // le meme jour sur les memes fiches. Le juge repassera de toute facon et rafraichira le verdict si
    // les prompts ont bouge ; entre-temps, mieux vaut l'ancien verdict que pas de verdict du tout.
    if (old.judged) {
      card.signals = { ...card.signals, ...pick(old.signals, ['friction', 'correction', 'regression']) };
      card.friction_prompts = old.friction_prompts || [];
      card.judged = true;
      card.judged_at = old.judged_at;
    }
    card.user = card.user || user;
    card.recomputed = true;

    console.log(`  ${s.sid.slice(0, 8)} actif ${String(old.active_min ?? '?').padStart(6)} -> ${String(card.active_min).padStart(6)} min`);
    if (!dry) {
      const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ card }),
      });
      if (res.ok) {
        sent++;
        // Le recalcul peut deplacer `ts_start` (l'historique rejoue ne compte plus), donc la date de
        // la fiche, donc son chemin. Sans ce menage, l'ancienne survit et la session compte double.
        if (card.date && card.date !== s.date) {
          try { gs('rm', `gs://${bucket}/cards/${user}/${s.date}_${s.sid}.json`); } catch { /* deja partie */ }
        }
      } else skipped++;
    }
  } catch (e) {
    console.log(`  ${s.sid.slice(0, 8)} echec : ${e.message}`);
    skipped++;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
console.log(dry ? '(simulation, rien envoye)' : `${sent} fiche(s) renvoyee(s), ${skipped} ignoree(s)`);
