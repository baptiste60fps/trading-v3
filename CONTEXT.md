# CONTEXT

Ce document sert de memo de transmission pour les futures iterations sur `baptisto-trading-v3`.
Il resume ce qui a ete observe dans `baptisto-trading` (V1) et `baptisto-trading-v2`, en distinguant:

- ce qui est reutilisable,
- ce qui a montre ses limites,
- ce qui doit guider la conception de la V3.

## 1. Point de depart reel

La V3 repart d'un dossier vide.
Ce n'est pas une mauvaise nouvelle.

Les deux projets precedents n'ont pas abouti, mais ils ont deja permis de clarifier beaucoup de choses:

- quelles briques serveur sont utiles,
- quelles dettes techniques reviennent souvent,
- quels types de strategies ont ete sur-experimentes,
- quelles contraintes de trading et d'API sont faciles a sous-estimer.

## 2. Lecture synthetique de la V1

La V1 etait un proto client/server plus compact.
Le coeur utile cote server etait:

- un `App` simple,
- un `BackTester`,
- un `StrategyTrainer`,
- une strategie principale `BaptistoStrategy`,
- un cache local de parametres et de requetes,
- une integration Alpaca rudimentaire,
- une logique de training/evaluation assez artisanale mais directe.

### Ce que la V1 apportait de positif

- une boucle proto assez lisible,
- l'idee d'une strategie persistable par symbole,
- l'idee d'une iteration assez autonome avec `train`, `test`, `trade`,
- un premier couplage entre recherche et execution.

### Ce que la V1 montrait deja comme limites

- `App` tres monolithique,
- `BackTester` encore trop naif,
- couplage fort entre etat global, strategie, API et interface,
- peu de separation entre execution reelle et simulation,
- peu de garanties de reproductibilite.

## 3. Lecture synthetique de la V2

La V2 a grossi dans plusieurs directions:

- serveur Node.js,
- interface Electron/Vue,
- experimentation audio,
- integration Alpaca et Binance,
- nombreuses strategies,
- beaucoup de scripts de batch, tuning et exploration.

Elle contient de vraies briques de valeur, mais aussi une dette naturelle de laboratoire.

### Etat final observe

La V2 serveur contient notamment:

- `server/src/App.mjs`
- `server/src/Core/API/*`
- `server/src/Core/Data/*`
- `server/src/Core/Utils/*`
- `server/src/Core/BackTester.mjs`
- `server/src/strategies/*`
- `server/scripts/*`

Le scope final de la V2 etait plus large que necessaire pour lancer une V3 saine.

## 4. Evolution git utile de la V2

Historique observe dans `.git`:

- debut du repo en janvier 2026
- montee rapide en complexite en fevrier 2026
- pivot important le `2026-03-10` avec le commit `9c1ab44`
  - message: `server: realistic backtester, risk guardrails, configs, docs`
- extension per-symbol le `2026-03-11` avec le commit `708480e`
- poursuite de labos microstructure et `CodexFree` jusqu'au `2026-03-21`

Branches notables observees:

- `codex/server`
- `codex/server-per-symbol-tuning`
- `codex/doc`
- `codex/front`
- `codex/audio`

Lecture pratique:

- la V2 a d'abord evolue comme un serveur de trading/backtest,
- puis a accumule documentation, interface et experimentation,
- enfin elle a de plus en plus derive vers du tuning et du labo de strategies.

## 5. Briques V2 a conserver conceptuellement

### `BackTester`

La V2 a fait un effort utile pour rendre le backtest plus realiste:

- tri temporel,
- suivi cash/equity,
- drawdown,
- distinction partielle signal/execution,
- sauvegarde de rapports JSON.

La V3 doit clairement repartir de cette direction, pas du backtester V1.

### `Cache`

Le cache V2 est simple mais sain dans son principe:

- serialisation sur disque,
- separation par type,
- nettoyage des vieux fichiers.

La V3 doit garder:

- un cache disque,
- des cles stables,
- une distinction par provider/type/timeframe,
- une politique d'expiration explicite.

### `DataCatcher`

Le module a deja porte plusieurs besoins utiles:

