# HYBRID DECISION ARCHITECTURE

Ce document decrit l'evolution cible de la couche strategie de `baptisto-trading-v3`.
L'objectif est de sortir d'un mode "LLM central" pour aller vers une architecture hybride:

- des sorties forcees et deterministes,
- une voie d'entree non-LLM tres selective,
- une voie LLM reservee aux cas ambigus,
- un arbitre explicite entre ces politiques.

Le but n'est pas de supprimer le LLM.
Le but est de lui retirer les cas ou il n'apporte pas assez de valeur par rapport au risque, a la latence ou a la variabilite.

## 1. Lecture du systeme actuel

Aujourd'hui, `StrategyInstance` concentre encore plusieurs responsabilites:

- bypass `market gate`,
- sortie `preclose` actions,
- sorties `crypto profit lock`,
- appel LLM,
- cooldown apres rejet broker,
- passage dans le guard heuristique d'entree.

Cette structure fonctionne, mais elle melange:

- les invariants de securite,
- la detection de setup,
- la logique d'arbitrage,
- la logique de fallback.

Consequence:

- la classe grossit,
- les priorites deviennent implicites,
- chaque nouveau cas special rend le systeme plus fragile.

## 2. Objectif architectural

La cible est un pipeline de decision explicite:

```text
FeatureSnapshot
  -> PositionExitPolicy
  -> DeterministicEntryPolicy
  -> LlmDecisionPolicy
  -> DecisionArbiter
  -> ExecutionEngine
```

Principe:

- les sorties forcees passent en premier,
- les entrees "evidentes" non-LLM passent avant le LLM,
- le LLM ne sert que pour les cas non bloques et non evidents,
- l'arbitre garde la priorite de securite et la coherence globale.

## 3. Nouveaux modules cibles

### `PositionExitPolicy`

Role:

- decider d'une sortie forte quand un invariant de securite ou de gestion de position l'exige.

Cas inclus:

- `forced_preclose_exit` sur actions,
- `crypto_profit_lock`,
- `medium_trend_fade`,
- `peak_giveback_lock`,
- futurs `hard invalidation exit` si le setup est casse.

Contrat minimal:

```ts
interface PositionExitPolicy {
  evaluate(context: PolicyContext): Promise<DecisionIntent | null>;
}
```

Regle:

- ne s'execute que si une position est ouverte,
- renvoie soit `close_long`, soit `null`,
- ne parle pas au broker.

### `DeterministicEntryPolicy`

Role:

- detecter un setup long tres haute conviction sans LLM.

Contrat minimal:

```ts
interface DeterministicEntryPolicy {
  evaluate(context: PolicyContext): Promise<DecisionIntent | null>;
}
```

Regle:

- ne s'execute que si aucune position n'est ouverte,
- ne doit jamais ouvrir sur un setup "moyen",
- si le doute existe, renvoyer `null` et laisser le LLM ou `skip` prendre la suite.

### `LlmDecisionPolicy`

Role:

- encapsuler le `DecisionEngine` actuel,
- ne s'executer que si aucune politique precedente n'a tranche.

Contrat minimal:

```ts
interface LlmDecisionPolicy {
  evaluate(context: PolicyContext): Promise<DecisionIntent>;
}
```

Regle:

- ne gere ni le broker ni les exits forcees,
- reste parseable et schema-driven comme aujourd'hui.

### `DecisionArbiter`

Role:

- ordonner les politiques,
- appliquer les priorites,
- laisser une trace explicite de la source de decision.

Contrat minimal:

```ts
interface DecisionArbiter {
  decide(context: PolicyContext): Promise<{
    decision: DecisionIntent;
    source: 'exit_policy' | 'deterministic_entry' | 'llm' | 'market_gate';
  }>;
}
```

Priorite cible:

1. `PositionExitPolicy`
2. `market gate`
3. `DeterministicEntryPolicy`
4. `LlmDecisionPolicy`
5. fallback `skip`

## 4. Type de contexte partage

```ts
interface PolicyContext {
  symbol: string;
  atMs: number;
  runtimeMode: 'backtest' | 'replay' | 'paper' | 'live';
  features: FeatureSnapshot;
  strategyConfig: Record<string, unknown>;
  executionConfig: Record<string, unknown>;
  symbolState?: Record<string, unknown>;
}
```

Important:

- chaque politique travaille sur le meme `FeatureSnapshot`,
- le `symbolState` sert a persister les etats courts utiles comme:
  - cooldown,
  - peak unrealized pnl,
  - dernier pattern accepte,
  - compteurs journaliers.

## 5. Strategie parallele non-LLM

### Intention

Ouvrir sans LLM uniquement quand un pattern `long only` est assez propre pour etre juge "high conviction".

Ce n'est pas une strategie generale.
C'est une strategie d'exception:

- peu de trades,
- tres filtree,
- taille prudente,
- garde-fous forts.

### Premier pattern recommande

Nom propose:

- `trend_pullback_continuation`

Definition cible:

- `4h` haussier:
  - `emaGap12_26 > 0`
  - `priceVsSma20 > 0`
  - `rsi14` sain, pas extremement chaud
- `1h` haussier ou neutre-haussier:
  - pas de degradation forte
  - pas de RSI casse
