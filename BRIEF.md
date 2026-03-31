# BRIEF

Ce document cadre `baptisto-trading-v3` avant tout developpement.

## 1. Intention generale

`baptisto-trading-v3` doit repartir d'une base vide en conservant seulement l'esprit utile de `baptisto-trading-v2` cote server:

- une structure serveur propre et modulaire,
- un systeme de `Cache`,
- un systeme de `Report`,
- une base `Strategy`,
- des outils d'`Analyse`,
- une integration `Alpaca` plus simple, plus robuste, plus testable.

La V3 ne doit pas recopier la V2 telle quelle.
La V2 a accumule de bonnes briques, mais aussi beaucoup de logique experimentale, de branches laterales et de strategies tres specialisees par symbole.

La V3 doit viser:

- un noyau serveur clair,
- une forte reproductibilite en backtest,
- une parite maximale entre backtest et live,
- un systeme de decision recentre sur des features de marche + un petit modele LLM,
- une iteration autonome et prudente.

## 2. Objectif fonctionnel

Le but cible d'une strategie V3 est:

1. Initialiser un contexte riche sur un symbole principal.
2. Calculer des indicateurs techniques sur environ `10` echelles de temps.
3. Calculer aussi des indicateurs sur des symboles lies au symbole principal.
4. Maintenir en runtime une aggregation de bars courte pour l'evaluation au tick, idealement configurable entre `10s` et `10min`.
5. Envoyer au moteur de decision un contexte structure, compact et stable.
6. Recevoir une decision `long only`:
   - `open`
   - `hold`
   - `close`
   - avec un score de confiance
   - et si possible une justification courte exploitable en logs.

Le systeme ne doit pas gerer le short dans son premier scope.
Le modele ne peut ouvrir que des positions longues.

## 3. Orientation architecture V3

La V3 doit etre `server only` dans un premier temps.
Le front, l'audio et les experiments UX de la V2 sont hors scope initial.

### Modules cibles

- `App` ou `Runtime`
  - orchestration generale
  - modes `backtest`, `paper`, `live`, `replay`
- `Core/API`
  - facade broker/data provider
  - Alpaca simplifie et robuste
- `Core/Data`
  - cache historique
  - recuperation de bars
  - persistence des reports et resultats
- `Core/Market`
  - horaires de marche
  - sessions
  - conversions temporelles
- `Core/Indicators`
  - SMA, EMA, RSI, ATR, stdev, slopes, etc.
- `Core/Backtest`
  - simulation d'execution
  - portfolio engine
  - metrics
- `Core/Strategy`
  - cycle `warmup -> evaluate -> decide -> execute`
- `Core/LLM`
  - abstraction du moteur de decision
  - prompt/context builder
  - parsing de decision
- `storage`
  - cache
  - datasets
  - reports
  - runs
  - configs

## 4. Principes non negociables

### Simplicite

La V3 doit commencer avec peu de concepts.
Chaque nouveau module doit avoir une responsabilite nette.

### UTC en interne

La V2 a souffert de raisonnements melanges entre heure France, heure US, timestamps implicites et DST.
La V3 doit:

- stocker les timestamps internes en UTC,
- convertir vers une timezone d'affichage seulement en sortie,
- centraliser les regles de session de marche.

### Determinisme

Un backtest identique doit produire les memes resultats.
Les rapports de run doivent permettre de rejouer une evaluation et de comparer deux versions.

### Parite backtest/live

La logique de strategie doit etre la meme en live et en backtest.
Le backtest ne doit pas etre une branche "speciale" du code metier.

### Observabilite

Chaque decision importante doit etre loggee avec:

- le symbole,
- la timeframe ou la fenetre,
- les indicateurs cle,
- la decision,
- la confiance,
- la raison,
- les contraintes de risque actives.

## 5. Ce qu'on reprend de la V2

On reprend l'idee des briques suivantes, pas forcement leur code tel quel:

- `Cache`
- `DataCatcher`
- `Reporter`
- `Strategy`
- `Analyse`
- `MarketHours`
- `BackTester`
- configuration par symbole
- scripts de batch et de walk-forward

On reprend aussi une idee cle de la V2:

- la recherche doit produire des artefacts JSON lisibles et comparables,
- pas juste du log console.

## 6. Ce qu'on ne doit pas recopier tel quel

- le `App.mjs` monolithique de la V2
- le registre geant de strategies
- les classes de strategies multipliees par symbole
- les heuristiques trop specialisees et peu transmissibles
- le melange data feed / broker / state / UI dans un meme flux
- les timestamps ambigus
- les campagnes de tuning devenues trop dependantes du dataset du moment

## 7. Vision strategie V3

### Pipeline logique

1. `Warmup`
   - charger les historiques du symbole principal
   - charger les historiques des symboles lies
   - calculer les indicateurs multi-timeframes

2. `State build`
   - construire une vue compacte du contexte courant
   - regime de marche
   - tendance multi-echelles
   - momentum
   - volatilite
   - position courante
   - contraintes de risque

3. `Tick/bar evaluation`
   - agreger les ticks en bars courtes
   - recalculer les features incrementales
   - appeler le moteur de decision

4. `Decision`
   - `open long`
   - `hold`
   - `close`
   - `skip`

5. `Execution`
   - traduire en ordre broker ou simulation
   - enregistrer la decision et le resultat

### Donnees de contexte attendues

Au minimum:

