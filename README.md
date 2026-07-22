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
/plugin marketplace add latrace-code/claude-telemetry
/plugin install latrace-telemetry@latrace
```

Une fois, puis plus rien : le plugin se met à jour tout seul depuis ce repo.

Prérequis : `node` disponible dans le PATH.

Pour couper le capteur : `LATRACE_TELEMETRY_OFF=1`, ou `{"enabled": false}` dans
`~/.latrace-telemetry/config.json`.

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
