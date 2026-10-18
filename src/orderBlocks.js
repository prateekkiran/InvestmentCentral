const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));

function normalizeCandles(idea) {
  return (idea?.candles || []).map((row, index) => ({
    index,
    open: Number(row[0]),
    high: Number(row[1]),
    low: Number(row[2]),
    close: Number(row[3]),
    volume: Number(row[4]) || 0,
  })).filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
}

function candidateFor(candles, baseIndex, side, averages) {
  const base = candles[baseIndex];
  const future = candles.slice(baseIndex + 1);
  if (!base || !future.length) return null;

  const bullish = side === 'bullish';
  const baseOpposesMove = bullish ? base.close < base.open : base.close > base.open;
  const impulse = future.reduce((best, candle) => {
    const move = bullish
      ? ((candle.close - base.high) / Math.max(base.high, 0.01)) * 100
      : ((base.low - candle.close) / Math.max(base.low, 0.01)) * 100;
    return move > best.move ? { candle, move } : best;
  }, { candle: future[0], move: -Infinity });

  // Ignore marginal closes beyond the base. A quarter-percent floor prevents
  // ordinary price noise from being promoted as a displacement event.
  if (!Number.isFinite(impulse.move) || impulse.move < 0.25) return null;
  const impulseRange = impulse.candle.high - impulse.candle.low;
  const expansion = impulseRange / Math.max(averages.range, 0.01);
  const participation = impulse.candle.volume / Math.max(averages.volume, 1);
  const recency = (baseIndex + 1) / candles.length;
  const bodyShare = Math.abs(base.close - base.open) / Math.max(base.high - base.low, 0.01);
  const quality = impulse.move * 12
    + clamp(expansion - 0.8, 0, 2.5) * 8
    + clamp(participation - 0.7, 0, 2.5) * 7
    + recency * 9
    + (baseOpposesMove ? 14 : 0)
    + clamp(0.65 - bodyShare, 0, 0.65) * 8;

  return {
    side,
    baseIndex,
    strict: baseOpposesMove,
    displacementPct: Math.max(0, impulse.move),
    expansion,
    participation,
    quality,
  };
}

function fallbackCandidate(candles, idea) {
  const momentum = Number(idea?.fourSessionChangePct ?? idea?.performancePct ?? 0);
  const side = momentum >= 0 ? 'bullish' : 'bearish';
  const bases = candles.slice(0, -1);
  let baseIndex = 0;
  let compactness = Infinity;
  bases.forEach((candle, index) => {
    const range = Math.max(candle.high - candle.low, 0.01);
    const bodyShare = Math.abs(candle.close - candle.open) / range;
    if (bodyShare < compactness) {
      compactness = bodyShare;
      baseIndex = index;
    }
  });
  const base = candles[baseIndex];
  const last = candles.at(-1);
  return {
    side,
    baseIndex,
    strict: false,
    displacementPct: Math.abs(((last.close - base.close) / Math.max(base.close, 0.01)) * 100),
    expansion: 1,
    participation: 1,
    quality: 18 + Math.min(18, Math.abs(momentum) * 2),
  };
}

function statusFor(setup) {
  const { side, currentPrice: price, zone, invalidation, target1, distanceToZonePct, aligned, volumeRatio } = setup;
  const invalidated = side === 'bullish' ? price <= invalidation : price >= invalidation;
  const inZone = price >= zone.low && price <= zone.high;
  const targetReached = side === 'bullish' ? price >= target1 : price <= target1;
  if (invalidated) return { state: 'Invalidated', tone: 'risk', priority: 1, decision: 'Stand aside', reason: 'Price has crossed the structural invalidation level.' };
  if (inZone) return { state: 'In zone', tone: 'strong', priority: 6, decision: 'Decision window', reason: 'Price is trading inside the detected order-block zone.' };
  if (targetReached) return { state: 'Extended', tone: 'warm', priority: 2, decision: 'Avoid chasing', reason: 'Price has already travelled through the first objective.' };
  if (distanceToZonePct <= 2.5) return { state: 'Approaching', tone: 'positive', priority: 5, decision: 'Prepare', reason: `Price is ${distanceToZonePct.toFixed(2)}% from the zone.` };
  if (aligned && volumeRatio >= 1) return { state: 'Confirmed', tone: 'strong', priority: 4, decision: 'Monitor continuation', reason: 'Direction and participation currently agree with the setup.' };
  return { state: 'Monitoring', tone: 'neutral', priority: 3, decision: 'Wait for price', reason: 'The zone is valid, but price is not yet at a decision point.' };
}