- chargement de bars Alpaca,
- aggregation en `4h`,
- fallback reseau,
- lecture historique.

La V3 doit le remplacer par un service plus explicite, mais l'idee est bonne.

### `Reporter`

La V2 a correctement pousse vers des rapports JSON de run.
Le design est encore trop brut, mais le principe est essentiel:

- les runs doivent laisser une trace exploitable,
- les batchs et backtests ne doivent pas vivre seulement dans la console.

### `Strategy`

La base strategy V2 a plusieurs intuitions justes:

- helpers d'indicateurs,
- analyse historique,
- telemetrie,
- markers d'entree/sortie,
- couche commune live/backtest.

La V3 doit garder ce role de socle commun.

### `Analyse`

Les indicateurs de base sont deja presents:

- SMA
- EMA
- RSI
- ATR
- WMA
- MACD
- stdev

La V3 doit les remettre dans un module plus strict et mieux teste.

### `MarketHours`

C'est une des briques les plus importantes a conserver conceptuellement.
La V2 a bien identifie le sujet critique:

- timezone source,
- timezone d'affichage,
- regular vs extended,
- preclose,
- no-trade-open,
- DST.

La V3 doit centraliser tout raisonnement de session ici.

### `AlpacaApi`

La V2 a deja capture des besoins reels:

- mode `paper/live`,
- classification des erreurs d'ordre,
- stops broker,
- recuperation portfolio/positions,
- separation partielle data/broker.

La V3 doit garder ces idees dans une facade plus petite, plus nette, plus testable.

## 6. Briques V2 a ne pas recopier telles quelles

### `App.mjs`

Le fichier a fini par concentrer trop de responsabilites:

- CLI modes
- runtime live
- GUI
- registry strategies
- state UI
- config symboles
- websocket
- portfolio
- helpers de serialization UI

La V3 doit eviter ce centre de gravite unique.

### Multiplication de strategies special-cases

La V2 contient beaucoup de classes de strategies:

- `CodexBear*`
- `AdaptableBear*`
- `CodexFree*`
- strategies historiques `SMA/EMA/...`

Plusieurs de ces strategies sont surtout des branches d'experimentation.
La V3 doit preferer:

- une base strategique forte,
- un moteur de features,
- un moteur de decision interchangeable,
- peu de classes specialisees.

### Proliferation per-symbol

La V2 est allee loin dans le tuning et les variantes par symbole.
Utile pour explorer.
Dangereux comme fondation.

Lecon:

- la personnalisation par symbole doit rester de la configuration,
- pas devenir une explosion de logique metier.

### Melange des couches

On retrouve dans la V2 plusieurs melanges peu sains:

- broker + data feed
- logique strategie + logique UI
- runtime + debug instrumentation
- recherche + production

La V3 doit rendre ces frontieres explicites.

## 7. Sujet tres important: temps, timezone, session

La V2 a explicitement documente un probleme recurrent:

- certains reports etaient raisonnes depuis la France,
- le marche concerne etait le marche US,
- les decalages DST US / Europe changeaient selon les dates.

Lecon ferme pour la V3:

- tout stocker en UTC en interne,
- ne jamais raisonner une session de marche a partir d'horaires "memorises",
- ne jamais disperser la logique de session dans les strategies.

## 8. Sujet important: realisme du backtest

La V1 etait tres naive.
La V2 a commence a corriger cela.
La V3 devra aller plus loin.

Il faut garder en tete la separation suivante:

- `signal`
- `decision`
- `intent ordre`
- `execution`
- `portfolio`
- `report`

Point trading important:
si le backtest recompense des comportements impossibles a executer en vrai, toute la boucle de recherche devient trompeuse.

## 9. Sujet important: `CodexFree` et labo microstructure

La V2 a beaucoup explore les familles `CodexFree` et les labos microstructure.
La lecture globale montre:

- beaucoup d'energie investie,
- des outils de recherche de plus en plus riches,
- mais pas encore de candidat robuste promouvable.

Lecon cle:

- les experiments ont valide la valeur du laboratoire,
- mais ils ont aussi montre les limites d'une sur-optimisation de patterns heuristiques.

