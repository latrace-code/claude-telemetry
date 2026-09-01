#!/usr/bin/env node
// Verifie contre le VRAI bucket que l'ecriture conditionnelle des fiches se comporte comme le code
// le suppose. A lancer une fois avant de deployer une modification de `updateCard`, et apres.
//
//   cd server && npm install
//   gcloud auth application-default login          # si ce n'est pas deja fait
//   node smoke-conditional-write.mjs [--bucket latrace-claude-telemetry]
//
// Raison d'etre : `updateCard` repose sur trois comportements de GCS que rien, dans ce depot, ne
// verifie -- ils viennent de la doc du SDK. Si l'un des trois est faux, ce n'est pas une
// fonctionnalite qui casse, c'est l'ingestion entiere : chaque fiche est ecrite par ce chemin.
//
//   1. `ifGenerationMatch: 0` cree l'objet, et REFUSE si l'objet existe deja.
//   2. `ifGenerationMatch: <generation>` accepte si l'objet n'a pas bouge, et refuse en 412 sinon.
//   3. lire `file(nom, { generation })` rend bien CETTE version-la.
//
// Le test 6 va plus loin : il execute la vraie fonction `updateCard` de index.mjs, en provoquant une
// ecriture concurrente pendant qu'elle tourne. C'est le scenario qui a motive ce mecanisme -- le
// poste qui reemet sa fiche pendant que le juge pose son verdict.
//
// SANS DANGER POUR LES DONNEES : tout se passe sous `_smoke/`, en dehors du prefixe `cards/` que lit
// le cockpit, sur un objet efface a la fin. Aucune fiche reelle n'est lue ni ecrite.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '@google-cloud/storage';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const BUCKET = arg('bucket', process.env.LATRACE_TELEMETRY_BUCKET || 'latrace-claude-telemetry');
const NAME = '_smoke/conditional-write.json';

const storage = new Storage();
const bucket = storage.bucket(BUCKET);

// On execute le texte source de `updateCard` plutot qu'une reecriture : un test qui paraphrase la
// fonction qu'il verifie ne verifie que la paraphrase. index.mjs demarre un serveur HTTP a
// l'import, on en extrait donc la tranche utile.
async function loadUpdateCard() {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8');
  const from = src.indexOf('const RMW_TRIES');
  const to = src.indexOf('// Une fiche est REEMISE');
  if (from < 0 || to < 0 || to < from) throw new Error('updateCard introuvable dans index.mjs');
  const mod = `const storage = globalThis.__smokeStorage; const BUCKET = ${JSON.stringify(BUCKET)};\n`
    + src.slice(from, to) + '\nexport { updateCard };';
  globalThis.__smokeStorage = storage;
  return (await import('data:text/javascript,' + encodeURIComponent(mod))).updateCard;
}

