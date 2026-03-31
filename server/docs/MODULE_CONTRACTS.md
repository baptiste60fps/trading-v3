# MODULE CONTRACTS

Ce document definit le contrat minimal des modules centraux du serveur V3.
Le but n'est pas de figer une API finale mot a mot, mais de verrouiller les frontieres importantes avant implementation.

## 1. Regles transverses

### Temps

- Tous les timestamps internes sont en UTC.
- Le format canonique recommande est `epoch ms`.
- Toute conversion timezone doit etre centralisee dans `core/market`.

### Strategie

- Une strategie ne produit pas un ordre broker.
- Une strategie produit une `DecisionIntent`.
- La traduction en execution appartient a une couche dediee.

### LLM

- Le LLM ne recoit jamais l'etat brut entier du systeme.
- Il recoit un `DecisionContext` compact et stable.
- Le LLM doit renvoyer un schema parseable, pas du texte libre non contraint.

### Backtest

- Le backtest doit reutiliser les memes contrats de strategie que le live.
- Les differences live/backtest doivent etre dans les adapters et dans l'execution.

### Reports

- Chaque run important doit laisser une trace JSON.
- Un report doit etre lisible sans console supplementaire.

## 2. Types centraux minimaux

Notation pseudo-TypeScript pour clarifier les attentes.

```ts
type SymbolId = string;
type EpochMs = number;
type Confidence = number; // 0 -> 1

type RuntimeMode = 'backtest' | 'replay' | 'paper' | 'live';
type DecisionAction = 'open_long' | 'hold' | 'close_long' | 'skip';
type PositionSide = 'long';

interface Bar {
  symbol: SymbolId;
  timeframe: string;
  startMs: EpochMs;
  endMs: EpochMs;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  tradeCount?: number | null;
  source: string;
}

interface PositionState {
  symbol: SymbolId;
  side: PositionSide;
  qty: number;
  entryPrice: number;
  openedAtMs: EpochMs;
  stopPrice?: number | null;
  unrealizedPnl?: number | null;
}

interface IndicatorSnapshot {
  symbol: SymbolId;
  timeframe: string;
  atMs: EpochMs;
  values: Record<string, number>;
}

interface RelatedSymbolSnapshot {
  symbol: SymbolId;
  relation: string;
  timeframes: Record<string, IndicatorSnapshot>;
}

interface FeatureSnapshot {
  symbol: SymbolId;
  atMs: EpochMs;
  runtimeMode: RuntimeMode;
  currentPrice: number;
  shortBars: Bar[];
  timeframes: Record<string, IndicatorSnapshot>;
  relatedSymbols: RelatedSymbolSnapshot[];
  marketState: {
    isOpen: boolean;
    isPreClose: boolean;
    isNoTradeOpen: boolean;
    sessionLabel: string;
  };
  portfolioState: {
    cash: number;
    equity: number;
    exposurePct: number;
  };
  position: PositionState | null;
  riskState: {
    canOpen: boolean;
    canClose: boolean;
    flags: string[];
  };
}

interface DecisionContext {
  symbol: SymbolId;
  atMs: EpochMs;
  features: FeatureSnapshot;
  strategyConfig: Record<string, unknown>;
}

interface DecisionIntent {
  action: DecisionAction;
  confidence: Confidence;
  reasoning: string[];
  requestedSizePct?: number | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
}

interface ExecutionIntent {
  symbol: SymbolId;
  action: DecisionAction;
  side: PositionSide;
  qty?: number | null;
  notional?: number | null;
  requestedAtMs: EpochMs;
  metadata?: Record<string, unknown>;
}

interface ExecutionResult {
  accepted: boolean;
  brokerOrderId?: string | null;
  filledQty?: number | null;
  avgFillPrice?: number | null;
  status: string;
  error?: {
    code?: string | null;
    category: string;
    message: string;
  } | null;
}
```

## 3. `AppRuntime`

### Role

Orchestration racine du serveur.

### Responsabilites

- charger la config
- instancier les services
- choisir le mode
- demarrer et arreter proprement

### Entrees

- env
- config projet
- mode runtime

### Sorties

- runtime demarre
- erreurs de bootstrap explicites

### Ne doit pas

- contenir la logique d'indicateurs
- contenir la logique de strategie
- parser directement les reponses LLM

## 4. `ConfigStore`

### Role

Fournir une configuration centralisee et validee.

### Responsabilites

- charger les fichiers de config
- fusionner avec l'environnement
- exposer une config immutable a l'execution

### Contrat minimal

```ts
interface ConfigStore {
  load(): Promise<void>;
  getRuntimeConfig(): RuntimeConfig;
  getSymbolConfig(symbol: SymbolId): SymbolRuntimeConfig;
  getRelatedSymbols(symbol: SymbolId): RelatedSymbolConfig[];
}
```

### Ne doit pas

