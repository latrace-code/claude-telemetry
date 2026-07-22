// Ingestion de la telemetrie d'iteration IA (Cloud Run, scale a zero).
//
// Ecriture seule et deliberement : aucune route ne rend de donnee. Les fiches et les transcripts
// contiennent le travail reel de l'equipe (contenu de fichiers lus, sorties de commandes, donc
// potentiellement des credentials). La lecture passe par les acces IAM du bucket, jamais par HTTP.

import { createServer } from 'node:http';
import { Storage } from '@google-cloud/storage';

const PORT = process.env.PORT || 8080;
const BUCKET = process.env.BUCKET;
const TOKEN = process.env.INGEST_TOKEN;
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
  const user = safeId(card.user) || 'unknown';
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

async function handleSign(req, res) {
  const body = await readBody(req);
  const user = safeId(body.user) || 'unknown';
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

createServer(async (req, res) => {
  try {
    // Sous /v1/ et pas a la racine : sur ce projet, le frontend Google intercepte `/` et `/healthz`
    // et rend son propre 404 sans que la requete n'atteigne le conteneur (verifie, zero log).
    if (req.method === 'GET' && req.url === '/v1/healthz') return ok(res, { ok: true });
    if (req.method !== 'POST') return fail(res, 404, 'not found');
    if (!authed(req)) return fail(res, 401, 'unauthorized');
    if (req.url === '/v1/sessions') return await handleSession(req, res);
    if (req.url === '/v1/transcripts/sign') return await handleSign(req, res);
    return fail(res, 404, 'not found');
  } catch (e) {
    fail(res, 500, String(e && e.message || e));
  }
}).listen(PORT);