Pour la V3, cela pousse vers un autre angle:

- un moteur de features plus generique,
- un moteur de decision plus abstrait,
- des comparaisons plus reproductibles,
- moins de strategie-code "par idee locale".

## 10. Ce que la V2 a deja suggere pour la V3

Plusieurs intuitions de la V2 vont dans le bon sens pour la future V3:

- config par symbole
- reports JSON systematiques
- batch tests reproductibles
- walk-forward simple
- garde-fous de risque
- metrics de drawdown et de winrate
- historisation des runs de tuning

La V3 doit conserver cette discipline, mais sur une base plus propre.

## 11. Positionnement specifique de la V3

La V3 ne doit pas etre une V2 "plus grosse".
Elle doit etre une V2 "plus simple et plus profonde".

Cible V3 observee d'apres le brief utilisateur:

- server only au depart
- long only
- calcul d'indicateurs multi-timeframes
- contexte sur symbole principal + symboles lies
- aggregation courte au tick
- decision par petit LLM
- confiance associee a la decision
- capacite d'apprentissage ou d'amelioration automatisee, mais encadree

## 12. Point critique: le LLM n'est pas le coeur de la fiabilite

La V3 vise un petit modele de type `llama3.1-8b` ou equivalent leger, potentiellement quantize, avec une contrainte de taille inferieure a `1 Go`.

Lecon importante a conserver:

- si les features sont faibles, le LLM ne sauvera pas le systeme,
- si le backtest est faux, le LLM donnera de faux signaux convaincants,
- si la telemetrie est pauvre, il sera difficile de comprendre les echecs.

Le LLM doit donc etre pense comme:

- une couche de synthese,
- une couche de scoring/decision,
- pas comme un substitut a l'architecture.

## 13. Point critique: auto-entrainement

Le souhait d'auto-entrainement est legitime, mais tres sensible.

Risque principal:

- sur-apprentissage sur les derniers runs,
- derives silencieuses,
- promotion de comportements opportunistes sur des datasets trop petits.

Posture recommandee pour la V3:

- automatiser d'abord l'evaluation,
- automatiser la comparaison de variantes,
- conserver tous les exemples et decisions,
- separer entrainement offline et execution live,
- ne jamais laisser le modele modifier seul le runtime live sans validation.

## 14. Point critique: Alpaca et API externes

Notes utiles pour les prochaines iterations:

- `Alpaca` distingue broker et data endpoints
- le mode `paper` doit etre la base de travail
- les erreurs d'ordre doivent etre normalisees
- les stops et fermetures forcees doivent etre idempotents
- l'etat local peut diverger du broker, il faut donc prevoir resynchronisation et audit

Point trading important:
en environnement broker, l'absence d'erreur explicite ne signifie pas toujours que l'etat local est correct.
Il faut journaliser les intentions, les ordres envoyes, les reponses et l'etat confirme.

## 15. Process de travail attendu pour la V3

Le souhait utilisateur est une forte autonomie sur:

- developpement,
- tests,
- backtesting,
- iteration,
- validation.

Cela doit devenir une convention explicite du projet.

Workflow cible d'une iteration:

1. Comprendre la brique touchee.
2. Modifier le code.
3. Executer tests et validations locales.
4. Lancer un backtest ou replay pertinent si la strategie ou l'execution sont touches.
5. Produire un rapport.
6. Comparer avec une baseline.
7. Resumer les impacts et risques restants.

## 16. Resume de conservation pour la V3

### A garder

- les noms de concepts `Cache`, `Report`, `Strategy`, `Analyse`
- l'idee d'un `BackTester` realiste
- la gestion centralisee des sessions de marche
- l'idee d'une config par symbole
- les rapports JSON de batch/run

### A simplifier

- Alpaca
- runtime
- structure du projet
- registry des strategies
- flux de telemetrie

### A jeter ou redessiner

- monolithes applicatifs
- strategie-code trop specialisee par symbole
- logique UI/audio dans le socle serveur
- melanges timezone implicites
- tuning sans protocole clair

## 17. Hypothese forte pour la suite

La meilleure trajectoire pour la V3 est:

