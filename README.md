# latrace-claude-telemetry

Capteur de télémétrie d'itération IA pour l'équipe. Chaque session Claude Code produit une fiche
(durées, prompts, outils, erreurs, agents, tokens, signaux de friction) et son transcript complet,
remontés sur l'infra La Trace pour qu'on puisse auditer comment on travaille avec l'IA.

## Ce que ça fait, et ce que ça ne fait pas

Le client **lit** ce que Claude Code a déjà écrit sur le disque, calcule la fiche, envoie. C'est tout.

- Il ne modifie aucune configuration, n'injecte aucun contexte, ne change rien au comportement des
  sessions. Il n'appelle aucun modèle, donc il ne consomme rien.
- Il n'écrit que dans `~/.latrace-telemetry/` (file d'attente hors ligne). Supprimable sans rien casser.
- Il ne bloque jamais une session : le hook calcule la fiche puis rend la main, l'envoi part dans un
  process détaché.

## Ce qui sort du poste

Trois choses de nature très différente, qui se règlent séparément dans
`~/.latrace-telemetry/config.json` :

| | Contenu | Réglage | Rétention |
|---|---|---|---|
| **Fiche** | compteurs : durées, relances, tours, outils, erreurs, tokens, agents, projet, branche, surface | toujours envoyée | illimitée |
| **Transcript** | la conversation entière + celle de chaque sous-agent, contenu des fichiers lus et sortie des commandes | `"transcripts": true` | 90 jours |
| **Extraits verbatim en fiche** | `subject` (90 car du 1er prompt), texte des frictions (40 × 240 car), requêtes de recherche mémoire | `"prompt_text": true` | illimitée |

Les deux réglages valent `false` tant qu'on ne les a pas mis à `true` explicitement. La comparaison
est stricte : la chaîne `"true"`, ou toute faute de frappe, vaut `false`. Sur un interrupteur qui
fait sortir du verbatim, l'erreur doit tomber du côté qui protège.

**Ce qui part toujours, quoi qu'on règle** : tous les compteurs. Durées actif/attente/dormant,
relances humaines, tours d'assistant, appels d'outils et taux d'erreur, tokens, agents, workflows,
projet, branche, surface, plateforme, hôte. C'est-à-dire tout ce que le cockpit affiche, à
l'exception de la colonne Sujet et du texte des frictions.

**Le signal de friction survit sans le verbatim.** Le juge (haiku) tourne sur la machine d'audit, à
partir du transcript stocké : un poste qui ne partage pas son transcript le priverait de matière et
`signals.friction` resterait `null` pour toujours. Le capteur calcule donc le signal *sur le poste*,
avec le détecteur regex déterministe déjà présent dans la lib (celui que mesure `judge-bench`), et
n'envoie que le résultat : le nombre de frictions et leur **coût** — tours et minutes imputés
jusqu'au prompt humain suivant. La phrase qui les a déclenchées reste sur la machine. `judged_by`
distingue `regex-local` d'un verdict `llm`.

Pourquoi le défaut est `false` des deux côtés : les extraits verbatim de la fiche ont la rétention
des **fiches**, illimitée, là où les transcripts purgent à 90 jours. Le verbatim le plus durable du
système est donc celui qu'on remarque le moins — il n'apparaît nulle part dans l'écran qu'on
regarde. Un réglage qui fait sortir du verbatim se donne ; il ne s'hérite pas.

**Le réglage s'applique quand la donnée part, pas quand elle a été calculée.** Une fiche ne sort pas
toujours dans la foulée : elle peut attendre dans la file (cinq tentatives), y avoir été mise par une
version antérieure du capteur, ou traverser un changement d'avis. Le caviardage est donc repassé au
drain, avec la config du jour — et c'est un **cliquet** : une fiche qui a perdu son verbatim ne le
retrouve pas si le réglage repasse à `true`, elle annoncerait un texte qu'elle n'a plus. Deux autres
chemins pouvaient le reposer une fois la fiche stockée, le report de verdict et le rejeu depuis le
bucket : ils appliquent la même règle, voir *Architecture* et *Rattrapage*.

