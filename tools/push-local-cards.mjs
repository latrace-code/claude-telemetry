#!/usr/bin/env node
// Envoie les fiches deja calculees sur le poste (~/brain/telemetry/sessions/) vers l'ingestion.
// Sert a amorcer le cockpit avec l'historique : ces fiches n'ont pas de transcript associe cote
// serveur, seul le capteur en remonte. Idempotent (meme chemin d'objet).
//
//   node tools/push-local-cards.mjs --user lucas [--since 2026-06-01] [--limit 500]

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};

// Meme source que le capteur : la config du poste d'abord, le fichier du depot ensuite (il n'existe
// plus depuis que le secret en est sorti, et il porterait un jeton perime).
const readCfg = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const cfg = {
  ...readCfg(join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'config.json')),
  ...readCfg(join(homedir(), '.latrace-telemetry', 'config.json')),
};
const dir = arg('dir', join(homedir(), 'brain', 'telemetry', 'sessions'));
const user = arg('user', 'lucas');
const since = arg('since', '0000-00-00');
const limit = parseInt(arg('limit', '5000'), 10);

const files = readdirSync(dir).filter(f => f.endsWith('.json') && f.slice(0, 10) >= since).sort().slice(-limit);
let sent = 0, failed = 0;

for (const f of files) {
  let card;
  try { card = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
  if (!card.sid) continue;
  card.user = card.user || user;
  card.platform = card.platform || 'linux';
  card.backfilled = true;
  try {
    const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ card }),
    });
    if (res.ok) sent++; else failed++;
  } catch { failed++; }
  if ((sent + failed) % 100 === 0) process.stdout.write(`\r${sent + failed}/${files.length}`);
}
console.log(`\n${sent} fiches envoyees, ${failed} echecs`);