- peu de modules, bien delimites,
- forte discipline de donnees et de temps,
- un moteur de features riche,
- un moteur de decision petit mais explicable,
- une boucle de recherche largement automatisee,
- une memoire de run solide.

En bref:
la V1 a valide l'envie d'autonomie.
La V2 a valide les bonnes briques et expose les dettes.
La V3 doit transformer ces apprentissages en fondation propre.

## 18. Etat courant reel de la V3

La V3 n'est plus seulement un cadrage.
Elle dispose deja d'un socle serveur utilisable avec:

- config centralisee
- cache disque
- provider market data Alpaca
- broker Alpaca
- portfolio service
- feature snapshots multi-timeframes
- indicateurs techniques
- decision engine LLM
- execution engine
- runtime persistant
- reports journaliers runtime
- reports wake-up journaliers
- backtests et batches
- reporter HTML/CSS/JS vanilla

Deux modes de lancement sont maintenant dissocies:

- `npm start` / `npm run start:classic`
  - panier classic actions
  - `AAPL`, `TGT`, `CVX`
- `npm run start:crypto`
  - panier crypto
  - `BTC/USD`, `ETH/USD`, `SOL/USD`

Important:
le fichier `server/storage/configs/runtime.json` peut porter un panier par defaut different, mais les scripts npm de lancement restent la source operative la plus simple pour distinguer classic et crypto.

## 19. Lecons live recentes sur les reports

Les reports les plus instructifs a ce stade sont:

- `runtime-report-2026-04-02.json`
- `runtime-report-2026-04-03.json`
- `runtime-report-2026-04-07.json`
- `daily-report-2026-04-07.json`
- `daily-report-2026-04-08.json`

Lecture utile:

### `2026-04-02`

Zero trade, mais pour une raison d'infrastructure LLM:

- le runtime tournait,
- le moteur n'etait pas muet,
- le modele local n'etait pas disponible,
- les decisions tombaient donc en `skip/noop`.

Lecon:
ce type de jour ne doit pas etre interprete comme un echec de strategie.
C'est un echec de disponibilite du composant decisionnel.

### `2026-04-03`

Ce report a surtout servi a detecter un probleme de calendrier/session:

- le marche actions US etait ferme,
- notre calendrier interne ne l'avait pas encore correctement gate,
- le systeme pouvait donc raisonner a tort comme si une session reguliere existait.

Ce point a depuis ete corrige.

Lecon:
un report live peut parfois exposer un bug d'architecture plus qu'un signal trading.

### `2026-04-07`

C'est le premier report vraiment utile pour juger la boucle live classic.
On y a vu:

- `AAPL`: `2` tentatives d'ouverture
- `TGT`: `8` tentatives d'ouverture
- `CVX`: `9` tentatives d'ouverture

Toutes ont ete rejetees, d'abord a cause d'un probleme broker:

- `fractional orders must be DAY orders`

Mais ce report a surtout montre autre chose:

- le LLM etait bien actif
- il etait parfois trop permissif
- il pouvait reproposer plusieurs fois une ouverture tres proche d'un tick a l'autre
- certaines ouvertures etaient proposees dans des contextes deja trop "chauds"

Lecon centrale:
la V3 avait besoin d'un garde-fou deterministe entre le LLM et l'execution.

## 20. Corrections et upgrades recentes a memoriser

### Correction broker actions fractionnaires + stop simple

Le chemin d'ouverture actions avec `brokerProtection.simpleStopLossPct` a ete corrige:

- un ordre protege cote broker ne peut pas rester fractionnaire dans notre mode actuel
- l'execution convertit donc les entrees protegees en quantites entieres
- si le notionnel ne permet pas au moins `1` action entiere, l'ouverture est refusee proprement

Lecon trading/API:
les contraintes broker sur `time_in_force`, fractions et wrappers d'ordres doivent etre traitees comme des contraintes de premier niveau, pas comme un detail d'implementation.

### Garde-fou heuristique live

Une nouvelle brique existe maintenant:

- `server/src/core/strategy/HeuristicEntryPolicy.mjs`

Son role:

