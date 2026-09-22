// Ingestion de la telemetrie d'iteration IA (Cloud Run, scale a zero).
//
// Deux surfaces, volontairement asymetriques :
//   - ingestion (POST /v1/*)  : token Bearer partage par les postes.
//   - cockpit  (GET /v1/cockpit) : Basic auth, et il ne lit QUE les fiches.
// Les TRANSCRIPTS ne sont servis par aucune route. Ils contiennent le contenu des fichiers ouverts
// et la sortie des commandes executees, donc potentiellement des credentials : leur seule voie de
// lecture est IAM sur le bucket, jamais HTTP.

import { createServer } from 'node:http';
import { Storage } from '@google-cloud/storage';
import { renderCockpit } from './cockpit.mjs';

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;
const TOKEN = process.env.INGEST_TOKEN;
const COCKPIT_USER = process.env.COCKPIT_USER || 'latrace';
const COCKPIT_PASS = process.env.COCKPIT_PASS;
const COCKPIT_CACHE_MS = 60 * 1000;

// Le poste envoie son nom d'utilisateur systeme, qui n'est pas toujours le prenom de la personne
// (`waroth` = Lucas). La table vit ici et pas sur les postes : corriger une identite ne doit pas
// demander de toucher a la machine de quelqu'un.
const USER_ALIASES = (() => {
  try { return JSON.parse(process.env.USER_ALIASES || '{}'); } catch { return {}; }
})();
const normUser = u => USER_ALIASES[u] || u;
const SIGN_TTL_MS = 15 * 60 * 1000;
const MAX_FILES = 500;
const MAX_BODY = 4 * 1024 * 1024;

