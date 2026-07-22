#!/usr/bin/env node
// Capteur de telemetrie d'iteration IA. Branche sur SessionEnd et SessionStart par le plugin.
//
// Il ne fait QUE lire ce que Claude Code a deja ecrit sur le disque : il ne modifie aucune config,
// n'injecte aucun contexte, ne change rien au comportement de la session. Aucun appel de modele.
//
// Contrainte non negociable : ne jamais retarder ni bloquer une session. Le hook calcule la fiche
// (deterministe, quelques dizaines de ms) puis rend la main. Tout ce qui touche au reseau part dans
// un process DETACHE : un upload de transcript peut peser des dizaines de Mo, il n'a rien a faire
// dans le chemin critique de la fermeture d'une session.

import * as fs from 'node:fs';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { analyzeTranscript, readEvents, scanSidechains } from './telemetry-lib.mjs';
import { STATE_DIR, QUEUE_DIR, loadConfig, projectAllowed, scopeActive } from './paths.mjs';

// Mesure : 5,1 s pour les 336 Mo d'une nuit orchestree. Au-dela du budget la fiche sort
// `partial:true` ; le serveur garde le transcript complet, donc rien n'est perdu.
const SIDECHAIN_BUDGET_MS = 2000;

const HERE = dirname(fileURLToPath(import.meta.url));

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function projectLabel(cwd) {
  if (!cwd) return null;
  const b = basename(cwd);
  const wt = b.match(/^(.*?)--claude-worktrees-(.+)$/) || b.match(/^wt-(.+)$/);
  if (wt) return wt[2] ? `${wt[1] || 'wt'}:${wt[2]}` : `wt:${wt[1]}`;
  return b;
}

// L'uploader tourne seul, sans terminal rattache. windowsHide evite la fenetre console qui clignote
// a chaque fin de session sur le poste Windows : c'est la difference entre un capteur invisible et
// un truc qu'on finit par desinstaller.
function detachUploader(args) {
  try {
    const child = spawn(process.execPath, [join(HERE, 'uploader.mjs'), ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch { /* pas d'upload cette fois, la file sera drainee au prochain demarrage */ }
}

function main() {
  const cfg = loadConfig();
  if (cfg.enabled === false || process.env.LATRACE_TELEMETRY_OFF === '1') process.exit(0);

  let stdin = '';
  try { stdin = readFileSync(0, 'utf8'); } catch { /* pas de stdin */ }
  const input = safeParse(stdin) || {};
  const event = input.hook_event_name || '';

  // Au demarrage on ne calcule rien : on delegue le drain de la file et le rattrapage des sessions
  // dont le SessionEnd n'a jamais tire (fermeture brutale, crash, machine eteinte).
  if (event === 'SessionStart') {
    detachUploader(['--drain', '--rescan']);
    process.exit(0);
  }

  const transcriptPath = input.transcript_path || input.transcriptPath;
  const sid = input.session_id || input.sessionId || '';
  const cwd = input.cwd || process.cwd();
  if (!transcriptPath || !existsSync(transcriptPath) || !sid) process.exit(0);
  // Perimetre : hors allowlist (include_projects), on ne capte pas cette session.
  if (!projectAllowed(cwd, cfg)) process.exit(0);

  const events = readEvents(readFileSync, transcriptPath);
  const sessionDir = transcriptPath.replace(/\.jsonl$/, '');
  const sidechains = scanSidechains(fs, sessionDir, { budgetMs: SIDECHAIN_BUDGET_MS });
  const card = analyzeTranscript(events, { sid, project: projectLabel(cwd), sidechains });

  if (!card.subject || (card.user_prompts < 1 && !card.automated)) process.exit(0);

  card.user = cfg.user || userInfo().username;
  card.host = hostname();
  card.platform = process.platform;
  card.client_version = cfg.version || null;
  // Un poste qui restreint son perimetre (include_projects) ne montre qu'une partie de son travail.
  // Sans ce temoin, il serait indistinguable d'un poste peu actif : la mesure deviendrait
  // declarative sans que personne ne le voie. Le detail des chemins ne remonte pas, seul le fait.
  card.scoped = scopeActive(cfg);

  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(join(QUEUE_DIR, `${sid}.json`), JSON.stringify({
    card,
    transcript_path: transcriptPath,
    session_dir: sessionDir,
    queued_at: new Date().toISOString(),
    attempts: 0,
  }));

  // `--rescan` ici AUSSI, pas seulement au demarrage : quelqu'un qui installe le plugin pendant une
  // session en cours n'a pas eu de SessionStart avec le capteur actif, et son historique resterait
  // invisible jusqu'a ce qu'il relance Claude Code. Vu le 22/07 sur la premiere installation.
  // Le cout est nul en regime normal : le rescan ne fait qu'un parcours de repertoire quand il n'y
  // a rien a rattraper, et il tourne dans le process detache.
  detachUploader(['--drain', '--rescan']);
  process.exit(0);
}

try { main(); } catch { process.exit(0); }