- laisser le LLM proposer une ouverture,
- mais repasser chaque `open_long` dans le moteur heuristique profile,
- bloquer les ouvertures que le moteur heuristique juge trop faibles ou trop chaudes,
- reduire la taille si le LLM est plus agressif que l'heuristique.

Lecon:
le LLM reste une couche de synthese et de contexte.
La discipline d'entree live doit rester ancree dans une logique deterministe backtestable.

### Cooldown apres rejet d'ouverture

Une protection a ete ajoutee dans `StrategyInstance`:

- apres un rejet broker sur `open_long`,
- le systeme attend un delai de cooldown avant de reproposer une nouvelle ouverture.

Objectif:

- eviter le spam d'ouvertures quasi identiques tick apres tick,
- eviter de reconsommer inutilement du capital mental et du bruit dans les reports,
- rendre les blockers broker plus lisibles.

### Retuning `AAPL`

Le profil `single_stock_quality` de `AAPL` a ete resserre:

- related trend un peu plus exigeant
- tolerance moindre sur medium RSI trop chaud
- protection anti-chase un peu plus forte
- taille maximale legerement reduite

But:

- garder `AAPL` tradable,
- mais eviter les ouvertures quality trop tardives ou trop molles.

## 21. Etat trading/backtest memoriser

Batch classic de reference observe sur la fenetre:

- `2026-03-07` -> `2026-04-07`
- step `30m`
- panier `AAPL`, `TGT`, `CVX`

Avant retuning recent:

- batch `batch-1775631560135.json`
- aggregate net PnL: `+2.86`
- `AAPL`: `-58.86`
- `TGT`: `+28.93`
- `CVX`: `+32.79`

Apres retuning recent:

- batch `batch-1775632047554.json`
- aggregate net PnL: `+82.18`
- `AAPL`: `+20.46`
- `TGT`: `+28.93`
- `CVX`: `+32.79`
- trades: `22 -> 16`
- cost drag: `70.00 -> 49.05`

Lecture utile:

- `TGT` reste un consumer quality exploitable
- `CVX` reste correct mais demande vigilance sur les setups momentum trop tardifs
- `AAPL` etait la jambe faible du panier classic
- le retuning recent l'a ramenee dans une zone plus saine sans casser le reste

## 22. Etat crypto a memoriser

La V3 supporte maintenant aussi la crypto via Alpaca:

- `BTC/USD`
- `ETH/USD`
- `SOL/USD`

Differences importantes par rapport aux actions:

- marche `24/7`
- session `continuous_open`
- data Alpaca crypto sur endpoints dedies
- pas de stop loss simple broker cote crypto dans la version actuelle
- execution en `market + gtc`

Le panier crypto a deja une premiere baseline backtestable.
Il doit cependant etre pense avec:

- profils de risque distincts des actions
- sizing plus petit
- vigilance particuliere sur la latence LLM et les timings de boucle

## 23. Positionnement architectural a conserver pour la suite

La meilleure lecture des derniers echanges est la suivante:

- la V3 n'a pas besoin de plus de "magie"
- elle a besoin de plus de coherence entre backtest et live

Donc, pour les prochaines iterations:

- toute nouvelle ouverture live importante devrait pouvoir etre expliquee par un contexte deterministe minimal
- tout assouplissement d'entree doit etre compare a une baseline batch
- tout nouveau symbole doit d'abord passer par:
  - profile de base
  - regles eventuelles par symbole
  - validation batch/replay
  - seulement ensuite paper trading

## 24. Resume operatoire

Aujourd'hui, la V3 doit etre vue comme:

- un runtime paper/backtest deja fonctionnel
- un systeme encore experimental cote strategie
- un systeme deja assez propre cote architecture
- un systeme ou les blockers les plus dangereux sont:
  - disponibilite LLM
  - contraintes broker reelles
  - calendrier/session
  - ecart entre logique live et logique backtest

La direction saine n'est pas d'augmenter la complexite.
La direction saine est:

- renforcer les garde-fous
- conserver des reports riches
- retuner symbole par symbole quand c'est justifie
- ne jamais laisser le LLM devenir la seule source de discipline