- parler au broker
- charger les historiques

## 5. `MarketCalendar`

### Role

Centraliser tout raisonnement de marche et de temps.

### Responsabilites

- evaluation de session
- preclose
- no-trade-open
- resolution des timeframes

### Contrat minimal

```ts
interface MarketCalendar {
  getMarketState(atMs: EpochMs, symbol: SymbolId): {
    isOpen: boolean;
    isPreClose: boolean;
    isNoTradeOpen: boolean;
    sessionLabel: string;
  };
}
```

### Ne doit pas

- contenir de logique strategie
- dependre du LLM

## 6. `CacheStore`

### Role

Persister et relire des donnees derivees ou telechargees.

### Responsabilites

- key-value disque
- TTL
- namespaces
- invalidation simple

### Contrat minimal

```ts
interface CacheStore {
  get<T>(namespace: string, key: string): Promise<T | null>;
  set<T>(namespace: string, key: string, value: T, ttlMs?: number): Promise<void>;
  has(namespace: string, key: string): Promise<boolean>;
  delete(namespace: string, key: string): Promise<void>;
}
```

### Ne doit pas

- connaitre la structure metier de tous les objets

## 7. `MarketDataProvider`

### Role

Fournir les donnees de marche normalisees.

### Responsabilites

- historiques de bars
- dernier prix
- eventuel stream tick/trade

### Contrat minimal

```ts
interface MarketDataProvider {
  getBars(input: {
    symbol: SymbolId;
    timeframe: string;
    startMs: EpochMs;
    endMs: EpochMs;
    limit?: number;
  }): Promise<Bar[]>;

  getLatestPrice(symbol: SymbolId): Promise<{
    symbol: SymbolId;
    price: number;
    atMs: EpochMs;
  } | null>;
}
```

### Ne doit pas

- envoyer des ordres
- connaitre la strategie

## 8. `BrokerGateway`

### Role

Facade d'execution vers le broker.

### Responsabilites

- lire compte et positions
- soumettre, fermer, annuler
- normaliser les erreurs broker

### Contrat minimal

```ts
interface BrokerGateway {
  getAccountState(): Promise<{
    cash: number;
    equity: number;
    buyingPower?: number | null;
  }>;

  getOpenPosition(symbol: SymbolId): Promise<PositionState | null>;

  submit(intent: ExecutionIntent): Promise<ExecutionResult>;
  close(symbol: SymbolId): Promise<ExecutionResult>;
}
```

### Ne doit pas

- decider si un trade est bon
- calculer les indicateurs

## 9. `BarsRepository`

### Role

Couche d'acces historique utilisant `MarketDataProvider` + `CacheStore`.

### Responsabilites

- fetch
- cache
- aggregation courte si necessaire
- normalisation des bars

### Contrat minimal

```ts
interface BarsRepository {
  getBars(input: {
    symbol: SymbolId;
    timeframe: string;
    startMs: EpochMs;
    endMs: EpochMs;
    preferCache?: boolean;
  }): Promise<Bar[]>;
}
```

## 10. `IndicatorEngine`

### Role

Calcul pur des indicateurs a partir de bars.

### Responsabilites

- SMA
- EMA
- RSI
- ATR
- stdev
- slopes
- autres derivees retenues

### Contrat minimal

```ts
interface IndicatorEngine {
  compute(input: {
    symbol: SymbolId;
    timeframe: string;
    bars: Bar[];
    atMs: EpochMs;
  }): IndicatorSnapshot;
}
```

### Ne doit pas

- lire le broker
- connaitre le portefeuille

## 11. `FeatureSnapshotService`

### Role

Assembler le snapshot compact consomme par la strategie et par le LLM.

### Responsabilites

- symbole principal
- symboles lies
- timeframes multiples
- etat marche
- etat portefeuille
- etat position

### Contrat minimal

```ts
interface FeatureSnapshotService {
  build(input: {
    symbol: SymbolId;
    atMs: EpochMs;
    runtimeMode: RuntimeMode;
  }): Promise<FeatureSnapshot>;
}
```

### Ne doit pas

- appeler directement le LLM
- soumettre d'ordres

## 12. `DecisionEngine`

### Role

Transformer un `DecisionContext` en `DecisionIntent`.

### Responsabilites

- construire la requete modele
- appeler le provider LLM
- parser la reponse
- normaliser la confiance
- gerer les erreurs et fallback

### Contrat minimal

```ts
interface DecisionEngine {
  decide(context: DecisionContext): Promise<DecisionIntent>;
}
```

### Regle forte

Si le LLM renvoie une reponse invalide:

- pas de crash
- fallback explicite
- report d'erreur
- `skip` ou `hold` par defaut selon contexte

## 13. `StrategyInstance`

### Role

Porter le cycle de vie d'une strategie instanciee pour un symbole.

### Responsabilites

