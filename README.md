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

## Installation (poste Mac ou Windows)

```
/plugin marketplace add https://github.com/latrace-code/claude-telemetry.git
/plugin install latrace-telemetry@latrace
```

Puis, dans un terminal, l'adresse et la clé du service (elles ne sont pas dans ce dépôt, qui est
public), et l'activation des mises à jour automatiques :

```bash
mkdir -p ~/.latrace-telemetry && printf '%s\n' '{"endpoint":"<url>","token":"<jeton>","user":"<prenom>"}' > ~/.latrace-telemetry/config.json
node "$HOME/.claude/plugins/marketplaces/latrace/tools/enable-autoupdate.mjs"
```

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

## Périmètre : ne remonter qu'une partie de ses sessions

Par défaut le capteur remonte **toutes** les sessions Claude Code du poste. Sur une machine qui
mélange travail d'équipe et projets personnels, on restreint l'envoi à une liste de dossiers avec
`include_projects` dans `~/.latrace-telemetry/config.json` :

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

Le chemin doit être **absolu** (`~` est accepté et résolu). Un chemin relatif ne correspondra à rien
et, l'allowlist étant stricte, **plus aucune session ne remonterait** : c'est le seul mode d'échec
silencieux de cette option. La comparaison suit le système de fichiers, insensible à la casse sur
macOS et Windows, sensible sur Linux.

- **Liste absente ou vide** : comportement historique, tout remonte. Un poste qui ne configure rien
  n'est pas affecté.
- **Allowlist stricte** : par défaut rien ne part, seul ce qui matche est envoyé. Un dossier oublié
  ne fuite pas, il est ignoré.
- **À poser avant la première session** : le bootstrap (rattrapage d'historique) respecte la liste,
  donc elle doit être en place avant le premier démarrage pour qu'aucune session hors périmètre ne parte.

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
| Rétention | fiches : illimitée (1 Ko chacune) · transcripts : purge automatique à 90 jours |

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
- Chaque fiche porte `plugin_version` : le sha du commit installé sur le poste qui l'a émise. C'est
  le seul champ qui dise la version réellement en service. Ne pas se fier au `schema` de la fiche
  pour ça, `recompute-from-bucket` le réécrit avec la lib de la machine qui rejoue. Le cockpit
  compare ce sha à celui du poste qui a émis la fiche la plus récente, et alerte sur les autres.