const storage = new Storage();

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function ok(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function fail(res, code, msg) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

function authed(req) {
  const h = req.headers.authorization || '';
  return TOKEN && h === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// Un nom de fichier vient d'un poste client : il ne decide jamais d'un chemin dans le bucket.
// Seules deux formes sont acceptees, "<nom>" et "<subagents|workflows>/<nom>".
function safeRelPath(name) {
  if (typeof name !== 'string' || name.length > 200) return null;
  const parts = name.split('/');
  if (parts.length === 1) return SAFE_SEGMENT.test(parts[0]) ? parts[0] : null;
  if (parts.length === 2 && (parts[0] === 'subagents' || parts[0] === 'workflows')) {
    return SAFE_SEGMENT.test(parts[1]) ? `${parts[0]}/${parts[1]}` : null;
  }
  return null;
}

function safeId(v) { return typeof v === 'string' && SAFE_SEGMENT.test(v) && v.length <= 100 ? v : null; }

// Ce que le poste a declare partager voyage avec sa fiche : le serveur n'a aucun autre moyen de le
// savoir. Une fiche sans `shares` vient d'un client anterieur au reglage, donc aucun opt-in n'a ete
// exprime -- pas de texte. Deux chemins ecrivent du verbatim sur une fiche stockee, le verdict du
// juge et le REPORT de ce verdict sur une reemission : ils posent tous les deux la meme question,
// donc ils la posent au meme endroit.
const sharesPromptText = card => !!(card && card.shares && card.shares.prompt_text);

// Ecriture conditionnelle d'une fiche.
//
// Les deux routes qui ecrivent relisent d'abord ce qui est stocke -- report de verdict pour l'une,
// verdict a poser pour l'autre -- et ecrivent ENSUITE. Sans condition, le dernier arrive gagne, et
// il gagne avec ce qu'il a lu AVANT. Les deux sens abiment :
//
//   - le juge qui finit en dernier repose la fiche telle qu'il l'avait telechargee, et RESSUSCITE le
//     verbatim que le poste venait de retirer -- dans l'objet a retention illimitee ;
//   - le poste qui finit en dernier efface le verdict que le juge vient de poser, ce qui a deja
//     coute 84 verdicts en une passe.
//
// La fenetre est celle d'un aller-retour GCS, et un poste qui reprend une conversation pendant que
// la machine d'audit juge la meme session n'a rien d'exotique : les deux routes sont appelees par
// des machines differentes, rien ne les serialise.
//
// On epingle donc la generation lue et on n'ecrit que si l'objet n'a pas bouge ; sinon on recommence
// sur la version fraiche. `apply` est rappele a chaque tentative avec ce qui est REELLEMENT stocke :
// il doit etre une fonction de la fiche lue et de rien d'autre, et rend la fiche a ecrire ou null
// pour renoncer.
const RMW_TRIES = 5;

async function updateCard(name, apply) {
  const bucket = storage.bucket(BUCKET);
  for (let i = 0; i < RMW_TRIES; i++) {
    let prev = null;
    let generation = 0;   // 0 : precondition GCS "l'objet n'existe pas encore"
    try {
      const [meta] = await bucket.file(name).getMetadata();
      generation = meta.generation;
      // Lecture EPINGLEE sur cette generation : sans ca l'objet pourrait changer entre le getMetadata
      // et le download, et on ecrirait sous une condition qui ne decrit pas ce qu'on a lu.
      const [buf] = await bucket.file(name, { generation }).download();
      prev = JSON.parse(buf.toString('utf8'));
    } catch { prev = null; }   // pas encore deposee, ou illisible : on ecrit par-dessus
    const next = await apply(prev);
    if (!next) return null;
    try {
      await bucket.file(name).save(JSON.stringify(next, null, 1), {
        contentType: 'application/json',
        resumable: false,
        preconditionOpts: { ifGenerationMatch: generation },
      });
      return next;
    } catch (e) {
      // 412 : quelqu'un a ecrit entre notre lecture et notre ecriture. On relit et on recommence.
      if (!e || (e.code !== 412 && e.status !== 412)) throw e;
    }
  }
  throw new Error(`card update: ${RMW_TRIES} conflits d'affilee sur ${name}`);
}

// Une fiche est REEMISE a chaque reprise de conversation, et en masse par un recompute. Le verdict
// du juge, lui, ne vit QUE dans le bucket : le poste ne l'a jamais eu, il repose donc une fiche
// sans jugement. Sans ce report, chaque reemission effacait le verdict deja pose -- 84 verdicts et
// 190 frictions perdus en une seule passe le 27/07, reposes a la main.
// Regle : la fiche entrante gagne sur TOUT, sauf sur les champs que seul le juge produit, et
// seulement si elle n'apporte pas de jugement qui vaille mieux. Un jugement pose en local AVANT
// l'envoi gagne (poste de Lucas) ; le repli regex de `judgeLocally`, non -- un verdict haiku deja
// stocke lui est superieur, et se laisser ecraser par lui serait perdre un verdict.
function carryOverVerdict(prev, card) {
  // Une fiche qui apporte son propre jugement gagne -- SAUF si ce jugement est le repli regex du
  // poste, car le bucket peut porter un verdict haiku qui vaut mieux. Le cas est etroit mais reel :
  // un envoi partiel (fiche et transcript mere passes, un fichier d'agent en echec) laisse l'item en
  // file ; le juge tourne entre-temps sur le transcript stocke ; le poste coupe `transcripts` ; la
  // tentative suivante rejuge a la regex et ecraserait le verdict haiku par le moins bon des deux.
  // C'est la perte de verdict du 27/07 par l'autre porte : celle que la fiche entrante ouvre en
  // gagnant sur tout.
  const localFallback = card.judged === true && card.judged_by === 'regex-local';
  if (card.judged && !localFallback) return;
  if (!prev || !prev.judged) return;   // premiere ecriture de cette fiche : rien a reporter

  // Le repli ne cede qu'a un verdict haiku, et seulement sur la MEME matiere.
  //
  // Une reprise de conversation reemet la fiche sur un transcript plus long. Le verdict stocke ne
  // couvre alors que le debut, et comme le poste ne partage plus son transcript, personne ne le
  // rafraichira jamais : les frictions du travail repris seraient perdues sans retour. Le repli, lui,
  // vient d'etre calcule sur la totalite. `ts_end` dit jusqu'ou va chaque fiche -- une simple
  // retransmission (l'item est reste en file, sa fiche n'a pas bouge) le laisse identique, une
  // reprise le fait avancer. A defaut de date, on garde le verdict haiku : c'est le sens qui protege.
  //
  // Deux replis face a face, c'est le plus frais qui vaut.
  //
  // Ce qui est stocke est presume venir du juge SAUF s'il se declare lui-meme repli : avant
  // `judged_by`, tout verdict pose dans le bucket venait de la machine d'audit, et ces fiches-la
  // n'ont donc pas de provenance. Lire "pas de provenance" comme "pas haiku" les ferait ecraser par
  // une regex -- c'est-a-dire perdre en priorite les verdicts les plus anciens.
  const prevIsFallback = prev.judged_by === 'regex-local';
  const advanced = String(card.ts_end || '') > String(prev.ts_end || '');
  if (localFallback && (prevIsFallback || advanced)) return;

  // Un verdict de regex locale ne vaut que tant qu'AUCUN transcript n'est a portee du juge : c'est le
  // repli d'un poste qui ne partage pas sa matiere, pas un resultat qui se defend contre haiku. Deux
  // cas ou la matiere est la : la fiche entrante partage son transcript (il monte dans la foulee,
  // sendOne enchaine sur /v1/sessions), ou elle vient d'un rejeu, qui ne rejoue QUE des sessions dont
  // le transcript est deja stocke. Le reporter dans ces cas-la annulerait le retrait que le poste
  // vient de faire au drain, et le transcript televerse ne serait jamais relu : la passe haiku filtre
  // sur `judged`. C'est le meme aller-retour que cote client, une couche plus bas.
  // Une provenance inconnue, elle, est un verdict d'ailleurs : il se reporte.
  const hasMaterial = (card.shares && card.shares.transcripts === true) || card.recomputed === true;
  if (prevIsFallback && hasMaterial) return;

  const ps = prev.signals || {};
  card.signals = {
    ...(card.signals || {}),
    friction: ps.friction ?? null,
    correction: ps.correction ?? null,
    regression: ps.regression ?? null,
  };
  // Le verdict reporte a ete pose quand le poste partageait encore son verbatim ; la fiche qui
  // arrive dit qu'il ne le partage plus. On reporte les MESURES du juge, pas ses phrases : sinon une
  // simple reprise de conversation reinjecterait le texte que le poste vient de retirer, et l'opt-out
  // serait annule par le chemin qui existe justement pour ne rien perdre.
  const prevPrompts = Array.isArray(prev.friction_prompts) ? prev.friction_prompts : [];
  card.friction_prompts = sharesPromptText(card)
    ? prevPrompts
    : prevPrompts.map(f => { const { text, ...rest } = f || {}; return rest; });
  card.judged = true;
  // `judged_by` fait partie du verdict au meme titre que ses mesures : une regex locale et un verdict
  // haiku n'ont pas la meme valeur, et reporter les chiffres sans dire d'ou ils viennent rendrait la
  // distinction inexploitable des la premiere reprise de conversation. Absent chez `prev` : fiche
  // jugee avant l'introduction du champ, on ne l'invente pas -- et on RETIRE l'etiquette de la fiche
  // entrante, sinon un verdict d'audit repris ressortirait signe `regex-local` : la mesure dirait une
  // chose et la provenance une autre, ce que ce champ existe justement pour empecher.
  if (prev.judged_by) card.judged_by = prev.judged_by;
  else delete card.judged_by;
  card.judged_at = prev.judged_at || null;
}

async function handleSession(req, res) {
  const body = await readBody(req);
  const card = body && body.card;
  if (!card || typeof card !== 'object') return fail(res, 400, 'missing card');
  const user = normUser(safeId(card.user) || 'unknown');
  card.user = user;
  const sid = safeId(card.sid);
  const date = SAFE_DATE.test(card.date || '') ? card.date : new Date().toISOString().slice(0, 10);
  if (!sid) return fail(res, 400, 'invalid sid');

  card.received_at = new Date().toISOString();
  // La fiche entrante est reconstruite a CHAQUE tentative : `carryOverVerdict` la modifie, et la
  // rejouer sur la fiche deja modifiee reporterait le verdict de la lecture precedente, pas de
  // celle qui vient d'etre relue.
  await updateCard(`cards/${user}/${date}_${sid}.json`, prev => {
    const next = { ...card };
    carryOverVerdict(prev, next);
    return next;
  });
  ok(res, { stored: true });
}

// Le juge de friction (haiku) ne tourne PAS sur le poste qui produit la fiche : il passe apres coup,
// depuis la machine d'audit. Il n'a donc pas le droit de renvoyer une fiche entiere, il ecraserait
// les champs que seul le poste connait (host, entrypoint, client_version, sidechains). Il envoie son
// verdict, le serveur le pose sur la fiche stockee.
// Sans cette route, `signals.friction` restait `null` cote bucket POUR TOUJOURS : le jugement se
// faisait en local et la fiche distante n'etait jamais reecrite. La tuile Frictions du cockpit ne
// montrait donc que l'historique pousse a la main par push-local-cards, et rien du flux courant.
async function handleVerdict(req, res) {
  const body = await readBody(req);
  const user = normUser(safeId(body.user) || 'unknown');
  const sid = safeId(body.sid);
  const date = SAFE_DATE.test(body.date || '') ? body.date : null;
  if (!sid || !date) return fail(res, 400, 'invalid sid/date');

  // On ne prend du verdict QUE ce que le juge a mesure. Tout le reste de la fiche appartient au poste.
  const v = (body.verdict && typeof body.verdict === 'object') ? body.verdict : {};
  const n = x => (Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0);

  // Tout ce qui suit se decide sur la fiche RELUE a chaque tentative, `keepText` compris : le juge a
  // pu telecharger une version que le poste a remplacee depuis, et poser le texte selon un opt-in
  // qui n'est plus le sien.
  const written = await updateCard(`cards/${user}/${date}_${sid}.json`, card => {
    if (!card) return null;
    card.signals = {
      ...(card.signals || {}),
      friction: n(v.friction),
      correction: n(v.correction),
      regression: n(v.regression),
    };
    // Le juge lit le TRANSCRIPT : il voit donc le texte des prompts meme quand le poste a demande a ne
    // pas le stocker en fiche. Sans ce garde-fou le verdict le reinjecterait dans la fiche, c'est-a-dire
    // dans l'objet a retention illimitee : le reglage du poste serait contourne par le chemin le plus
    // durable du systeme.
    const keepText = sharesPromptText(card);
    card.friction_prompts = Array.isArray(v.friction_prompts)
      ? v.friction_prompts.slice(0, 100).map(f => ({
          ...(keepText ? { text: String(f && f.text || '').slice(0, 240) } : {}),
          turns: n(f && f.turns),
          min: n(f && f.min),
          famille: typeof (f && f.famille) === 'string' ? f.famille.slice(0, 40) : null,
        }))
      : [];
    card.judged = true;
    card.judged_by = 'llm';
    card.judged_at = new Date().toISOString();
    return card;
  });
  if (!written) return fail(res, 404, 'card not found');
  ok(res, { judged: true, friction: written.signals.friction });
}

async function handleSign(req, res) {
  const body = await readBody(req);
  const user = normUser(safeId(body.user) || 'unknown');
  const sid = safeId(body.sid);
  const date = SAFE_DATE.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
  if (!sid) return fail(res, 400, 'invalid sid');

  const urls = [];
  for (const f of files) {
    const rel = safeRelPath(f && f.name);
    if (!rel) continue;
    const [url] = await storage.bucket(BUCKET).file(`transcripts/${user}/${date}/${sid}/${rel}.gz`).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + SIGN_TTL_MS,
      contentType: 'application/gzip',
    });
    urls.push({ name: f.name, url });
  }
  ok(res, { urls });
}

