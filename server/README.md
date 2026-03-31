# SERVER V3

Ce dossier definit le futur socle serveur de `baptisto-trading-v3`.
Il s'agit pour l'instant d'une structure de reference, pas d'une implementation.

## Objectif

Donner une base claire pour:

- le runtime `backtest / replay / paper / live`,
- les donnees de marche,
- les indicateurs,
- la strategie,
- le moteur de decision LLM,
- l'execution,
- le portefeuille,
- les reports.

## Arborescence cible

```text
server/
├── README.md
├── docs/
│   └── MODULE_CONTRACTS.md
├── scripts/
├── src/
│   ├── app/
│   ├── config/
│   ├── core/
│   │   ├── api/
│   │   ├── backtest/
│   │   ├── cache/
│   │   ├── indicators/
│   │   ├── llm/
│   │   ├── market/
│   │   ├── reports/
│   │   ├── runtime/
│   │   ├── strategy/
│   │   ├── telemetry/
│   │   └── types/
│   ├── modes/
│   └── services/
│       ├── features/
│       ├── portfolio/
│       └── symbols/
└── storage/
    ├── cache/
    ├── configs/
    ├── datasets/
    ├── reports/
    ├── runs/
    └── snapshots/
```

## Role des dossiers

### `docs/`

Documentation de reference du serveur:

- contrats minimaux,
- conventions,
- schemas de donnees,
- protocoles d'iteration si besoin plus tard.

### `scripts/`

Scripts hors runtime principal:

- batch backtests,
- replay ponctuel,
- warmup de cache,
- comparaison de runs,
- eventuel outillage d'evaluation modele.

Exemples utiles:

- `npm run backtest:symbol -- AAPL --days 30 --step 30m`
- `npm run backtest:batch -- --days 30 --step 30m`
- `npm run backtest:regression -- --scenario nvda_high_beta_reference`
- `npm run backtest:regressions`
- `npm run backtest:regression -- NVDA --start 2026-02-27T16:06:17.517Z --end 2026-03-29T16:06:17.517Z --baseline no_high_beta --candidate current`
- `npm run report:daily -- --date 2026-03-31`
- `npm run paper:preopen -- --target-date 2026-03-31 --pilot-symbol AAPL`

Le serveur sait maintenant aussi:

- recuperer un panier RSS financier configurable et le mettre en cache,
- generer un rapport quotidien JSON avec synthese Ollama si le modele local est disponible,
- produire un check de pre-ouverture paper trading sans jamais soumettre d'ordre pendant ce controle.

Regle:
aucune logique metier critique ne doit vivre uniquement ici.

### `src/app/`

Point d'entree applicatif et composition racine:

- bootstrap,
- chargement config,
- wiring des dependances,
- choix du mode d'execution.

Regle:
`app/` assemble, mais ne contient pas la logique metier profonde.

### `src/config/`

Gestion de la configuration:

- environnement,
- symboles,
- timeframes,
- profils de risque,
- mapping des symboles lies,
- selection du provider LLM.

Regle:
la config doit etre chargee ici, pas dispersee dans les strategies.

### `src/core/`

Coeur stable du systeme.
C'est la zone la plus importante du projet.

#### `src/core/api/`

Abstractions externes:

- `MarketDataProvider`
- `BrokerGateway`

Le code specifique a Alpaca devra s'aligner sur ces contrats plutot que l'inverse.

#### `src/core/backtest/`

Simulation:

- execution simulee,
- gestion du portefeuille,
- calcul des metrics,
- resultats de run.

#### `src/core/cache/`

Cache disque et cles de cache.

#### `src/core/indicators/`

Indicateurs techniques, purs et testables.

#### `src/core/llm/`

Abstraction du moteur de decision:

- construction de requete,
- parsing de reponse,
- schema de decision,
- gestion des erreurs.

#### `src/core/market/`

Temps et marche:

- UTC,
- horaires de marche,
- sessions,
- timeframes,
- agregation de bars.

#### `src/core/reports/`

Persistence des runs:

- rapports,
- resumes,
- index de runs,
- comparaisons.

#### `src/core/runtime/`

Boucle d'orchestration:

- tick,
- evaluation,
- scheduling,
- replay.

#### `src/core/strategy/`

Socle strategie:

- contexte,
- features attendues,
- cycle `warmup -> evaluate -> decide`.

#### `src/core/telemetry/`

Logs structures et events exploitables.

#### `src/core/types/`

Schemas de donnees partages.

### `src/modes/`

Specialisation des modes:

- `backtest`
- `replay`
- `paper`
- `live`

Regle:
les modes choisissent l'orchestration et certains adapters, mais ne reimplementent pas la logique strategie.

### `src/services/`

Services applicatifs composes a partir du `core`.

#### `src/services/features/`

Preparation des snapshots de features pour la strategie et le LLM.

#### `src/services/portfolio/`

Lecture et projection de l'etat portefeuille.

#### `src/services/symbols/`

Resolution des univers:

- symbole principal,
- symboles lies,
- profils par symbole.

### `storage/`

Stockage local versionne ou semi-persistant.

#### `storage/cache/`

Cache de requetes et d'historiques derives.

#### `storage/configs/`

Configs locales:

- symboles
- timeframes
- profils LLM
- risk profiles

#### `storage/datasets/`

Datasets utilisables pour:

- backtests,
- replay,
- evaluation offline.

#### `storage/reports/`

Rapports JSON exploitables.

#### `storage/runs/`

Meta-informations sur les runs:

- params,
- seed,
- version,
- hashes dataset si ajoute plus tard.

#### `storage/snapshots/`

Snapshots intermediaires:

- features
- decisions
- etat portefeuille

## Regles de placement

Si un module:

- parle au monde exterieur, il va plutot dans `core/api/`
- calcule un indicateur pur, il va dans `core/indicators/`
- gere le temps, il va dans `core/market/`
- genere une decision LLM, il va dans `core/llm/`
- simule une execution, il va dans `core/backtest/`
- assemble plusieurs briques metier, il va plutot dans `services/`
- demarre le systeme, il va dans `app/`

## Regles de frontiere

- Une strategie ne parle jamais directement a Alpaca.
- Le LLM ne renvoie jamais un ordre broker brut.
- Le backtester ne doit pas recalculer une logique strategie differente du live.
- Les timestamps internes sont en UTC.
- Les reports sont des artefacts de premier ordre, pas des logs jetables.

## Modules centraux attendus en premier

Ordre de construction recommande:

1. `config`
2. `core/types`
3. `core/market`
4. `core/cache`
5. `core/api`
6. `services/features`
7. `core/strategy`
8. `core/llm`
9. `services/portfolio`
10. `core/backtest`
11. `core/reports`
12. `core/runtime`

Le detail du contrat minimal est documente dans [MODULE_CONTRACTS.md](/Applications/MAMP/htdocs/baptisto-trading-v3/server/docs/MODULE_CONTRACTS.md).
