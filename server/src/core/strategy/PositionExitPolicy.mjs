const toFiniteOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export class PositionExitPolicy {
  async evaluate({
    symbol,
    features,
    executionConfig = {},
    symbolState = {},
  } = {}) {
    if (this.#shouldForcePreCloseExit(features)) {
      return this.#buildPreCloseExitDecision({ symbol, features });
    }

    const cryptoExitDecision = this.#resolveForcedCryptoProfitExitDecision({
      symbol,
      features,
      executionConfig,
      symbolState,
    });
    if (cryptoExitDecision) {
      return cryptoExitDecision;
    }

    return null;
  }

  #shouldForcePreCloseExit(features) {
    const marketState = features?.marketState ?? {};
    const position = features?.position ?? null;
    const assetClass = String(features?.assetClass ?? '').trim().toLowerCase();
    return Boolean(position) && assetClass !== 'crypto' && marketState.isPreClose === true;
  }

  #buildPreCloseExitDecision({ symbol, features }) {
    return {
      action: 'close_long',
      confidence: 0.92,
      reasoning: ['forced_preclose_exit', features?.marketState?.sessionLabel ?? 'preclose_window'],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext: {
        symbol,
        assetClass: features?.assetClass ?? null,
        marketSession: features?.marketState?.sessionLabel ?? null,
        forcedPreCloseExit: true,
      },
    };
  }

  #resolveForcedCryptoProfitExitDecision({
    symbol,
    features,
    executionConfig,
    symbolState,
  }) {
    const position = features?.position ?? null;
    const assetClass = String(features?.assetClass ?? '').trim().toLowerCase();
    if (!position || assetClass !== 'crypto') return null;

    const profitLock = executionConfig?.cryptoProfitLock ?? {};
    if (profitLock?.enabled === false) return null;

    const entryPrice = Number(position?.entryPrice);
    const currentPrice = Number(features?.currentPrice ?? position?.currentPrice);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(currentPrice) || entryPrice <= 0) return null;

    const unrealizedPnlPct = (currentPrice - entryPrice) / entryPrice;
    const minUnrealizedPnlPct = Number(profitLock?.minUnrealizedPnlPct);
    if (!Number.isFinite(minUnrealizedPnlPct) || unrealizedPnlPct < minUnrealizedPnlPct) return null;

    const fast = features?.timeframes?.['5m']?.values ?? {};
    const medium = features?.timeframes?.['1h']?.values ?? {};

    if (this.#matchesCryptoFastOverboughtRollover({ profitLock, fast })) {
      return this.#buildCryptoProfitLockExitDecision({
        symbol,
        features,
        unrealizedPnlPct,
        mode: 'fast_overbought_rollover',
        symbolState,
      });
    }

    if (this.#matchesCryptoMediumTrendFade({
      profitLock,
      unrealizedPnlPct,
      fast,
      medium,
    })) {
      return this.#buildCryptoProfitLockExitDecision({
        symbol,
        features,
        unrealizedPnlPct,
        mode: 'medium_trend_fade',
        symbolState,
      });
    }

    if (this.#matchesCryptoPeakGivebackExit({
      profitLock,
      unrealizedPnlPct,
      fast,
      medium,
      symbolState,
    })) {
      return this.#buildCryptoProfitLockExitDecision({
        symbol,
        features,
        unrealizedPnlPct,
        mode: 'peak_giveback_lock',
        symbolState,
      });
    }

    return null;
  }

  #matchesCryptoFastOverboughtRollover({ profitLock, fast }) {
    const fastRsiFloor = Number(profitLock?.fastRsiFloor);
    const fastEmaGapCeiling = Number(profitLock?.fastEmaGapCeiling);
    const fastPriceVsSmaFloor = Number(profitLock?.fastPriceVsSmaFloor);

    return Number.isFinite(Number(fast?.rsi14))
      && Number.isFinite(Number(fast?.emaGap12_26))
      && Number.isFinite(Number(fast?.priceVsSma20))
      && fast.rsi14 >= fastRsiFloor
      && fast.emaGap12_26 <= fastEmaGapCeiling
      && fast.priceVsSma20 >= fastPriceVsSmaFloor;
  }

  #matchesCryptoMediumTrendFade({ profitLock, unrealizedPnlPct, fast, medium }) {
    const mediumWeakMinUnrealizedPnlPct = Number(profitLock?.mediumWeakMinUnrealizedPnlPct);
    if (!Number.isFinite(mediumWeakMinUnrealizedPnlPct) || unrealizedPnlPct < mediumWeakMinUnrealizedPnlPct) {
      return false;
    }

    const mediumRsiCeiling = Number(profitLock?.mediumRsiCeiling);
    const mediumPriceVsSmaCeiling = Number(profitLock?.mediumPriceVsSmaCeiling);
    const mediumEmaGapCeiling = Number(profitLock?.mediumEmaGapCeiling);
    const fastRsiCeiling = Number(profitLock?.fastRsiCeiling);
    const fastEmaGapCeiling = Number(profitLock?.fastEmaGapForMediumWeakExitCeiling);

    return Number.isFinite(Number(medium?.rsi14))
      && Number.isFinite(Number(medium?.priceVsSma20))
      && Number.isFinite(Number(medium?.emaGap12_26))
      && Number.isFinite(Number(fast?.rsi14))
      && Number.isFinite(Number(fast?.emaGap12_26))
      && medium.rsi14 <= mediumRsiCeiling
      && medium.priceVsSma20 <= mediumPriceVsSmaCeiling
      && medium.emaGap12_26 <= mediumEmaGapCeiling
      && fast.rsi14 <= fastRsiCeiling
      && fast.emaGap12_26 <= fastEmaGapCeiling;
  }

  #matchesCryptoPeakGivebackExit({ profitLock, unrealizedPnlPct, fast, medium, symbolState }) {
    const peakUnrealizedPnlPct = Number(symbolState?.cryptoPeakUnrealizedPnlPct);
    const peakActivationUnrealizedPnlPct = Number(profitLock?.peakActivationUnrealizedPnlPct);
    const peakGivebackAbsPct = Number(profitLock?.peakGivebackAbsPct);
    const peakRetainRatioMax = Number(profitLock?.peakRetainRatioMax);

    if (!Number.isFinite(peakUnrealizedPnlPct) || !Number.isFinite(peakActivationUnrealizedPnlPct) || peakUnrealizedPnlPct < peakActivationUnrealizedPnlPct) {
      return false;
    }

    const givebackPct = peakUnrealizedPnlPct - unrealizedPnlPct;
    const retainRatio = peakUnrealizedPnlPct > 0 ? (unrealizedPnlPct / peakUnrealizedPnlPct) : 1;
    if (!Number.isFinite(givebackPct) || !Number.isFinite(retainRatio)) return false;
    if (givebackPct < peakGivebackAbsPct || retainRatio > peakRetainRatioMax) return false;

    return this.#matchesCryptoFastWeakness({ profitLock, fast })
      || this.#matchesCryptoMediumWeakness({ profitLock, medium });
  }

  #matchesCryptoFastWeakness({ profitLock, fast }) {
    const fastWeakRsiCeiling = Number(profitLock?.fastWeakRsiCeiling);
    const fastWeakPriceVsSmaCeiling = Number(profitLock?.fastWeakPriceVsSmaCeiling);
    const fastWeakEmaGapCeiling = Number(profitLock?.fastWeakEmaGapCeiling);

    return Number.isFinite(Number(fast?.rsi14))
      && Number.isFinite(Number(fast?.priceVsSma20))
      && Number.isFinite(Number(fast?.emaGap12_26))
      && fast.rsi14 <= fastWeakRsiCeiling
      && fast.priceVsSma20 <= fastWeakPriceVsSmaCeiling
      && fast.emaGap12_26 <= fastWeakEmaGapCeiling;
  }

  #matchesCryptoMediumWeakness({ profitLock, medium }) {
    const mediumRsiCeiling = Number(profitLock?.mediumRsiCeiling);
    const mediumPriceVsSmaCeiling = Number(profitLock?.mediumPriceVsSmaCeiling);
    const mediumEmaGapCeiling = Number(profitLock?.mediumEmaGapCeiling);

    return Number.isFinite(Number(medium?.rsi14))
      && Number.isFinite(Number(medium?.priceVsSma20))
      && Number.isFinite(Number(medium?.emaGap12_26))
      && medium.rsi14 <= mediumRsiCeiling
      && medium.priceVsSma20 <= mediumPriceVsSmaCeiling
      && medium.emaGap12_26 <= mediumEmaGapCeiling;
  }

  #buildCryptoProfitLockExitDecision({
    symbol,
    features,
    unrealizedPnlPct = null,
    mode = 'fast_overbought_rollover',
    symbolState = {},
  }) {
    const fast = features?.timeframes?.['5m']?.values ?? {};
    const medium = features?.timeframes?.['1h']?.values ?? {};

    return {
      action: 'close_long',
      confidence: 0.9,
      reasoning: ['crypto_profit_lock', mode],
      requestedSizePct: null,
      stopLossPct: null,
      takeProfitPct: null,
      signalContext: {
        symbol,
        assetClass: features?.assetClass ?? null,
        marketSession: features?.marketState?.sessionLabel ?? null,
        forcedCryptoProfitLockExit: true,
        unrealizedPnlPct: toFiniteOrNull(unrealizedPnlPct),
        peakUnrealizedPnlPct: toFiniteOrNull(symbolState?.cryptoPeakUnrealizedPnlPct),
        fastRsi14: toFiniteOrNull(fast?.rsi14),
        fastEmaGap12_26: toFiniteOrNull(fast?.emaGap12_26),
        fastPriceVsSma20: toFiniteOrNull(fast?.priceVsSma20),
        mediumRsi14: toFiniteOrNull(medium?.rsi14),
        mediumEmaGap12_26: toFiniteOrNull(medium?.emaGap12_26),
        mediumPriceVsSma20: toFiniteOrNull(medium?.priceVsSma20),
      },
    };
  }
}