// Lecture des fiches pour le cockpit. Le nom d'objet porte la date (`cards/<user>/<date>_<sid>.json`),
// donc la fenetre se filtre sur le nom : on ne telecharge que ce qu'on affiche.
let cockpitCache = { key: '', at: 0, html: '' };

async function loadCards(sinceDate) {
  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: 'cards/' });
  const wanted = files.filter(f => {
    const base = f.name.slice(f.name.lastIndexOf('/') + 1);
    return base.endsWith('.json') && base.slice(0, 10) >= sinceDate;
  });
  const out = [];
  const CONCURRENCY = 24;
  for (let i = 0; i < wanted.length; i += CONCURRENCY) {
    const batch = await Promise.all(wanted.slice(i, i + CONCURRENCY).map(async f => {
      try {
        const c = JSON.parse((await f.download())[0].toString('utf8'));
        c.user = normUser(c.user);
        return c;
      } catch { return null; }
    }));
    for (const c of batch) if (c) out.push(c);
  }
  return out;
}

async function handleCockpit(req, res, url) {
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const user = safeId(url.searchParams.get('user') || '') || '';
  const bots = url.searchParams.get('bots') === '1';
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const key = `d${days}u${user}b${bots ? 1 : 0}`;
  if (cockpitCache.key === key && Date.now() - cockpitCache.at < COCKPIT_CACHE_MS) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(cockpitCache.html);
  }
  const cards = await loadCards(since);
  const html = renderCockpit(cards, { days, user, bots, generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC' });
  cockpitCache = { key, at: Date.now(), html };
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function cockpitAuthed(req) {
  const h = req.headers.authorization || '';
  if (!COCKPIT_PASS || !h.startsWith('Basic ')) return false;
  const [u, p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return u === COCKPIT_USER && p === COCKPIT_PASS;
}

createServer(async (req, res) => {
  try {
    // Sous /v1/ et pas a la racine : sur ce projet, le frontend Google intercepte `/` et `/healthz`
    // et rend son propre 404 sans que la requete n'atteigne le conteneur (verifie, zero log).
    if (req.method === 'GET' && req.url === '/v1/healthz') return ok(res, { ok: true });
    if (req.method === 'GET' && req.url.startsWith('/v1/cockpit')) {
      if (!cockpitAuthed(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="telemetrie", charset="UTF-8"' });
        return res.end('auth requise');
      }
      return await handleCockpit(req, res, new URL(req.url, 'http://x'));
    }
    if (req.method !== 'POST') return fail(res, 404, 'not found');
    if (!authed(req)) return fail(res, 401, 'unauthorized');
    if (req.url === '/v1/sessions') return await handleSession(req, res);
    if (req.url === '/v1/verdicts') return await handleVerdict(req, res);
    if (req.url === '/v1/transcripts/sign') return await handleSign(req, res);
    return fail(res, 404, 'not found');
  } catch (e) {
    fail(res, 500, String(e && e.message || e));
  }
}).listen(PORT);
