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
  await storage.bucket(BUCKET).file(`cards/${user}/${date}_${sid}.json`).save(JSON.stringify(card, null, 1), {
    contentType: 'application/json',
    resumable: false,
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

  const file = storage.bucket(BUCKET).file(`cards/${user}/${date}_${sid}.json`);
  let card;
  try { card = JSON.parse((await file.download())[0].toString('utf8')); }
  catch { return fail(res, 404, 'card not found'); }

  // On ne prend du verdict QUE ce que le juge a mesure. Tout le reste de la fiche appartient au poste.
  const v = (body.verdict && typeof body.verdict === 'object') ? body.verdict : {};
  const n = x => (Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0);
  card.signals = {
    ...(card.signals || {}),
    friction: n(v.friction),
    correction: n(v.correction),
    regression: n(v.regression),
  };
  card.friction_prompts = Array.isArray(v.friction_prompts)
    ? v.friction_prompts.slice(0, 100).map(f => ({
        text: String(f && f.text || '').slice(0, 240),
        turns: n(f && f.turns),
        min: n(f && f.min),
        famille: typeof (f && f.famille) === 'string' ? f.famille.slice(0, 40) : null,
      }))
    : [];
  card.judged = true;
  card.judged_at = new Date().toISOString();

  await file.save(JSON.stringify(card, null, 1), { contentType: 'application/json', resumable: false });
  ok(res, { judged: true, friction: card.signals.friction });
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
