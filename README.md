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

Puis, dans un terminal, l'adresse et la clé du service (elles ne sont pas dans ce dépôt, qui est public) :

```bash
mkdir -p ~/.latrace-telemetry && printf '%s\n' '{"endpoint":"<url>","token":"<jeton>","user":"<prenom>"}' > ~/.latrace-telemetry/config.json
```

Une fois, puis plus rien : le plugin se met à jour tout seul depuis ce dépôt, à chaque commit.

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