export function detectOrderBlock(idea, quote = {}) {
  const candles = normalizeCandles(idea);
  if (candles.length < 3) return null;
  const averages = {
    range: candles.reduce((sum, candle) => sum + candle.high - candle.low, 0) / candles.length,
    volume: candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length,
  };
  const candidates = [];
  for (let index = 0; index < candles.length - 1; index += 1) {
    for (const side of ['bullish', 'bearish']) {
      const candidate = candidateFor(candles, index, side, averages);
      if (candidate) candidates.push(candidate);
    }
  }
  const momentum = Number(idea?.fourSessionChangePct ?? quote?.performancePct ?? 0);
  const candidate = candidates.sort((a, b) => {
    const aAligned = Math.sign(momentum) === (a.side === 'bullish' ? 1 : -1) ? 5 : 0;
    const bAligned = Math.sign(momentum) === (b.side === 'bullish' ? 1 : -1) ? 5 : 0;
    return (b.quality + bAligned) - (a.quality + aAligned);
  })[0] || fallbackCandidate(candles, idea);

  const base = candles[candidate.baseIndex];
  const bullish = candidate.side === 'bullish';
  const zone = bullish
    ? { low: base.low, high: Math.max(base.open, base.close) }
    : { low: Math.min(base.open, base.close), high: base.high };
  const zoneMid = (zone.low + zone.high) / 2;
  const lastClose = candles.at(-1).close;
  const currentPrice = Number(quote?.lastPrice ?? idea?.scanPrice ?? idea?.lastClose ?? lastClose);
  const buffer = Math.max(currentPrice * 0.0025, averages.range * 0.12);
  const invalidation = bullish ? zone.low - buffer : zone.high + buffer;
  const riskUnit = Math.max(Math.abs(zoneMid - invalidation), averages.range * 0.25, currentPrice * 0.004);
  const recentHigh = Math.max(...candles.map((candle) => candle.high));
  const recentLow = Math.min(...candles.map((candle) => candle.low));
  const target1 = bullish
    ? Math.max(recentHigh, zone.high + riskUnit * 1.5)
    : Math.min(recentLow, zone.low - riskUnit * 1.5);
  const target2 = bullish
    ? Math.max(target1 + riskUnit, zone.high + riskUnit * 2.5)
    : Math.min(target1 - riskUnit, zone.low - riskUnit * 2.5);
  const distanceToZone = currentPrice < zone.low ? zone.low - currentPrice : currentPrice > zone.high ? currentPrice - zone.high : 0;
  const distanceToZonePct = (distanceToZone / Math.max(currentPrice, 0.01)) * 100;
  const dayChangePct = Number(quote?.dayChangePct || 0);
  const volumeRatio = Number(quote?.volumeRatio ?? idea?.scanVolumeRatio ?? idea?.volumeRatio ?? 1);
  const aligned = bullish ? dayChangePct >= 0 : dayChangePct <= 0;
  const setup = {
    symbol: idea.symbol,
    side: candidate.side,
    sideLabel: bullish ? 'Bullish demand' : 'Bearish supply',
    currentPrice,
    zone: { low: round(zone.low), high: round(zone.high), midpoint: round(zoneMid) },
    invalidation: round(invalidation),
    target1: round(target1),
    target2: round(target2),
    distanceToZonePct: round(distanceToZonePct),
    displacementPct: round(candidate.displacementPct),
    expansionRatio: round(candidate.expansion),
    impulseVolumeRatio: round(candidate.participation),
    volumeRatio: round(volumeRatio),
    baseCandleIndex: candidate.baseIndex,
    baseCandleLabel: `T-${candles.length - 1 - candidate.baseIndex}`,
    strictPattern: candidate.strict,
    timeframe: 'Daily · five-session scan',
    source: quote?.stale === false ? 'FYERS live price' : 'Scan snapshot',
    aligned,
    candles: candles.map((candle) => [candle.open, candle.high, candle.low, candle.close, candle.volume]),
  };
  const status = statusFor(setup);
  const recency = (candidate.baseIndex + 1) / candles.length;
  let score = 30
    + clamp(candidate.displacementPct, 0, 6) * 5
    + clamp(candidate.participation - 0.7, 0, 2.5) * 8
    + recency * 8
    + (candidate.strict ? 10 : 0)
    + (distanceToZonePct <= 3 ? 8 : 0)
    + (aligned ? 5 : 0);
  if (status.state === 'Invalidated') score = Math.min(score, 28);
  if (status.state === 'Extended') score -= 12;
  if (!candidate.strict) score = Math.min(score, 58);
  score = Math.round(clamp(score, 0, 100));
  const riskFromZone = Math.abs(zoneMid - invalidation);
  const rewardFromZone = Math.abs(target2 - zoneMid);

  return {
    ...setup,
    ...status,
    score,
    riskReward: round(rewardFromZone / Math.max(riskFromZone, 0.01), 1),
    evidence: [
      `${candidate.strict ? 'Opposing' : 'Compact'} base candle at ${setup.baseCandleLabel}`,
      `${setup.displacementPct.toFixed(2)}% displacement beyond the base`,
      `${setup.impulseVolumeRatio.toFixed(2)}× volume on the impulse candle`,
      `${setup.distanceToZonePct.toFixed(2)}% current distance to the zone`,
    ],
  };
}

export function rankOrderBlocks(ideas, quotes = {}, generatedAt = new Date().toISOString()) {
  const list = Array.isArray(ideas) ? ideas : Object.values(ideas || {});
  const setups = list
    .map((idea) => detectOrderBlock(idea, quotes[idea.symbol] || {}))
    .filter(Boolean)
    .sort((a, b) => b.priority - a.priority || b.score - a.score || a.distanceToZonePct - b.distanceToZonePct);
  const bullish = setups.filter((setup) => setup.side === 'bullish');
  const bearish = setups.filter((setup) => setup.side === 'bearish');
  const counts = setups.reduce((result, setup) => ({ ...result, [setup.state]: (result[setup.state] || 0) + 1 }), {});
  return {
    generatedAt,
    model: 'transparent-order-block-v1',
    timeframe: 'Daily · five-session scan',
    methodology: 'Last opposing or compact base candle before directional displacement; ranked with displacement, relative volume, recency, live alignment, and zone proximity.',
    disclaimer: 'Research support only. A detected zone is evidence to review, not an instruction to buy or sell.',
    counts,
    bullish,
    bearish,
    setups,
  };
}