- prix courant
- dernieres bars courtes
- indicateurs multi-timeframes du symbole principal
- indicateurs multi-timeframes des symboles lies
- etat de position
- exposition et risque
- etat de session de marche

### Symboles lies

Le lien entre symboles devra etre explicite et configurable.
Exemples d'usage possibles:

- ETF secteur
- indice large
- actifs leaders du secteur
- proxy de risque

Point trading important:
un symbole "lie" doit aider a contextualiser un regime, pas injecter de fuite d'information.
Il faut donc garder un mapping sobre et justifiable.

## 8. Place du LLM

Le LLM n'est pas le systeme entier.
Il est un moteur de decision au-dessus d'un moteur de features et d'un moteur de risque.

### Contraintes actuelles

- modele leger
- cible inferieure a `1 Go`
- execution sur machines modestes
- performance correcte
- modele exact non fige

### Consequence importante

Il ne faut pas concevoir la V3 comme si un gros modele allait "compenser" un mauvais pipeline.
La qualite de la V3 dependra surtout de:

- la qualite des features,
- la qualite du prompt/contexte,
- la discipline de backtest,
- le schema de decision,
- les garde-fous de risque.

### Auto-entrainement

Le terme "auto-entrainement" devra etre interprete prudemment.
Pour la V3, la bonne premiere approche est probablement:

- collecter toutes les decisions et leurs issues,
- generer des rapports de performance et des contre-exemples,
- construire un corpus d'exemples pour revision,
- tester des variantes de prompt, de contexte ou de petit modele,
- eventuellement plus tard evaluer un fine-tuning leger ou une approche type adapter.

Point trading important:
un apprentissage directement boucle sur les resultats recents risque de sur-apprendre tres vite le bruit du marche.
Le bon niveau d'autonomie est d'abord l'automatisation de l'evaluation, pas l'auto-modification agressive du modele live.

## 9. Notes trading importantes

### Long only

Le systeme ouvre uniquement des positions longues.
Cela simplifie:

- le risque,
- l'execution,
- le broker handling,
- le raisonnement du modele,
- le backtest.

### Multi-timeframe

Les timeframes multiples servent a separer:

- le contexte lent: regime, tendance, biais
- le contexte moyen: structure de marche
- le contexte court: timing d'entree/sortie

### Session US

Le marche US ne doit jamais etre gere avec des heures codees "a la main".
La gestion:

- regular session
- extended hours
- jours feries
- half days
- DST US / Europe

doit etre centralisee.

### Confiance du modele

La confiance ne doit pas etre prise comme une verite.
Elle peut servir a:

- filtrer les decisions faibles
- moduler le sizing dans une phase future
- expliquer pourquoi un trade a ete pris

Mais au debut elle doit surtout etre un signal d'analyse et de debug.

## 10. Notes API externes importantes

### Alpaca

L'integration Alpaca doit separer clairement:

- la data market
- le broker
- le portefeuille
- les ordres

La V2 contenait deja de bonnes intuitions sur:

- le traitement des erreurs d'ordres,
- la distinction `paper/live`,
- les stop orders,
- les garde-fous en cas d'echec API.

La V3 doit conserver cela dans une version plus simple.

### Rate limits et resilence

Le runtime doit tolerer:

- erreurs reseau,
- indisponibilite temporaire,
- timeouts,
- refus broker,
- incoherences entre etat local et etat broker.

## 11. Process de dev autonome attendu

Le process de developpement doit etre fortement autonome.
Pendant les futures iterations, l'agent doit autant que possible:

- lire le code existant avant de modifier,
- implementer les changements,
- executer ses tests,
- lancer ses batch tests,
- produire ses rapports,
- verifier les regressions,
- comparer avant/apres,
- documenter les resultats utiles.

### Standard minimal d'une iteration strategie

Une iteration strategie devrait idealement produire:

- une commande reproductible,
- un rapport JSON,
- une comparaison baseline vs candidate,
- une note sur les risques ou regressions observees.

### Standard minimal d'une iteration infra

Une iteration infra devrait idealement produire:

- des tests unitaires ou d'integration,
- un mini run de validation,
- une note sur l'impact live/backtest.

## 12. Phasage recommande

### Phase 1

Refonder le squelette serveur:

- runtime
- config
- clock / market hours
- cache
- report
- broker/data abstraction

### Phase 2

Refonder le moteur de donnees:

- historique
- multi-timeframe
- related symbols
- schema de features

### Phase 3

Refonder le backtest:

- execution simple mais realiste
- metrics
- replay
- reporting

### Phase 4

Introduire la strategie LLM:

- prompt builder
- decision schema
- confidence
- parsing robuste

### Phase 5

Industrialiser l'experimentation:

- batch
- walk-forward
- comparaison de runs
- corpus d'apprentissage

## 13. Definition of Done initiale

Une premiere base V3 sera consideree saine si:

- le server demarre proprement,
- un backtest simple est reproductible,
- les timestamps sont coherents en UTC,
- le cache et les reports fonctionnent,
- Alpaca est abstrait proprement,
- une strategie peut chauffer ses indicateurs multi-timeframes,
- un moteur de decision peut prendre `open/hold/close` avec confiance,
- les runs produisent des traces exploitables.

## 14. Hypothese de travail pour la suite

La V3 doit d'abord devenir un bon systeme de recherche et d'execution sobre.
Le modele LLM vient ensuite comme une couche de decision specialisee, pas comme un raccourci pour eviter l'architecture ou le backtesting rigoureux.