**Ce que ce réglage ne rattrape pas : les postes qui ne l'ont pas encore.** Le caviardage vit sur le
poste. Un poste resté sur une version antérieure du capteur continue donc d'envoyer `subject`, le
texte de ses frictions et ses requêtes mémoire, et le service les stocke : sa fiche arrive **sans**
`shares`, c'est-à-dire sans choix exprimé — pas avec un choix négatif. Le service ne tranche pas à sa
place. Il refuse seulement d'*ajouter* du verbatim à une telle fiche (le verdict du juge, §
*Architecture*), parce que ce texte-là, lui, ne vient pas du poste. Comme `autoUpdate` vaut `false`
pour ce marketplace, un poste peut rester gelé des semaines : c'est précisément à quoi sert la
deuxième ligne de l'installation. Faire trancher le service à la place des postes gelés tiendrait en
une ligne, mais viderait la colonne Sujet de toute la flotte non mise à jour, historique poussé par
`push-local-cards` compris — c'est un choix d'équipe, pas un défaut à corriger en silence.

## Installation (poste Mac ou Windows)

```
/plugin marketplace add https://github.com/latrace-code/claude-telemetry.git
/plugin install latrace-telemetry@latrace
```

Puis, dans un terminal, l'adresse et la clé du service (elles ne sont pas dans ce dépôt, qui est
public), **la liste des dossiers à remonter**, et l'activation des mises à jour automatiques :

```bash
mkdir -p ~/.latrace-telemetry && printf '%s\n' '{"endpoint":"<url>","token":"<jeton>","user":"<prenom>","include_projects":["/chemin/absolu/vers/un/depot"]}' > ~/.latrace-telemetry/config.json
node "$HOME/.claude/plugins/marketplaces/latrace/tools/enable-autoupdate.mjs"
```

`include_projects` fait partie de la **première** commande, pas d'un réglage qu'on ajoutera plus
tard : tant qu'elle est absente, le capteur ne remonte rien, et le rattrapage d'historique du premier
démarrage (qui part sur tout ce que la machine porte encore) n'a jamais l'occasion de sortir du
périmètre. Voir la section « Périmètre » plus bas.

La deuxième ligne n'est pas optionnelle : **Claude Code ne met à jour tout seul que les marketplaces
d'Anthropic**. Pour tous les autres, `autoUpdate` vaut `false` par défaut et le plugin reste épinglé
au commit du jour de l'installation, indéfiniment et sans le dire. Le script déclare le marketplace
`latrace` comme auto-updatable dans `~/.claude/settings.json` ; après ça, plus rien à faire.

## Resynchroniser un poste gelé

Symptôme : le cockpit affiche « capteur en retard » sur un poste, ou ses fiches arrivent sans les
champs récents. Trois commandes, une seule fois, dans un terminal :

```bash
claude plugin marketplace update latrace
node "$HOME/.claude/plugins/marketplaces/latrace/tools/enable-autoupdate.mjs"
claude plugin update latrace-telemetry@latrace
```

