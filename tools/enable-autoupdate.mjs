#!/usr/bin/env node
// Declare le marketplace `latrace` comme auto-updatable dans ~/.claude/settings.json.
//
// POURQUOI CE SCRIPT EXISTE. Claude Code ne met a jour tout seul QUE les marketplaces Anthropic :
// la decision se lit `entry.autoUpdate ?? (nom appartient a une liste officielle en dur)`, donc pour
// un marketplace tiers le defaut est false. Un plugin installe reste alors epingle au commit du jour
// de l'installation, indefiniment. Mesure sur le poste de Lucas : installe le 22/07, toujours sur le
// meme commit le 27/07, alors que le depot avait avance de huit commits. Aucun message, aucune trace,
// les fiches continuaient d'arriver, simplement sans les mesures ajoutees entre-temps.
//
// Le champ `version` de plugin.json n'a rien a voir avec ca : l'enlever evite d'epingler une version
// figee, mais ne declenche aucune mise a jour. La note interne qui promettait "sans lui, chaque
// commit devient une version et le sync se fait tout seul" decrivait une intention, pas le code.
//
// Ce script ne touche a rien d'autre : il ajoute une cle a l'entree deja presente (ou la cree), et
// laisse le reste du fichier intact. Idempotent, sans effet la deuxieme fois.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NAME = 'latrace';
const SOURCE = { source: 'github', repo: 'latrace-code/claude-telemetry' };

const dir = join(homedir(), '.claude');
const file = join(dir, 'settings.json');

let settings = {};
if (existsSync(file)) {
  const raw = readFileSync(file, 'utf8');
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    // On ne reecrit JAMAIS par-dessus un fichier qu'on n'a pas su relire : ce fichier porte les
    // hooks et les permissions du poste, le perdre coute bien plus cher que de ne pas se mettre a jour.
    console.error(`settings.json illisible (${e.message}). Rien touche. Corriger le JSON puis relancer.`);
    process.exit(1);
  }
}

const marketplaces = settings.extraKnownMarketplaces || (settings.extraKnownMarketplaces = {});
const entry = marketplaces[NAME] || (marketplaces[NAME] = { source: SOURCE });
if (entry.autoUpdate === true) {
  console.log('Deja en place : le marketplace latrace est declare auto-updatable. Rien a faire.');
  process.exit(0);
}
entry.autoUpdate = true;

mkdirSync(dir, { recursive: true });
if (existsSync(file)) copyFileSync(file, `${file}.bak`);
writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');

console.log(`autoUpdate active pour le marketplace ${NAME} dans ${file}`);
if (existsSync(`${file}.bak`)) console.log(`Sauvegarde de l'ancien fichier : ${file}.bak`);
console.log('Le capteur se mettra desormais a jour tout seul a chaque commit du depot.');
