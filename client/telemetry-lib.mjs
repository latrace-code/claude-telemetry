// Bibliothèque d'analyse d'un transcript Claude Code (.jsonl) -> fiche de télémétrie d'itération.
// Partagée par le hook telemetry-session.mjs (temps réel, SessionEnd) et par le backfill (historique).
// 100% déterministe, aucun LLM, aucun accès réseau. La catégorisation fine des frictions
// est faite plus tard par une passe haiku (voir journal-digest / telemetry-digest).
//
// schema 2 : découpe honnête du temps (le champ "autonomous_min" du schema 1 mélangeait attente
// humaine, nuits et sessions oubliées), exclusion des prompts non-humains, et coût par friction.
//
// schema 4 : comptage des SIDECHAINS (agents de subagent et de workflow). Jusqu'ici la fiche ne
// voyait que le transcript de la session mère : la nuit Fooding iOS du 20/07 déclarait 4 agents et
// 1,49 M de tokens alors que le réel était 88 transcripts d'agents et 3,59 M. Tout audit d'un
// chantier orchestré était donc faux d'un facteur ~2,4, dans le sens qui flatte. Voir scanSidechains.

// Marqueurs de friction dans les prompts humains. Proxy assumé : capte ce que Lucas VERBALISE,
// pas les régressions silencieuses. La passe LLM affine ces compteurs bruts.
import { homedir } from 'node:os';