Puis redémarrer Claude Code (la mise à jour d'un plugin ne s'applique qu'au démarrage suivant). La
première ligne rafraîchit le clone du marketplace, la deuxième fait qu'on n'aura plus jamais à le
faire, la troisième déplace le plugin installé sur le dernier commit. Aucune des trois ne touche aux
sessions ni aux données.

Rien ne se perd pendant le gel : les transcripts restent sur le poste et dans le bucket, les fiches
peuvent être recalculées après coup (`tools/recompute-from-bucket.mjs`).

Prérequis : `node` dans le PATH. Aucun compte GitHub requis (dépôt public, clone HTTPS anonyme,
vérifié sur une machine sans clé SSH ni credentials).

Pour couper le capteur : `LATRACE_TELEMETRY_OFF=1`, ou `{"enabled": false}` dans
`~/.latrace-telemetry/config.json`.

## Périmètre : le capteur ne remonte que les dossiers qu'on lui a désignés

Le capteur ne remonte **que** les dossiers listés dans `include_projects`
(`~/.latrace-telemetry/config.json`) :

```json
{
  "endpoint": "...",
  "token": "...",
  "user": "prenom",
  "include_projects": ["/Users/moi/Developer/LaTrace"]
}
```

Liste de préfixes de chemins réels. Une session n'est captée que si son dossier de travail est l'un
d'eux ou un sous-dossier (worktrees inclus). Tout le reste - autres projets, dossiers perso - n'est ni
calculé, ni mis en file, ni rattrapé au bootstrap.

Le chemin doit être **absolu** (`~` est accepté et résolu). La comparaison suit le système de
fichiers, insensible à la casse sur macOS et Windows, sensible sur Linux.

- **Liste absente ou vide** : **rien ne remonte**. Un poste qui n'a rien configuré est un poste
  silencieux, pas un poste qui remonte tout.
- **Allowlist stricte** : seul ce qui matche est envoyé. Un dossier oublié ne fuite pas, il est ignoré.
- **Tout remonter reste possible, mais se dit** : `"include_projects": ["*"]`. Le joker n'est reconnu
  que sous cette forme exacte, comme entrée du tableau ; une chaîne nue (`"include_projects": "*"`)
  vaut liste vide, donc silence.

### Pourquoi ce défaut

Le défaut précédent était l'inverse : liste absente valait « tout le poste ». Deux conséquences qu'on
n'a pas voulu garder.

D'abord, **un oubli ne coûtait pas la même chose des deux côtés**. Avec l'ancien défaut, oublier la
liste remontait des dépôts personnels, et personne sur le poste ne pouvait s'en apercevoir - le
capteur est volontairement invisible. Avec le nouveau, un oubli fait taire le poste : ça se voit dans
le cockpit, qui alerte déjà sur les capteurs en retard, et ça se répare en une ligne. On a déplacé le
mode d'échec silencieux vers celui qui ne crée pas de dégât.

Ensuite, **le rattrapage du premier démarrage part sur tout l'historique encore présent sur la
machine** (voir plus bas), et il respecte le périmètre. Avec l'ancien défaut, l'ordre des étapes
d'installation décidait de ce qui partait : configurer l'endpoint avant la liste suffisait à envoyer
d'un coup ~30 jours de sessions, tous dépôts confondus, avant que la liste n'existe. Le nouveau
défaut rend cet ordre indifférent.

Enfin, le périmètre n'est pas qu'un réglage de confort : c'est ce qui rend le capteur acceptable sur
une machine qui n'est pas exclusivement de travail. Un consentement qui s'obtient par défaut n'en est
pas un ; celui-là se donne dossier par dossier, et il est relisible dans un fichier que la personne
possède.

### Migration

Ce changement **arrête les postes déjà installés qui n'ont pas de `include_projects`** : ils
remontaient tout, ils ne remonteront plus rien tant qu'ils n'auront pas listé leurs dossiers. C'est
volontaire et ça demande un mot à l'équipe plutôt qu'un déploiement silencieux - chacun ajoute sa
liste (ou `["*"]` s'il assume de tout remonter). Rien n'est perdu côté serveur, les fiches déjà
déposées restent.

Le filtrage porte sur le chemin, pas sur le contenu : un transcript retenu peut toujours contenir ce
que les commandes ont affiché, donc potentiellement des secrets. Le périmètre réduit ce qui part, il
ne rend pas anodin ce qui reste.

## Architecture

```
poste (hook) ──POST fiche──►  Cloud Run  ──►  gs://latrace-claude-telemetry/cards/<user>/
             ──PUT gzip───►  URL signée  ──►  gs://latrace-claude-telemetry/transcripts/<user>/<date>/<sid>/
```

Le poste n'a aucun credential Google : il demande au service une URL signée à durée de vie courte
(15 min) et y dépose le fichier gzippé.

| Pièce | Où |
|---|---|
| Service d'ingestion | Cloud Run `latrace-telemetry-ingest`, europe-west1, projet `latrace31` |
| Stockage | `gs://latrace-claude-telemetry` (privé, public access prevention, IAM uniforme) |
| Rétention | fiches : illimitée (1 Ko chacune) · transcripts : purge automatique à 90 jours, et envoyés seulement si `"transcripts": true` |

Le service est **en écriture seule** : aucune route ne rend de donnée. Les transcripts contiennent le
contenu des fichiers lus et la sortie des commandes exécutées, donc potentiellement des credentials.
La lecture passe par les accès IAM du bucket, jamais par HTTP.

Trois routes d'ingestion, toutes en POST derrière le token Bearer :

| Route | Rôle |
|---|---|
| `/v1/sessions` | dépôt d'une fiche par le poste |
| `/v1/verdicts` | pose le verdict de friction sur une fiche déjà déposée |
| `/v1/transcripts/sign` | URL signée d'écriture pour le transcript gzippé |

`/v1/verdicts` existe parce que le juge de friction (haiku) tourne **après** l'envoi, sur la machine
d'audit et non sur le poste. Lui faire renvoyer la fiche entière écraserait les champs que seul le
poste connaît (surface, hôte, version du client, sidechains) : il n'envoie donc que son verdict, et
le serveur le pose sur la fiche stockée. Sans cette route, `signals.friction` restait `null` dans le
bucket pour toujours et la tuile Frictions du cockpit ne montrait que l'historique backfillé.
La réponse ne renvoie que ce que l'appelant vient d'écrire : la règle d'écriture seule tient.

Le juge lit le transcript, donc il *voit* le texte des prompts même quand le poste a demandé à ne pas
le stocker en fiche. Le serveur ne pose donc le texte des frictions que si la fiche stockée porte
`shares.prompt_text: true` — sans quoi le réglage du poste serait contourné par le chemin le plus
durable du système. Une fiche sans `shares` vient d'un client antérieur au réglage : aucun opt-in n'a
été exprimé, le texte n'est pas stocké.

La même règle vaut pour le **report de verdict**. Une fiche est réémise à chaque reprise de
conversation, et le serveur y recopie le verdict déjà posé pour ne pas l'effacer ; quand la fiche
entrante ne partage pas son verbatim, ce report ne recopie que les *mesures* du juge. Sans ça, une
reprise de conversation suffirait à remettre le texte qu'un poste vient de retirer — par le chemin
même qui existe pour ne rien perdre.

Les deux routes qui écrivent une fiche relisent d'abord ce qui est stocké, et **rien ne les
sérialise** : elles sont appelées par des machines différentes, le poste d'un côté et la machine
d'audit de l'autre. L'écriture est donc conditionnelle — la génération lue est épinglée, l'écriture
n'est acceptée que si l'objet n'a pas bougé, sinon on relit et on rejoue. Sans ça, le juge qui finit
en dernier repose la fiche telle qu'il l'avait téléchargée et ressuscite le verbatim que le poste
venait de retirer ; et le poste qui finit en dernier efface le verdict que le juge venait de poser.

Ce mécanisme repose sur des garanties de GCS qu'aucun test unitaire ne peut vérifier.
`server/smoke-conditional-write.mjs` les exerce contre le vrai bucket, sur un objet jetable hors du
préfixe `cards/`, et exécute la vraie fonction en provoquant une écriture concurrente. À lancer
avant tout déploiement qui touche à `updateCard` :

```bash
cd server && npm install
node smoke-conditional-write.mjs
```

## Auditer

```bash
node tools/pull.mjs                  # rapatrie les fiches -> ~/brain/telemetry/team/<user>/
node tools/pull.mjs --user quentin

# relire une conversation exacte
gcloud storage cp -r gs://latrace-claude-telemetry/transcripts/<user>/<date>/<sid> /tmp/
gunzip -r /tmp/<sid>
```

Les fiches de l'équipe restent séparées de `~/brain/telemetry/sessions/` : les mélanger ferait
compter les sessions des autres dans tous les dashboards de chantier déjà publiés.

L'interprétation (juge de friction, catégorisation) se fait avec les scripts de
`~/brain/scripts/session-audit/`, dans une session Claude Code. Aucune clé d'API n'intervient.

## Rattrapage

Le `SessionEnd` ne tire pas toujours (fermeture brutale, machine éteinte). Au démarrage suivant, le
client rescanne les transcripts des 7 derniers jours et enfile ce qui n'est jamais parti (20 max par
run, sessions inactives depuis plus de 30 min). C'est le seul filet : contrairement au poste de
Lucas, on ne peut pas rejouer l'historique d'un poste à distance.

Quand la lib d'analyse est corrigée, les fiches déjà envoyées restent fausses et le poste ne les
renverra jamais (son index `sent.json` les croit faites). C'est `tools/recompute-from-bucket.mjs`
qui les rejoue depuis les transcripts stockés :

```bash
node tools/recompute-from-bucket.mjs --user tom --dry            # contrôler avant d'écrire
node tools/recompute-from-bucket.mjs --user lucas --since 2026-07-18 --until 2026-07-19
```

Compter ~4 s par session : le coût est un démarrage de `gcloud` par fichier, pas du calcul. `--since`
sert à rejouer d'abord la fenêtre qu'on regarde ; `--until` (borne haute, exclue) découpe une passe
longue en tranches de dates **disjointes** qu'on lance en parallèle, une fiche n'appartenant alors
qu'à une seule tranche. Sans ça, les ~1 600 sessions d'un poste CLI tiennent une heure et demie de
file d'attente.

**Un rejeu ne rend jamais une fiche plus bavarde que celle qu'il remplace.** Il reconstruit `subject`,
les requêtes mémoire et le texte des frictions depuis le transcript stocké : sans garde-fou, une
passe de maintenance annulerait le réglage d'un poste qui partage son transcript mais pas son
verbatim. La machine qui rejoue ne connaît pas la config du poste, mais la fiche stockée la porte
dans `shares` — c'est elle qu'on réapplique avant de renvoyer. Une fiche antérieure au réglage n'a
pas de `shares` et garde son sujet : ce verbatim est déjà stocké, le rejeu n'a pas à l'effacer,
seulement à ne rien rajouter.

## Notes de terrain

- Sur ce projet GCP, le frontend Google intercepte `/` et `/healthz` et rend son propre 404 sans que
  la requête n'atteigne le conteneur (vérifié : zéro log côté service). Toutes les routes vivent donc
  sous `/v1/`, sonde comprise (`GET /v1/healthz`).
- `client/telemetry-lib.mjs` est la copie de `~/.claude/hooks/telemetry-lib.mjs` avec une seule
  différence : le home est résolu à l'exécution au lieu d'être en dur. Sur un poste sans `~/brain`,
  les champs de traçage brain restent nuls, le reste de la fiche est identique et comparable.
- `user` vaut le nom d'utilisateur système du poste. Pour forcer un nom lisible :
  `{"user": "quentin"}` dans `~/.latrace-telemetry/config.json`.
- **Ne pas mettre de `version` dans `.claude-plugin/plugin.json`** : une version figée bloque les
  mises à jour. Mais l'enlever ne suffit pas à en déclencher : la mise à jour d'un marketplace tiers
  dépend uniquement d'`autoUpdate` (voir Installation). L'absence de `version` et la présence
  d'`autoUpdate` sont deux conditions nécessaires, aucune n'est suffisante seule.
- **Reprises de conversation.** Rouvrir une conversation crée une session qui rejoue tout
  l'historique. `chain_id` (l'uuid du premier message du transcript) identifie le FIL et survit au
  réétiquetage des messages. Deux lectures du même corpus, à ne pas confondre : le cockpit **replie**
  les fiches d'un fil pour compter le VOLUME de travail une seule fois, et **compte les fiches
  brutes** du même fil pour mesurer le COMPORTEMENT (combien de réouvertures). Brancher la seconde
  mesure sur les fiches repliées rendrait 1,00 session par fil partout. Une fiche sans `chain_id`
  (émise avant le champ) est hors de la mesure, et le cockpit affiche la part de temps concernée.
- **Compactions** (`compactions: {total, auto, manual}`, schema 7) : première métrique de santé d'une
  session et pas de volume. `auto` = la fenêtre de contexte a débordé toute seule, `manual` =
  quelqu'un a nettoyé avant. Le champ est toujours présent, même à zéro : `{total:0}` veut dire
  « compté, rien trouvé », un champ absent veut dire « fiche émise avant la mesure », et le cockpit
  affiche un tiret dans ce second cas. Les fiches déjà en base ne l'auront qu'après un
  `recompute-from-bucket`.
- Chaque fiche porte `plugin_version` : le sha du commit installé sur le poste qui l'a émise. C'est
  le seul champ qui dise la version réellement en service. Ne pas se fier au `schema` de la fiche
  pour ça, `recompute-from-bucket` le réécrit avec la lib de la machine qui rejoue. Le cockpit
  compare ce sha à celui du poste qui a émis la fiche la plus récente, et alerte sur les autres.
