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

// --- Perimetre (allowlist opt-in) ------------------------------------------
// Par defaut le capteur remonte TOUTES les sessions. Un poste qui melange travail d'equipe et
// projets perso sur la meme machine peut restreindre l'envoi a une liste de dossiers via
// `include_projects` dans ~/.latrace-telemetry/config.json :
//
//   "include_projects": ["/Users/moi/Developer/LaTrace"]
//
// Liste de prefixes de CHEMINS REELS. Une session n'est retenue que si son cwd est ce dossier ou un
// sous-dossier. Liste absente ou vide => comportement historique : tout remonte, aucun poste qui ne
// configure rien n'est impacte.

// Encodage Claude Code d'un chemin en nom de dossier ~/.claude/projects/<...> : chaque caractere non
// alphanumerique devient '-'. Verifie sur poste : /Users/bob/Developer/LaTrace ->
// -Users-bob-Developer-LaTrace (le '.' de .claude aussi). Idempotent sur un nom deja encode.
export function encodeProjectDir(p) {
  return String(p).replace(/[^a-zA-Z0-9]/g, '-');
}

// `subject` : soit un cwd reel (hook, SessionEnd), soit un nom de dossier deja encode (uploader,
// rescan). On compare en forme encodee pour n'avoir qu'une seule liste lisible cote config. Le tiret
// final du prefixe evite qu'un dossier "LaTrace" avale un voisin "LaTraceStuff".
// Deux erreurs de saisie faisaient echouer le filtre EN SILENCE, et dans le sens dangereux : plus
// rien ne remontait, sans que personne ne puisse s'en apercevoir.
//   1. `~/Developer/LaTrace` : le tilde n'etait pas resolu, donc ne correspondait a aucun cwd reel.
//   2. La casse : macOS et Windows ont un systeme de fichiers insensible a la casse, donc un chemin
//      correct au caractere pres mais pas a la casse pres est parfaitement legitime la-bas.
// On aligne la comparaison sur le systeme de fichiers : insensible sur darwin/win32, sensible sur
// Linux, ou deux dossiers ne differant que par la casse sont bien deux dossiers differents.
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2));
  return p;
}

function normalizeForCompare(p) {
  const s = encodeProjectDir(expandHome(String(p).trim()).replace(/[/\\]+$/, ''));
  return CASE_INSENSITIVE_FS ? s.toLowerCase() : s;
}

export function projectAllowed(subject, cfg) {
  const inc = cfg && Array.isArray(cfg.include_projects)
    ? cfg.include_projects.filter(s => typeof s === 'string' && s.trim())
    : [];
  if (!inc.length) return true;                       // pas d'allowlist -> on ne filtre rien
  if (typeof subject !== 'string' || !subject) return false;
  const s = normalizeForCompare(subject);
  return inc.some(pref => {
    const pe = normalizeForCompare(pref);
    return pe && (s === pe || s.startsWith(pe + '-'));
  });
}

// Le poste restreint-il son perimetre ? Sert uniquement a marquer la fiche : un poste filtre doit
// etre lisible comme tel, pas confondu avec un poste inactif.
export function scopeActive(cfg) {
  return !!(cfg && Array.isArray(cfg.include_projects)
    && cfg.include_projects.some(s => typeof s === 'string' && s.trim()));
}