- `5m` ou `15m` en retracement propre:
  - pullback vers moyenne courte
  - pas de chasse de prix
  - reprise locale du momentum
- `relatedSymbols` au minimum neutres
- volatilite acceptable

Decision produite:

- `open_long`
- `confidence` tres haute
- `requestedSizePct` plus petite que la voie LLM
- `reasoning` stable et compacte
- `signalContext.pattern = trend_pullback_continuation`

### Deuxieme pattern envisageable plus tard

Nom propose:

- `breakout_retest`

Mais il ne faut pas le lancer en meme temps au debut.
Le premier pattern doit etre isole, backteste, puis seulement apres duplique.

## 6. Garde-fous obligatoires pour la voie non-LLM

Une entree non-LLM ne peut partir que si tous les points suivants sont vrais:

- `marketState.isOpen === true`
- `marketState.isNoTradeOpen === false`
- `marketState.isPreClose === false`
- aucune position deja ouverte sur le symbole
- aucune erreur broker recente sous cooldown
- exposition portefeuille en-dessous de la limite
- exposition symbole en-dessous de la limite
- features completes sur `5m`, `1h`, `4h`
- related context non degrade
- pas de surchauffe court terme
- pas de `late chase`
- nombre max de trades par jour non depasse

Garde-fous supplementaires recommandes:

- `maxDeterministicEntriesPerSymbolPerDay = 1`
- `maxDeterministicEntriesPortfolioPerDay = 2 ou 3`
- taille max `50%` de la taille LLM standard
- obligatoire `broker stop loss` sur actions
- sur crypto, sortir via `profit lock / giveback lock`

## 7. Raison metier de cette voie parallele

Le LLM est utile pour:

- interpreter un contexte large,
- arbitrer des signaux contradictoires,
- gerer des cas gris.

Le LLM est moins utile pour:

- valider un setup simple deja quasi mecanique,
- tenir une position trop longtemps sans reactivite,
- reagir a une invalidation evidente.

Donc:

- les entrees deterministes doivent traiter les setups "obvious",
- le LLM doit traiter les setups "interpretative".

## 8. Integration avec l'existant

### Reutilisation directe

- `FeatureSnapshotService`
- `ExecutionEngine`
- `PortfolioService`
- `RuntimeSessionStateStore`
- `SimpleRuleDecisionEngine` comme base de logique pattern

### Evolution de `HeuristicEntryPolicy`

Aujourd'hui, `HeuristicEntryPolicy` agit surtout comme un guard devant le LLM.

Evolution recommandee:

- garder `HeuristicEntryPolicy` comme guard,
- creer un vrai `DeterministicEntryPolicy` a cote,
- factoriser la logique partagee de pattern dans un service commun, par exemple:
  - `PatternSignalEngine`

### Nouveau partage logique recommande

```text
PatternSignalEngine
  -> evaluateTrendPullbackContinuation()
  -> evaluateBreakoutRetest()

HeuristicEntryPolicy
  -> utilise PatternSignalEngine pour filtrer le LLM

DeterministicEntryPolicy
  -> utilise PatternSignalEngine pour ouvrir sans LLM
```

Ainsi:

- pas de duplication des regles,
- meme logique utilisee en backtest et en live,
- tuning centralise.

## 9. Roadmap de mise en oeuvre

### Phase 1

- extraire `PositionExitPolicy` depuis `StrategyInstance`
- extraire `LlmDecisionPolicy`
- ajouter `DecisionArbiter`

Objectif:

- rendre les priorites explicites sans changer encore le comportement.

### Phase 2

- introduire `PatternSignalEngine`
- brancher `HeuristicEntryPolicy` dessus

Objectif:

- aligner le guard actuel avec le futur moteur d'entree deterministe.

### Phase 3

- implementer `DeterministicEntryPolicy`
- activer uniquement `trend_pullback_continuation`
- mode `high_confidence_only`

Objectif:

- produire les premiers `open_long` non-LLM tres filtres.

### Phase 4

- backtests dedies:
  - deterministic only
  - llm only
  - hybrid
- comparer:
  - nombre de trades
  - net PnL
  - cost drag
  - drawdown
  - retention des gains

### Phase 5

- ajouter comptage de pattern dans les reports
- ajouter dans la console:
  - source de decision
  - pattern accepte ou refuse
  - raison de blocage principale

## 10. Reporting attendu

Les reports runtime/backtest doivent gagner les champs suivants:

- `decisionSource`
  - `exit_policy`
  - `deterministic_entry`
  - `llm`
  - `market_gate`
- `patternName`
- `patternConfidence`
- `patternGateFailures`
- `symbolState`
  - peak profit
  - trades today
  - cooldowns actifs

But:

- comprendre pourquoi on a ouvert,
- comprendre pourquoi on n'a pas ouvert,
- comparer proprement la voie LLM et la voie non-LLM.

## 11. Recommendation immediate

La meilleure suite n'est pas de coder plusieurs patterns.

La meilleure suite est:

1. extraire la logique de priorite hors de `StrategyInstance`
2. stabiliser `DecisionArbiter`
3. implementer un seul pattern deterministe
4. activer par configuration seulement sur un petit panier

Panier initial recommande:

- `AAPL`
- `TGT`
- `BTC/USD`
- `ETH/USD`

Et pas plus au debut.
