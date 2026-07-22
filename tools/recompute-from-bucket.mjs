#!/usr/bin/env node
// Recalcule les fiches d'un poste A PARTIR DES TRANSCRIPTS DEJA STOCKES, et les renvoie.
//
// Raison d'etre : quand on corrige la lib d'analyse, les fiches deja envoyees restent fausses, et
// le poste ne les renverra jamais (son index `sent.json` les considere comme faites). Comme les
// transcripts bruts sont conserves, on peut tout rejouer sans toucher a la machine de personne.
//
//   node tools/recompute-from-bucket.mjs --user mathilde [--dry]

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
const dry = process.argv.includes('--dry');
const bucket = process.env.LATRACE_TELEMETRY_BUCKET || 'latrace-claude-telemetry';
if (!user) { console.error('usage: --user <nom> [--dry]'); process.exit(1); }

const cfg = JSON.parse(readFileSync(join(process.env.HOME, '.latrace-telemetry', 'config.json'), 'utf8'));

const gs = (...a) => execFileSync('gcloud', ['storage', ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

const sessions = new Map();
for (const line of gs('ls', '-r', `gs://${bucket}/transcripts/${user}/`).split('\n')) {
  const m = line.trim().match(/^gs:\/\/[^/]+\/transcripts\/[^/]+\/(\d{4}-\d{2}-\d{2})\/([^/]+)\/(.+)\.gz$/);
  if (!m) continue;
  const [, date, sid, rel] = m;
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
    for (const k of ['user', 'host', 'platform', 'project', 'client_version', 'scoped', 'recovered']) {
      if (old[k] !== undefined) card[k] = old[k];
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
