// Emplacements et configuration du capteur. Tout vit sous ~/.latrace-telemetry : c'est la seule
// empreinte laissee sur le poste, et elle est supprimable sans rien casser.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
export const STATE_DIR = join(HOME, '.latrace-telemetry');
export const QUEUE_DIR = join(STATE_DIR, 'queue');
export const SENT_FILE = join(STATE_DIR, 'sent.json');
export const LOCK_FILE = join(STATE_DIR, 'uploader.lock');
export const PROJECTS_DIR = join(HOME, '.claude', 'projects');

const HERE = dirname(fileURLToPath(import.meta.url));

// Deux sources, dans cet ordre : le config.json livre par le plugin (endpoint + token, mis a jour
// par le sync git), puis un override local optionnel dans ~/.latrace-telemetry/config.json qui
// permet de couper le capteur ou de corriger l'identite sans toucher au plugin.
export function loadConfig() {
  const read = p => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; } catch { return {}; } };
  return { ...read(join(HERE, 'config.json')), ...read(join(STATE_DIR, 'config.json')) };
}