- warmup initial
- evaluation reguliere
- appel a `FeatureSnapshotService`
- appel a `DecisionEngine`
- emission d'un `ExecutionIntent` seulement si autorise

### Contrat minimal

```ts
interface StrategyInstance {
  warmup(): Promise<void>;
  evaluate(atMs: EpochMs): Promise<{
    features: FeatureSnapshot;
    decision: DecisionIntent;
    executionIntent: ExecutionIntent | null;
  }>;
  getState(): {
    symbol: SymbolId;
    warmedUp: boolean;
    lastEvaluationMs?: EpochMs | null;
  };
}
```

### Ne doit pas

- parler directement a Alpaca
- ecrire directement les reports

## 14. `PortfolioService`

### Role

Fournir un etat portefeuille coheremment normalise.

### Responsabilites

- cash
- equity
- positions
- exposition
- risque d'ouverture

### Contrat minimal

```ts
interface PortfolioService {
  getSnapshot(): Promise<{
    cash: number;
    equity: number;
    positions: PositionState[];
    exposurePct: number;
  }>;

  canOpenLong(symbol: SymbolId, requestedNotional: number): Promise<{
    allowed: boolean;
    reason?: string | null;
    adjustedNotional?: number | null;
  }>;
}
```

## 15. `ExecutionEngine`

### Role

Traduire une decision en execution reelle ou simulee.

### Responsabilites

- appliquer les garde-fous
- traduire `DecisionIntent` vers `ExecutionIntent`
- choisir broker ou simulateur
- renvoyer un resultat normalise

### Contrat minimal

```ts
interface ExecutionEngine {
  execute(intent: ExecutionIntent): Promise<ExecutionResult>;
}
```

### Regle forte

L'engine d'execution est le dernier endroit ou refuser un ordre avant emission.

## 16. `BacktestEngine`

### Role

Rejouer un dataset avec les memes contrats que le live.

### Responsabilites

- scheduler sur bar/tick
- simulation fills
- suivi portefeuille
- metrics
- export de run

### Contrat minimal

```ts
interface BacktestEngine {
  run(input: {
    symbol: SymbolId;
    datasetId: string;
    strategyFactory: () => Promise<StrategyInstance> | StrategyInstance;
  }): Promise<{
    summary: {
      gain: number;
      winRate: number;
      maxDrawdown: number;
      operations: number;
    };
    artifacts: {
      reportId: string;
      runId: string;
    };
  }>;
}
```

## 17. `ReportStore`

### Role

Ecrire et relire les artefacts de run.

### Responsabilites

- reports JSON
- index des runs
- comparaison de versions si ajoutee plus tard

### Contrat minimal

```ts
interface ReportStore {
  writeRunReport(payload: unknown): Promise<{ reportId: string; path: string }>;
  writeRunMetadata(payload: unknown): Promise<{ runId: string; path: string }>;
}
```

## 18. `TelemetrySink`

### Role

Collecter des evenements structures.

### Responsabilites

- decisions
- erreurs
- fills
- snapshots utiles

### Contrat minimal

```ts
interface TelemetrySink {
  emit(event: {
    type: string;
    atMs: EpochMs;
    symbol?: SymbolId;
    payload: Record<string, unknown>;
  }): Promise<void> | void;
}
```

## 19. Sequence minimale d'un cycle runtime

```text
Runtime
  -> StrategyInstance.evaluate()
    -> FeatureSnapshotService.build()
      -> BarsRepository.getBars()
      -> IndicatorEngine.compute()
      -> PortfolioService.getSnapshot()
      -> MarketCalendar.getMarketState()
    -> DecisionEngine.decide()
    -> build ExecutionIntent
  -> ExecutionEngine.execute()
  -> ReportStore.writeRunReport(...)
  -> TelemetrySink.emit(...)
```

## 20. Frontieres a proteger absolument

- `StrategyInstance` ne depend pas d'un SDK Alpaca concret.
- `DecisionEngine` ne depend pas du format brut du broker.
- `IndicatorEngine` est pur.
- `BacktestEngine` et `ExecutionEngine` partagent les memes `ExecutionIntent`.
- `ReportStore` n'invente pas de logique strategie.

## 21. Priorite d'implementation

Si l'on veut aller vite sans recreer le chaos de la V2, il faut implementer d'abord:

1. `ConfigStore`
2. `MarketCalendar`
3. `CacheStore`
4. `MarketDataProvider` + `BarsRepository`
5. `IndicatorEngine`
6. `PortfolioService`
7. `FeatureSnapshotService`
8. `DecisionEngine`
9. `StrategyInstance`
10. `ExecutionEngine`
11. `BacktestEngine`
12. `ReportStore`

Ce contrat doit servir de reference pendant les prochaines iterations.
Si un module futur viole une de ces frontieres, il faudra explicitement justifier pourquoi.