const RE_REGRESSION = /\b(cass[ée]|p[ée]t[ée]s?|remets?\b|remettre|marche plus|marchent plus|marchait|n'?importe quoi|r[ée]gress|à l'envers|dans l'autre sens|revert|annule)\b/i;
// Resserré vs schema 1 : "non"/"encore" nus généraient trop de faux positifs.
// Élargi le 2026-07-16 : les regex ne captaient que l'agacement EXPLICITE, or Lucas corrige
// calmement et factuellement. Les 4 vraies frictions du 16/07 étaient toutes invisibles.
// Les 4 motifs ajoutés (2e ligne) sont calibrés sur un corpus de 686 prompts humains réels
// (8 jours) : ensemble ils captent 11 frictions neuves, dont les 4 cibles, sans exploser le bruit.
// Motifs testés puis ÉCARTÉS car ~1 vrai sur 6 (ils matchent le "ne... pas" français ordinaire,
// où "touche pas au checkout" est une consigne et pas une friction) : /(ajoute|mets|touche) pas/,
// /on (n')?a pas/, /pourquoi (le|la|les)/. Ne pas les réintroduire sans re-mesurer sur corpus.
const RE_CORRECTION = /(^|[.!?] )(non|nan)\b|\bnon[,!]|pas [çc]a\b|pas comme (ça|ca|prévu)|c'?est pas (ça|ca|bon|clair|ce|vrai)|mal compris|pourquoi tu\b|\bwtf\b|arr[êe]te\b|je t'?ai (dit|demand)|(3|trois) fois\b|toujours pas\b|encore une fois\b|encore (le|la|les) m[êe]me/i;
// Friction constatée sans hausser le ton : échec relevé ("tu ne les as pas détecté", typos incluses),
// doute de vérification ("t'es sûr qu'on a branché..."), avertissement ("Attention, ça existe déjà"),
// ressenti ("c'est relou"). "désolé" volontairement exclu : trop courant et poli pour discriminer.
const RE_CORRECTION_CALME = /\btu (ne |n')?\w{0,4} ?as pas \w+[ée]s?\b|\bt'?as pas \w+[ée]s?\b|\b(t'?es|tu es|es-tu)\s+s[uû]re?\b|^attention\b|\battention[,!]|\b(relou|chiant|p[ée]nible)\b/i;
// Resserré vs schema 1 : "super" et "good" nus matchaient "super important", "good enough"...
const RE_VALIDATION = /\b(parfait|bravo|nickel|impec|excellent|g[ée]nial)\b|c'?est (bon|good|top|parfait|nickel)\b|\btop\b(?! (priorit|niveau))|\bmerci\b/i;

// Prompts présents dans le rôle "user" mais qui ne sont PAS Lucas qui parle : résumé de compaction,
// agent headless (brain-loop), prompt de skill injecté par le harness, slash command. Les compter en
// friction gonflait les chiffres (ex. le mineur nocturne comptait 1 friction par nuit).
// Inclut nos propres prompts headless (journal-digest, telemetry-digest, brain-loop) : le hook les
// filtre via LATRACE_JOURNAL_HEADLESS, mais le backfill relit les transcripts sans cette variable.
const RE_NOT_HUMAN = [
  /^this session is being continued from a previous conversation/i,
  /^caveat: the messages below were generated/i,
  /^tu es (le mineur nocturne|l'agent de synthèse|un agent)/i,
  /^approach this as the/i,
  /^voici le journal brut de la journée/i,
  /^tu analyses les frictions émises/i,
  /^tu analyses des messages écrits par lucas/i, // prompt du juge de friction (judge.mjs)
  // Variante avec un compte en tete ("Tu analyses 135 frictions entre Lucas et son IA..."), emise
  // par autonomous-friction. Sans elle, ces sessions passaient pour du travail humain et venaient
  // polluer le cockpit d'equipe : 6 lignes vues en prod le 22/07. Motif volontairement etroit.
  /^tu analyses \d+ frictions? entre lucas/i,
  /^tu classes des messages de friction/i,       // prompt de categorize.mjs
  /^<command-(name|message|args)>/i,
  /^\[Image #\d+\]$/i,
  // Injection du harnais quand un OUTIL lit une image (screenshot device, capture Playwright) :
  // "[Image: original 1206x2622, displayed at 920x2000...]". Ce n'est pas Lucas qui parle, c'est la
  // boucle qui regarde ce qu'elle fait. Mesuré sur 2 840 prompts : 104 occurrences (3,7 %) au global,
  // mais 21 sur 34 (62 %) pour la nuit Fooding iOS. Le biais est donc concentré sur les sessions
  // autonomes et visuelles, et il va dans le pire sens possible : le compteur « relances humaines »
  // MONTE quand Lucas intervient MOINS. Vérifié : 0 cas où cette injection porte du texte humain
  // (une image collée par Lucas prend l'autre forme, "[Image #1]" suivie de son message).
  /^\[Image: original \d+x\d+/i,
  // Même injection, seconde forme : "[Image: source: /home/.../image-cache/<sid>/1.png]". Elle suit
  // chaque capture que Lucas joint à un message, donc elle DOUBLE ses prompts illustrés au lieu de
  // les gonfler au hasard. Mesuré sur 2 813 prompts : 186 occurrences (6,6 %), et vérifié une par
  // une, 0 cas où du texte suit le crochet fermant. Filtrage total sans risque de faux négatif.
  /^\[Image: source:/i,
  // Corps du skill invoqué, injecté par le Skill tool : "Base directory for this skill: <path> …"
  // suivi du SKILL.md entier. 54 occurrences sur le corpus. Attention, ce n'est pas jetable en bloc :
  // 15 d'entre elles se terminent par "ARGUMENTS: <ce que Lucas a tapé>", qui est du vrai texte
  // humain. Ce motif ne prend donc QUE les 39 sans arguments ; les autres sont réduites à leurs
  // arguments par stripSkillBody() avant d'arriver ici.
  /^Base directory for this skill:(?![\s\S]*\bARGUMENTS:\s*\S)/i,
];

// Détecteur regex, isolé pour être mesurable sur judge-golden.json (scripts/session-audit).
// Historique : ce détecteur a été élargi puis resserré deux fois à l'aveugle, chaque passe créant
// le biais inverse. Ne plus le toucher sans rejouer `node judge-bench.mjs`.
export function detectFrictionRegex(t) {
  const regression = RE_REGRESSION.test(t);
  const correction = RE_CORRECTION.test(t) || RE_CORRECTION_CALME.test(t);
  return { regression, correction, validation: RE_VALIDATION.test(t), friction: regression || correction };
}

const ACTIVE_GAP_MS = 5 * 60 * 1000;    // au-delà, plus personne ne produit : c'est de l'attente
const DORMANT_GAP_MS = 90 * 60 * 1000;  // au-delà, ce n'est plus de l'attente : session oubliée / nuit

function parseTs(s) {
  if (typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// NFC obligatoire : les transcripts contiennent des accents décomposés (NFD, "é" = e + U+0301).
// Sans ça, toutes les regex accentuées ci-dessus (cassé, arrête, à l'envers, journée...) ratent en silence.
function normalize(s) { return String(s).normalize('NFC').replace(/\s+/g, ' ').trim(); }

// Extrait le texte d'un message user s'il s'agit d'un vrai prompt humain (ni tool_result ni injection).
function humanPromptText(m) {
  const c = m && m.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (b && b.type === 'tool_result') return null;
      if (b && b.type === 'text' && typeof b.text === 'string') { text = b.text; break; }
    }
  }
  if (!text) return null;
  const t = normalize(text);
  if (!t || t.startsWith('<')) return null; // system-reminder / injection
  return t;
}

function isNotHuman(t) { return RE_NOT_HUMAN.some(re => re.test(t)); }

// Le hook SessionStart préfixe le 1er prompt avec le healthcheck du cerveau + la reprise de contexte
// (résumés du journal). Ce préambule n'est pas Lucas : il déclenchait les regex de friction sur des
// mots venus des résumés, et surtout il occupait les 240 caractères stockés, si bien que la passe
// haiku recevait "SANTE DU CERVEAU..." à la place du vrai message. On ne garde que ce qui suit.
const RE_HOOK_TAIL = /Pour un sujet pr[ée]cis, chercher dans ~\/brain\/journal et les memory\/\.\s*/;
function stripHookPreamble(t) {
  const m = RE_HOOK_TAIL.exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : t;
}

// Quand Lucas invoque un skill avec des arguments, le Skill tool injecte le SKILL.md entier et colle
// ses arguments à la fin. Le seul texte humain là-dedans est la ligne ARGUMENTS : le reste est un
// fichier du repo, qui déclenchait les regex de friction sur ses propres mots et occupait les 240
// caractères de `subject`. Sans arguments, RE_NOT_HUMAN s'en charge et le prompt part en bot_prompts.
function stripSkillBody(t) {
  if (!/^Base directory for this skill:/i.test(t)) return t;
  const m = /\bARGUMENTS:\s*([\s\S]*)$/.exec(t);
  const args = m ? m[1].trim() : '';
  return args || t;
}

// --- Traçage du brain -------------------------------------------------------
// Question à laquelle ces champs répondent : la session est-elle allée chercher dans la mémoire, et
// quoi. C'est le seul contrôle possible du principe mesuré dans `brain-bench-restitution` (la
// restitution marche par fouille, 93 %, pas par rappel passif, 7 %) : sans ça on suppose, on ne sait
// pas.
//
// LIMITE STRUCTURELLE, à garder en tête avant de lire une fiche comme exhaustive : seuls les accès
// EXPLICITES sont traçables. Le rappel automatique (MEMORY.md injecté au démarrage, notes soufflées
// en contexte) ne laisse aucune trace dans le .jsonl — vérifié, 0 occurrence de `system-reminder`
// dans un transcript complet. On mesure ce que la machine est allée chercher, pas ce qu'on lui a
// servi d'office.
// Seule divergence avec la version de ~/.claude/hooks : le home est resolu a l'execution au lieu
// d'etre en dur. Sur un poste sans ~/brain ces champs restent nuls, le reste de la fiche est identique.
const HOME_DIR = homedir();
const ESC_HOME = HOME_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE_BRAIN_PATH = new RegExp(`(?:~|${ESC_HOME})/(?:brain/[^\\s"';|)&>]+|\\.claude/projects/[^\\s/]+/memory/[^\\s"';|)&>]+)`, 'g');
const shortBrain = p => p.replace(HOME_DIR, '~').replace(/\/\.claude\/projects\/[^/]+\/memory\//, '/memory/').replace(/\/+$/, '');
const isBrainPath = p => /(^|\/)(brain\/|memory\/[^/]+\.md$)/.test(p.replace(HOME_DIR, '~'));

function newBrainAcc() { return { searches: [], reads: new Set(), writes: new Set(), shell: new Set() }; }

// Le shell a sa propre liste : `cat note.md` et un python qui réécrit le fichier passent par le même
// outil, et deviner lequel à la regex donnerait un `reads` qui ment. Sens indéterminé, dit comme tel.
function collectBrainAccess(name, input, acc) {
  if (!input || typeof input !== 'object') return;
  const p = input.file_path || input.path || input.notebook_path;
  if (typeof p === 'string' && isBrainPath(p)) {
    if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') acc.writes.add(shortBrain(p));
    else acc.reads.add(shortBrain(p));
  }
  const cmd = typeof input.command === 'string' ? input.command : '';
  if (!cmd) return;
  const s = /brain-search\.mjs\s+([^|&>\n]+)/.exec(cmd);
  // `\s+[12]$` : reste du descripteur d'une redirection `2>&1`, coupée juste avant par la classe.
  if (s && acc.searches.length < 20) acc.searches.push(s[1].trim().replace(/\s+[12]$/, '').slice(0, 80));
  for (const hit of cmd.match(RE_BRAIN_PATH) || []) acc.shell.add(shortBrain(hit));
}

function finishBrain(acc) {
  const cap = set => [...set].sort().slice(0, 40);
  const total = acc.searches.length + acc.reads.size + acc.writes.size + acc.shell.size;
  if (!total) return null;
  return { searches: acc.searches, reads: cap(acc.reads), writes: cap(acc.writes), shell: cap(acc.shell) };
}

function mergeBrain(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const uniq = (x, y) => [...new Set([...(x || []), ...(y || [])])].sort().slice(0, 60);
  return {
    searches: [...(a.searches || []), ...(b.searches || [])].slice(0, 30),
    reads: uniq(a.reads, b.reads),
    writes: uniq(a.writes, b.writes),
    shell: uniq(a.shell, b.shell),
  };
}

// events: tableau d'objets JSONL déjà parsés. Retourne la fiche de télémétrie (objet sérialisable).
//
// `detector` : fonction (texte) -> { friction, regression, correction, validation }.
// Par défaut AUCUN détecteur -> la fiche sort avec `judged:false` et `signals.friction:null`.
// C'est voulu : null = "pas encore jugé", 0 = "jugé, rien trouvé". Les confondre est exactement la
// panne du 16/07, où "je n'ai pas pu parler" et "rien à dire" rendaient le même signal.
// Le hook SessionEnd n'en passe pas (il doit rester déterministe, offline et rapide) ; la passe
// judge-fiches.mjs en passe un qui lit le cache du juge LLM. Le calcul du coût par friction
// (turns/min imputés jusqu'au prompt humain suivant) est ainsi partagé par les deux.
export function analyzeTranscript(events, meta = {}, detector = null) {
  let start = null, end = null, branch = meta.branch || null;
  let assistantTurns = 0, userPrompts = 0, botPrompts = 0;
  let inTok = 0, outTok = 0, cacheR = 0;
  const tools = {};
  let toolErrors = 0, subagents = 0;
  const sig = detector
    ? { friction: 0, regression: 0, correction: 0, validation: 0, interrupt: 0 }
    : { friction: null, regression: null, correction: null, validation: null, interrupt: 0 };
  const frictionPrompts = [];
  let subject = null, fallbackSubject = null;
  let prevTs = null;

  // Découpe du temps : produce = quelqu'un travaille, wait = attente courte, dormant = session laissée ouverte.
  let produceMs = 0, waitMs = 0, dormantMs = 0, nWaits = 0, nDormant = 0;

  // Friction ouverte : on lui impute les tours et le temps jusqu'au prochain prompt humain.
  let openFriction = null;

  const brainAcc = newBrainAcc();
  // Surface qui a produit la session (`cli`, `sdk-cli` pour un agent headless, et les valeurs
  // propres aux autres clients). Sans ce champ on ne peut que supposer qui travaille dans quoi,
  // alors que l'equipe est repartie entre CLI et application.
  let entrypoint = null;

  for (const e of events) {
    if (!entrypoint && e && typeof e.entrypoint === 'string') entrypoint = e.entrypoint.slice(0, 40);
    const ts = parseTs(e && e.timestamp);
    if (ts !== null) {
      if (start === null || ts < start) start = ts;
      if (end === null || ts > end) end = ts;
      // Un transcript n'est PAS toujours chronologique : une reprise de conversation, un fork ou une
      // compaction réinjectent des messages plus anciens. Le gap devient négatif et, comme il passait
      // le test `d < ACTIVE_GAP_MS`, il était SOUSTRAIT du temps actif. Mesuré sur une session réelle :
      // 6 sauts en arrière sur 933 events (0,6 % des transitions) suffisaient à retirer 71 heures et à
      // afficher -4 201 min pour 83 min de travail réel. On ignore donc les reculs, et prevTs ne
      // redescend jamais : sinon le gap suivant, artificiellement énorme, partirait en "dormant".
      if (prevTs !== null && ts >= prevTs) {
        const d = ts - prevTs;
        if (d < ACTIVE_GAP_MS) {
          produceMs += d;
          if (openFriction) openFriction.ms += d;
        } else if (d < DORMANT_GAP_MS) { waitMs += d; nWaits++; }
        else { dormantMs += d; nDormant++; }
      }
      if (prevTs === null || ts > prevTs) prevTs = ts;
    }
    if (e && typeof e.gitBranch === 'string' && e.gitBranch) branch = e.gitBranch;
    const m = e && e.message;
    if (!m) continue;

    if (m.role === 'assistant') {
      assistantTurns++;
      if (openFriction) openFriction.turns++;
      const u = m.usage || {};
      inTok += u.input_tokens || 0;
      outTok += u.output_tokens || 0;
      cacheR += u.cache_read_input_tokens || 0;
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_use') {
            tools[b.name] = (tools[b.name] || 0) + 1;
            if (b.name === 'Task' || b.name === 'Agent') subagents++;
            collectBrainAccess(b.name, b.input, brainAcc);
          }
        }
      }
    } else if (m.role === 'user') {
      // erreurs d'outils
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && b.type === 'tool_result' && b.is_error) toolErrors++;
        }
      }
      const t = stripSkillBody(stripHookPreamble(humanPromptText(m) || ''));
      if (t) {
        if (/\[Request interrupted by user/i.test(t)) { sig.interrupt++; continue; }
        if (isNotHuman(t)) {
          botPrompts++;
          if (!fallbackSubject) fallbackSubject = t.slice(0, 90);
          continue;
        }
        openFriction = null; // le prompt précédent est considéré comme traité
        userPrompts++;
        if (!subject) subject = t.slice(0, 90);
        if (detector) {
          const det = detector(t) || {};
          if (det.regression) sig.regression++;
          if (det.correction) sig.correction++;
          if (det.validation) sig.validation++;
          if (det.friction) {
            sig.friction++;
            if (frictionPrompts.length < 40) {
              openFriction = { text: t.slice(0, 240), turns: 0, ms: 0, famille: det.famille || null };
              frictionPrompts.push(openFriction);
            }
          }
        }
      }
    }
  }

  const wallMin = start && end && end > start ? Math.round((end - start) / 60000) : 0;
  const toMin = ms => Math.round(ms / 60000);
  const toolsTotal = Object.values(tools).reduce((a, b) => a + b, 0);

  return {
    sid: meta.sid || null,
    project: meta.project || null,
    branch,
    date: start ? new Date(start).toISOString().slice(0, 10) : (meta.date || null),
    ts_start: start ? new Date(start).toISOString() : null,
    ts_end: end ? new Date(end).toISOString() : null,
    wall_min: wallMin,
    // Temps où quelque chose est réellement produit (IA qui enchaîne, Lucas qui écrit).
    active_min: toMin(produceMs),
    // Attente courte : l'IA a rendu la main, Lucas review / est parti boire un café.
    wait_min: toMin(waitMs),
    n_waits: nWaits,
    // Session laissée ouverte (nuit, week-end, terminal oublié). N'est PAS du travail : à exclure des ratios.
    dormant_min: toMin(dormantMs),
    n_dormant: nDormant,
    user_prompts: userPrompts,
    bot_prompts: botPrompts,
    automated: userPrompts === 0 && botPrompts > 0,
    assistant_turns: assistantTurns,
    tools_total: toolsTotal,
    tool_errors: toolErrors,
    err_rate_pct: toolsTotal ? Math.round((1000 * toolErrors) / toolsTotal) / 10 : 0,
    subagents,
    tokens_out: outTok,
    tokens_in: inTok,
    cache_read: cacheR,
    tools_by_name: tools,
    // Agents et workflows lancés par cette session (null si aucun, ou si l'appelant n'a pas scanné).
    // Les champs *_all ajoutent le travail des agents à celui de la mère : ce sont EUX qu'il faut
    // sommer pour juger un chantier orchestré. Les champs historiques (subagents, tokens_out,
    // tools_total) gardent leur définition « session mère seule » pour rester comparables aux
    // fiches d'avant le schema 4.
    sidechains: meta.sidechains || null,
    // Accès explicites au brain. `brain` = session mère seule, `brain_all` = mère + agents, même
    // convention que tools_total / tools_total_all. null quand la session n'a rien ouvert du tout,
    // ce qui est en soi le résultat intéressant.
    brain: finishBrain(brainAcc),
    brain_all: mergeBrain(finishBrain(brainAcc), (meta.sidechains && meta.sidechains.brain) || null),
    agents_total: meta.sidechains ? Math.max(subagents, meta.sidechains.agents) : subagents,
    tokens_out_all: outTok + ((meta.sidechains && meta.sidechains.tokens_out) || 0),
    tools_total_all: toolsTotal + ((meta.sidechains && meta.sidechains.tools_total) || 0),
    tool_errors_all: toolErrors + ((meta.sidechains && meta.sidechains.tool_errors) || 0),
    signals: sig,
    // [{text, turns, min, famille}] : coût de résolution imputé à chaque friction (jusqu'au prompt humain suivant).
    friction_prompts: frictionPrompts.map(f => ({ text: f.text, turns: f.turns, min: toMin(f.ms), famille: f.famille })),
    subject: subject || fallbackSubject,
    entrypoint,
    // false = les signaux de friction sont à null, en attente de judge-fiches.mjs. Un consommateur
    // qui lit signals.friction sans regarder `judged` lira null et doit le traiter comme "inconnu",
    // jamais comme zéro.
    judged: !!detector,
    schema: 4,
  };
}

// ---------------------------------------------------------------------------
// Sidechains : les agents ne vivent pas dans le transcript de la session mère.
//
// Un `Agent` direct écrit <sessionDir>/subagents/agent-<id>.jsonl ; un `Workflow` écrit son journal
// dans <sessionDir>/workflows/wf_<id>.json et les transcripts de SES agents dans
// <sessionDir>/subagents/workflows/wf_<id>/agent-*.jsonl. Le compteur `subagents` de la fiche ne
// voit que les tool_use de la mère : il rend 4 là où 88 agents ont tourné.
//
// Coût mesuré : 5,1 s pour 336 Mo de transcripts d'agents (la nuit Fooding iOS). Trop pour un hook
// SessionEnd, d'où le budget de temps : le hook prend ce qu'il peut et pose `partial:true`, les
// passes hors ligne (backfill, judge-fiches) rescannent sans budget et corrigent la fiche.
// Chemins concaténés en POSIX : ces transcripts n'existent que sur Linux/macOS.

function listJsonlFiles(fs, dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) listJsonlFiles(fs, p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Un verdict de gate de workflow, quand le script en pose un. Best-effort assumé : la forme du
// `result` appartient au script de workflow, pas au harnais. Sert de matière au futur détecteur de
// non-progrès (en régime autonome il n'y a aucun prompt humain, donc aucune friction verbalisée :
// le signal doit venir de l'exécution — un verdict qui ne bouge pas de round en round).
function pickGate(result) {
  if (!result || typeof result !== 'object') return {};
  const gate = result.finalGate || result.gate || result;
  const rounds = Number.isFinite(result.rounds) ? result.rounds : null;
  const verdict = typeof gate.verdict === 'string' ? gate.verdict.slice(0, 40) : null;
  return { rounds, verdict };
}

// sessionDir = chemin du transcript sans l'extension .jsonl.
// Retourne null si la session n'a aucun sidechain (cas majoritaire, coût nul).
export function scanSidechains(fs, sessionDir, opts = {}) {
  const budgetMs = opts.budgetMs ?? Infinity;
  const t0 = Date.now();
  if (!sessionDir) return null;

  const workflows = [];
  let wfFiles = [];
  try { wfFiles = fs.readdirSync(sessionDir + '/workflows').filter(f => f.endsWith('.json')).sort(); } catch { /* aucun workflow */ }
  for (const f of wfFiles) {
    let j;
    try { j = JSON.parse(fs.readFileSync(sessionDir + '/workflows/' + f, 'utf8')); } catch { continue; }
    const { rounds, verdict } = pickGate(j.result);
    workflows.push({
      run: j.runId || f.replace(/\.json$/, ''),
      name: j.workflowName || null,
      agents: j.agentCount || 0,
      min: Math.round((j.durationMs || 0) / 60000),
      status: j.status || null,
      rounds,
      verdict,
    });
  }

  const files = listJsonlFiles(fs, sessionDir + '/subagents').sort();
  if (!files.length && !workflows.length) return null;

  let turns = 0, tokensOut = 0, toolsTotal = 0, toolErrors = 0, scanned = 0;
  const brainAcc = newBrainAcc();
  for (const path of files) {
    if (Date.now() - t0 > budgetMs) break;
    let raw;
    try { raw = fs.readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch { continue; }
      const m = e && e.message;
      if (!m) continue;
      if (m.role === 'assistant') {
        turns++;
        tokensOut += (m.usage && m.usage.output_tokens) || 0;
        if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') {
          toolsTotal++;
          collectBrainAccess(b.name, b.input, brainAcc);
        }
      } else if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.type === 'tool_result' && b.is_error) toolErrors++;
      }
    }
    scanned++;
  }

  return {
    agents: files.length,          // transcripts d'agents trouvés : agents directs ET agents de workflow
    agents_scanned: scanned,
    partial: scanned < files.length,
    workflows,
    workflow_min: workflows.reduce((a, w) => a + w.min, 0),
    turns,
    tokens_out: tokensOut,
    tools_total: toolsTotal,
    tool_errors: toolErrors,
    // Ce que les agents sont allés lire dans le brain, seuls. Souvent différent de la mère : sur la
    // session LCRCA du 21/07, six notes memory n'ont été ouvertes que par eux.
    brain: finishBrain(brainAcc),
    scan_ms: Date.now() - t0,
  };
}

// TOUS les prompts humains d'un transcript, sans jugement ni pré-filtre.
// Existe pour le capteur v3 (judge.mjs) : un pré-filtre regex en amont du juge plafonnerait le
// rappel de tout le pipeline (c'est le bug de categorize.mjs, qui ne voit que les prompts déjà
// matchés). Reste déterministe et sans réseau : le juge est une passe séparée.
export function extractHumanPrompts(events) {
  const out = [];
  for (const e of events) {
    const m = e && e.message;
    if (!m || m.role !== 'user') continue;
    const t = stripSkillBody(stripHookPreamble(humanPromptText(m) || ''));
    if (!t) continue;
    if (/\[Request interrupted by user/i.test(t)) continue;
    if (isNotHuman(t)) continue;
    out.push({ ts: e.timestamp || null, text: t });
  }
  return out;
}

export function readEvents(readFileSync, path) {
  const events = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch { /* ligne corrompue ignorée */ }
  }
  return events;
}