// Prevol. Sans lui, une absence d'identifiants ressort en "ECHEC creation" : ca se lit comme un
// verdict sur le mecanisme alors qu'aucun test n'a tourne, et c'est la pire sortie possible pour un
// script dont le seul role est de dire si on peut deployer. Un 404 sur l'objet jetable est la bonne
// nouvelle : on est authentifie, et il n'existe pas encore.
async function preflight() {
  try { await bucket.file(NAME).getMetadata(); return null; }   // deja la : on l'ecrasera
  catch (e) {
    const code = e && (e.code || e.status);
    const m = String((e && e.message) || e);
    // 404 sur l'objet jetable est la BONNE nouvelle : on est authentifie et il n'existe pas encore.
    // 404 sur le bucket, non -- seul le message les distingue.
    if (code === 404) return /bucket/i.test(m) ? `bucket gs://${BUCKET} introuvable.` : null;
    if (code === 401 || /default credentials|invalid_grant|unauthenticated/i.test(m)) {
      return 'pas authentifie.\n  Lancer :  gcloud auth application-default login'
        + '\n  (sous PowerShell, si l\'execution de scripts est desactivee : gcloud.cmd auth application-default login)';
    }
    if (code === 403 || /permission|forbidden/i.test(m)) return `ce compte n'a pas les droits sur gs://${BUCKET}.`;
    return m;
  }
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? ' OK ' : 'ECHEC'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const is412 = e => !!e && (e.code === 412 || e.status === 412);
const write = (body, generation) => bucket.file(NAME).save(JSON.stringify(body), {
  contentType: 'application/json', resumable: false, preconditionOpts: { ifGenerationMatch: generation },
});

async function main() {
  console.log(`bucket ${BUCKET}, objet ${NAME}\n`);

  const bloque = await preflight();
  if (bloque) {
    console.error(`impossible de tester : ${bloque}

Aucun test n'a tourne -- ceci ne dit RIEN du mecanisme.`);
    process.exit(2);
  }

  await bucket.file(NAME).delete({ ignoreNotFound: true });

  // 1. Creation conditionnelle : c'est ce que fait `updateCard` quand la fiche n'existe pas encore.
  try { await write({ etape: 1 }, 0); check('creation avec ifGenerationMatch:0', true); }
  catch (e) { check('creation avec ifGenerationMatch:0', false, e.message); return; }

  // 2. La meme condition doit maintenant REFUSER. Sans ca, deux premieres ecritures concurrentes
  //    d'une meme fiche s'ecraseraient en silence.
  try { await write({ etape: 2 }, 0); check('recreation refusee (412 attendu)', false, 'acceptee alors que l\'objet existe'); }
  catch (e) { check('recreation refusee (412 attendu)', is412(e), is412(e) ? '' : `erreur inattendue : ${e.message}`); }

  // 3. Relire la generation, et lire cette version precise.
  const [meta] = await bucket.file(NAME).getMetadata();
  const gen = meta.generation;
  const [buf] = await bucket.file(NAME, { generation: gen }).download();
  check('lecture epinglee sur la generation', JSON.parse(buf.toString('utf8')).etape === 1, `generation ${gen}`);

  // 4. Ecriture sous la bonne generation : le cas normal, aucune concurrence.
  try { await write({ etape: 4 }, gen); check('ecriture sous la generation lue', true); }
  catch (e) { check('ecriture sous la generation lue', false, e.message); }

  // 5. Ecriture sous une generation perimee : LE test qui compte. C'est exactement ce qui se passe
  //    quand le poste a reecrit la fiche entre notre lecture et notre ecriture.
  try { await write({ etape: 5 }, gen); check('ecriture sous generation perimee refusee (412)', false, 'acceptee : la course n\'est PAS protegee'); }
  catch (e) { check('ecriture sous generation perimee refusee (412)', is412(e), is412(e) ? '' : `erreur inattendue : ${e.message}`); }

  // 6. La vraie fonction, avec une ecriture concurrente glissee pendant qu'elle tourne. `apply` est
  //    appele apres la lecture et avant l'ecriture : c'est la fenetre exacte de la course.
  const updateCard = await loadUpdateCard();
  let tours = 0;
  const written = await updateCard(NAME, async prev => {
    tours++;
    if (tours === 1) {
      const [m] = await bucket.file(NAME).getMetadata();
      await write({ etape: 6, ecrit_par: 'un autre process' }, m.generation);
    }
    return { ...prev, vu_par_updateCard: prev && prev.ecrit_par, etape: 6.1 };
  });
  check('updateCard relit et rejoue apres conflit', tours === 2, `${tours} tentative(s)`);
  check('la seconde tentative voit bien la version fraiche',
    written && written.vu_par_updateCard === 'un autre process',
    `vu : ${JSON.stringify(written && written.vu_par_updateCard)}`);

  await bucket.file(NAME).delete({ ignoreNotFound: true });
  console.log(`\n${failures ? `${failures} test(s) en echec — NE PAS DEPLOYER en l'etat` : 'tout est conforme a ce que suppose updateCard'}`);
}

main().then(
  () => process.exit(failures ? 1 : 0),
  async e => {
    console.error(`\nechec : ${e && e.message}`);
    try { await bucket.file(NAME).delete({ ignoreNotFound: true }); } catch { /* menage best-effort */ }
    process.exit(1);
  },
);
