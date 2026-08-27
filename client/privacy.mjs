// Ce qui sort du poste, et ce qui reste dessus.
//
// Le capteur produit deux choses de nature tres differente :
//
//   - la FICHE : des compteurs (durees decoupees, prompts, tours, outils, erreurs, tokens, agents,
//     sidechains). C'est elle qui alimente le cockpit, et c'est elle qui sert a s'ameliorer.
//   - le TRANSCRIPT : la conversation entiere, mot pour mot, plus celle de chaque sous-agent. Il
//     porte le contenu des fichiers ouverts et la sortie des commandes executees. Le README le dit
//     deja : donc potentiellement des credentials.
//
// La fiche elle-meme transporte du verbatim, et c'est le point le moins visible du systeme :
// `subject` (90 car du premier prompt), `friction_prompts[].text` (jusqu'a 40 x 240 car) et
// `brain.searches` (les requetes de recherche tapees a la main). Ces extraits ont la retention des
// FICHES, illimitee, la ou les transcripts purgent a 90 jours : le verbatim le plus durable du
// systeme est celui qu'on remarque le moins.
//
// Les deux sortent desormais sur decision du poste, et separement, dans
// ~/.latrace-telemetry/config.json :
//
//   "transcripts": true    envoie la conversation complete        (defaut : false)
//   "prompt_text": true    laisse les extraits verbatim en fiche  (defaut : false)
//
// Comparaison stricte a `true` : toute autre valeur, y compris la chaine "true", vaut false. Sur un
// interrupteur qui fait sortir du verbatim, une faute de frappe doit tomber du cote qui protege.
// C'est la symetrie du joker "*" de paths.mjs, dans l'autre sens.
//
// Ce qui ne depend d'aucun des deux et part toujours : les compteurs. Durees actif/attente/dormant,
// relances, tours, outils et taux d'erreur, tokens, agents, workflows, projet, branche, surface.
// C'est-a-dire tout ce que le cockpit affiche, sauf la colonne Sujet et le texte des frictions.

import { detectFrictionRegex } from './telemetry-lib.mjs';

export function shareTranscripts(cfg) { return !!cfg && cfg.transcripts === true; }
export function sharePromptText(cfg) { return !!cfg && cfg.prompt_text === true; }

// Le juge de friction (haiku) ne tourne pas sur le poste : il passe apres coup, sur la machine
// d'audit, a partir du transcript stocke. Un poste qui ne partage pas son transcript le prive donc
// de sa matiere, et `signals.friction` resterait `null` pour toujours -- la question "ou est-ce que
// ca coince" deviendrait sans reponse pour ce poste, ce qui est exactement le signal qu'on veut
// garder.
//
// On calcule donc le signal SUR LE POSTE, avec le detecteur regex deterministe deja present dans la
// lib (celui que judge-bench mesure), et on n'envoie que le resultat : le compte de frictions et
// leur COUT (tours et minutes imputes jusqu'au prompt humain suivant). Le texte qui les a
// declenchees ne sort pas.
//
// Quand le transcript part, on ne passe pas de detecteur : la passe haiku fait mieux et la fiche
// sort `judged:false`, comme avant, pour qu'elle la reprenne.
export function localDetector(cfg) {
  return shareTranscripts(cfg) ? null : detectFrictionRegex;
}

// Applique le reglage `prompt_text` a une fiche deja calculee, et trace ce que le poste partage.
//
// A appeler APRES le filtre `!card.subject` des appelants : `subject` sert de garde ("cette session
// a-t-elle vraiment eu lieu"), il ne doit etre efface qu'une fois cette garde passee. L'ordre
// inverse jetterait toutes les fiches d'un poste qui ne partage pas son verbatim.
export function redactCard(card, cfg) {
  card.shares = { transcripts: shareTranscripts(cfg), prompt_text: sharePromptText(cfg) };
  if (sharePromptText(cfg)) return card;

  // Le sujet est le premier prompt tronque : du verbatim. Ce que la session a touche reste lisible
  // par `project` et `branch`, qui sont des metadonnees du depot et pas des mots de quelqu'un.
  card.subject = null;

  // On garde le COUT de chaque friction, on laisse la phrase sur le poste. C'est le cout qui dit ou
  // ca coince ; le texte exact sert a savoir QUI a dit QUOI, ce qui n'est pas la meme question.
  if (Array.isArray(card.friction_prompts)) {
    card.friction_prompts = card.friction_prompts.map(f => ({
      turns: f.turns, min: f.min, famille: f.famille || null,
    }));
  }

  // Les requetes de recherche memoire sont tapees a la main : verbatim aussi. Leur NOMBRE repond
  // deja a la question posee par ces champs (la session est-elle allee fouiller, et combien).
  // Les chemins lus/ecrits restent : ce sont des noms de fichiers du depot, pas une saisie.
  for (const k of ['brain', 'brain_all']) {
    const b = card[k];
    if (!b || !Array.isArray(b.searches)) continue;
    const { searches, ...rest } = b;
    card[k] = { ...rest, searches_n: searches.length };
  }
  return card;
}
