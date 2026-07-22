#!/usr/bin/env node
// Rapatrie les fiches de l'equipe pour l'audit local. Les fiches de chacun restent dans leur propre
// dossier : les melanger a ~/brain/telemetry/sessions ferait compter les sessions des autres dans
// tous les dashboards de chantier deja publies.
//
//   node tools/pull.mjs                 toutes les fiches
//   node tools/pull.mjs --user quentin  un seul poste
//
// Les transcripts ne sont PAS rapatries en masse (des Go). Pour en relire un :
//   gcloud storage cp -r gs://<bucket>/transcripts/<user>/<date>/<sid> /tmp/ && gunzip -r /tmp/<sid>

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUCKET = process.env.LATRACE_TELEMETRY_BUCKET || 'latrace-claude-telemetry';
const DEST = join(homedir(), 'brain', 'telemetry', 'team');
const userArg = process.argv.indexOf('--user');
const user = userArg > -1 ? process.argv[userArg + 1] : null;

const src = user ? `gs://${BUCKET}/cards/${user}` : `gs://${BUCKET}/cards`;
const dest = user ? join(DEST, user) : DEST;
mkdirSync(dest, { recursive: true });

execFileSync('gcloud', ['storage', 'rsync', '-r', src, dest], { stdio: 'inherit' });
console.log(`fiches -> ${dest}`);
