import { addTradingSessions, sanitizeDailyCandles } from './marketCalendar.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));

function normalizeCandles(idea, now = new Date()) {
  const hasTimestampedHistory = Boolean(idea?.history?.length);
  const source = hasTimestampedHistory
    ? sanitizeDailyCandles(idea.history, { now }).candles
    : idea?.candles || [];
  return source.map((row, index) => {
    const offset = row.length >= 6 ? 1 : 0;
    return {
      time: offset ? Number(row[0]) : index,
      open: Number(row[offset]), high: Number(row[offset + 1]), low: Number(row[offset + 2]),
      close: Number(row[offset + 3]), volume: Number(row[offset + 4]) || 0,
    };
  }).filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function ema(values, period) {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  return values.slice(1).reduce((result, value) => value * alpha + result * (1 - alpha), values[0]);
}

function standardDeviation(values) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function rsi(values, period = 14) {
  const changes = values.slice(1).map((value, index) => value - values[index]);
  const window = changes.slice(-period);
  const gains = average(window.map((change) => Math.max(0, change)));
  const losses = average(window.map((change) => Math.max(0, -change)));
  if (!losses) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function atr(candles, period = 14) {
  const ranges = candles.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - candles[index].close),
    Math.abs(candle.low - candles[index].close),
  ));
  return average(ranges.slice(-period));
}

function baseCandidate({ idea, quote, strategy, score, rationale, evidence, indicators, entryLow, entryHigh, stopLoss, target1, target2, lastCandle }) {
  const risk = Math.max(((entryLow + entryHigh) / 2) - stopLoss, 0.01);
  const reward = target2 - ((entryLow + entryHigh) / 2);
  return {
    setupKey: `${idea.symbol}:${strategy}:${lastCandle.time}`,
    symbol: idea.symbol,
    company: idea.name || idea.symbol,
    sector: idea.sector || 'NIFTY 50',
    strategy,
    direction: 'Long',
    score: Math.round(clamp(score, 0, 100)),
    timeframe: 'Daily',
    currentPrice: round(quote?.lastPrice || lastCandle.close),
    entryZone: { low: round(entryLow), high: round(entryHigh) },
    stopLoss: round(stopLoss),
    target1: round(target1),
    target2: round(target2),
    riskReward: round(reward / risk, 1),
    rationale,
    evidence,
    indicators: Object.fromEntries(Object.entries(indicators).map(([key, value]) => [key, round(value)])),
    sourceCandleAt: lastCandle.time,
  };
}

function momentumCandidate(idea, quote, candles) {
  if (candles.length < 55) return null;
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const latest = candles.at(-1);
  const previous20 = candles.slice(-21, -1);
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const roc20 = ((latest.close / closes.at(-21)) - 1) * 100;
  const breakout = latest.close / Math.max(...previous20.map((candle) => candle.high));
  const volumeRatio = latest.volume / Math.max(average(volumes.slice(-21, -1)), 1);
  const atrPct = atr14 / latest.close * 100;
  const liveAligned = Number(quote?.dayChangePct || 0) >= 0;
  let score = 0;
  if (latest.close > ema20 && ema20 > ema50) score += 22;
  if (roc20 >= 4) score += 18;
  if (rsi14 >= 55 && rsi14 <= 72) score += 16;
  if (breakout >= 0.995) score += 18;
  if (volumeRatio >= 1.05) score += 14;
  if (atrPct >= 0.8 && atrPct <= 5) score += 7;
  if (liveAligned) score += 5;
  if (score < 72) return null;

  const entryLow = Math.max(ema20, latest.close - atr14 * 0.45);
  const entryHigh = latest.close + atr14 * 0.15;
  const swingLow = Math.min(...candles.slice(-10).map((candle) => candle.low));
  const stopLoss = Math.min(entryLow - atr14 * 1.15, swingLow - atr14 * 0.1);
  const risk = ((entryLow + entryHigh) / 2) - stopLoss;
  if (risk <= 0 || risk / latest.close > 0.09) return null;
  return baseCandidate({
    idea, quote, strategy: 'Momentum', score, lastCandle: latest,
    entryLow, entryHigh, stopLoss, target1: entryHigh + risk * 1.5, target2: entryHigh + risk * 2.5,
    rationale: 'Trend, 20-session strength, breakout proximity, and participation meet the momentum gate.',
    evidence: [
      `Price ${latest.close > ema20 && ema20 > ema50 ? 'above' : 'not above'} aligned 20/50-day averages`,
      `${roc20.toFixed(2)}% 20-session momentum`, `${rsi14.toFixed(1)} RSI`,
      `${volumeRatio.toFixed(2)}× latest volume versus 20-session average`,
    ],
    indicators: { ema20, ema50, rsi14, atr14, roc20, breakoutRatio: breakout, volumeRatio },
  });
}

function meanReversionCandidate(idea, quote, candles) {
  if (candles.length < 55) return null;
  const closes = candles.map((candle) => candle.close);
  const latest = candles.at(-1);
  const previous = candles.at(-2);
  const window20 = closes.slice(-20);
  const mean20 = average(window20);
  const deviation20 = standardDeviation(window20);
  const lowerBand = mean20 - deviation20 * 2;
  const upperBand = mean20 + deviation20 * 2;
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes);
  const atr14 = atr(candles);
  const zScore = (latest.close - mean20) / Math.max(deviation20, 0.01);
  const trendIntact = latest.close >= ema50 * 0.96;
  const reversal = latest.close > latest.open || latest.close > previous.close;
  const volumeRatio = latest.volume / Math.max(average(candles.slice(-21, -1).map((candle) => candle.volume)), 1);
  let score = 0;
  if (trendIntact) score += 18;
  if (zScore <= -1.5) score += 22;
  if (rsi14 >= 25 && rsi14 <= 42) score += 18;
  if (latest.close <= lowerBand * 1.012) score += 18;
  if (reversal) score += 14;
  if (volumeRatio >= 0.75) score += 7;
  if (Number(quote?.dayChangePct || 0) >= -1) score += 3;
  if (score < 72) return null;

  const entryLow = latest.close - atr14 * 0.2;
  const entryHigh = latest.close + atr14 * 0.25;
  const recentLow = Math.min(...candles.slice(-10).map((candle) => candle.low));
  const stopLoss = Math.min(entryLow - atr14 * 1.2, recentLow - atr14 * 0.15);
  const risk = ((entryLow + entryHigh) / 2) - stopLoss;
  const target1 = Math.max(mean20, entryHigh + risk * 1.25);
  const target2 = Math.max(upperBand, entryHigh + risk * 2);
  if (risk <= 0 || target1 <= entryHigh || risk / latest.close > 0.08) return null;
  return baseCandidate({
    idea, quote, strategy: 'Mean reversion', score, lastCandle: latest,
    entryLow, entryHigh, stopLoss, target1, target2,
    rationale: 'A statistically stretched price is showing reversal evidence while the longer trend remains intact.',
    evidence: [
      `${zScore.toFixed(2)} standard deviations from the 20-day mean`, `${rsi14.toFixed(1)} RSI`,
      `Price ${trendIntact ? 'retains' : 'lost'} the long-trend filter`,
      reversal ? 'Latest candle shows reversal evidence' : 'No reversal candle yet',
    ],
    indicators: { mean20, ema50, lowerBand, upperBand, rsi14, atr14, zScore, volumeRatio },
  });
}

function orderBlockCandidate(idea, quote, setup, candles) {
  if (!setup || !setup.strictPattern || setup.score < 72 || setup.riskReward < 2 || !['In zone', 'Approaching', 'Confirmed'].includes(setup.state)) return null;
  const latest = candles.at(-1);
  return baseCandidate({
    idea, quote, strategy: 'Order block', score: setup.score, lastCandle: latest,
    entryLow: setup.zone.low, entryHigh: setup.zone.high, stopLoss: setup.invalidation,
    target1: setup.target1, target2: setup.target2,
    rationale: 'A strict opposing-candle demand block is near price with acceptable structural reward-to-risk.',
    evidence: setup.evidence,
    indicators: { displacementPct: setup.displacementPct, impulseVolumeRatio: setup.impulseVolumeRatio, distanceToZonePct: setup.distanceToZonePct },
  });
}

export function buildStrategyCandidates(ideas, quotes = {}, orderBook = { setups: [] }, generatedAt = new Date().toISOString()) {
  const list = Array.isArray(ideas) ? ideas : Object.values(ideas || {});
  const blocks = new Map((orderBook.setups || []).map((setup) => [setup.symbol, setup]));
  const normalized = new Map(list.map((idea) => [idea.symbol, normalizeCandles(idea, generatedAt)]));
  const candidates = list.flatMap((idea) => {
    const candles = normalized.get(idea.symbol) || [];
    if (candles.length < 3) return [];
    const quote = quotes[idea.symbol] || {};
    return [
      momentumCandidate(idea, quote, candles),
      meanReversionCandidate(idea, quote, candles),
      orderBlockCandidate(idea, quote, blocks.get(idea.symbol), candles),
    ].filter(Boolean);
  }).sort((a, b) => b.score - a.score || b.riskReward - a.riskReward);
  return {
    generatedAt,
    universeSize: list.length,
    historyReady: list.filter((idea) => (normalized.get(idea.symbol)?.length || 0) >= 55).length,
    minimumScore: 72,
    candidates,
    definitions: [
      { name: 'Momentum', description: '20/50-day trend alignment, 20-session strength, breakout proximity, RSI, volatility, and volume confirmation.' },
      { name: 'Mean reversion', description: 'Bollinger-style statistical stretch, RSI exhaustion, reversal evidence, and an intact 50-day trend.' },
      { name: 'Order block', description: 'Strict opposing-candle demand zone, live proximity, participation, and at least 2R structural reward.' },
    ],
    disclaimer: 'Research support only. Strategy scores rank evidence; they are not probabilities or execution instructions.',
  };
}

const terminalStates = new Set(['Target 2', 'Stopped', 'Expired', 'Cancelled']);

function actionFor(status, price, signal) {
  if (status === 'Active') return 'Hold / manage risk';
  if (status === 'Target 1') return 'Book partial / trail stop';
  if (status === 'Target 2') return 'Close / objective reached';
  if (status === 'Stopped') return 'Exit / setup invalidated';
  if (status === 'Expired') return 'No action / entry expired';
  if (status === 'Cancelled') return 'Stand aside';
  return price > signal.entryZone.high ? 'Wait for pullback' : 'Prepare entry';
}

function event(status, price, at, note) {
  return { status, price: round(price), at, note };
}

export function reconcileSignalLedger(existing = [], candidateBook, quotes = {}, now = new Date().toISOString(), { advanceLifecycle = true } = {}) {
  const nowMs = new Date(now).getTime();
  const signals = existing.map((signal) => ({ ...signal, events: [...(signal.events || [])] }));
  let changed = false;
  for (const signal of signals) {
    if (terminalStates.has(signal.status)) continue;
    if (!advanceLifecycle || quotes[signal.symbol]?.stale) continue;
    const price = Number(quotes[signal.symbol]?.lastPrice || signal.currentPrice);
    let next = signal.status;
    let note = '';
    if (signal.status === 'Waiting' && signal.score < (candidateBook.minimumScore || 72)) {
      next = 'Cancelled'; note = `The setup no longer clears the ${candidateBook.minimumScore || 72}-point precision gate.`;
    } else if (signal.status === 'Waiting') {
      if (price <= signal.stopLoss) { next = 'Cancelled'; note = 'Invalidation was crossed before entry.'; }
      else if (price >= signal.entryZone.low && price <= signal.entryZone.high) { next = 'Active'; note = 'Price entered the planned entry zone.'; }
      else if (nowMs > new Date(signal.expiresAt).getTime()) { next = 'Expired'; note = 'The entry window expired without a valid trigger.'; }
    } else if (['Active', 'Target 1'].includes(signal.status)) {
      if (price <= signal.stopLoss) { next = 'Stopped'; note = 'The defined stop-loss level was reached.'; }
      else if (price >= signal.target2) { next = 'Target 2'; note = 'The final modelled objective was reached.'; }
      else if (price >= signal.target1 && signal.status === 'Active') { next = 'Target 1'; note = 'The first objective was reached; the setup remains tracked.'; }
    }
    signal.currentPrice = round(price);
    signal.returnPct = round(((price / signal.triggerPrice) - 1) * 100);
    signal.action = actionFor(next, price, signal);
    if (next !== signal.status) {
      signal.status = next;
      signal.updatedAt = now;
      signal.events.push(event(next, price, now, note));
      changed = true;
    }
  }

  for (const candidate of advanceLifecycle ? candidateBook.candidates || [] : []) {
    const duplicate = signals.some((signal) => signal.setupKey === candidate.setupKey || (signal.symbol === candidate.symbol && signal.strategy === candidate.strategy && !terminalStates.has(signal.status)));
    if (duplicate) continue;
    if (quotes[candidate.symbol]?.stale) continue;
    const price = Number(quotes[candidate.symbol]?.lastPrice || candidate.currentPrice);
    if (price <= candidate.stopLoss || price >= candidate.target1) continue;
    const status = price >= candidate.entryZone.low && price <= candidate.entryZone.high ? 'Active' : 'Waiting';
    const expiresAt = addTradingSessions(new Date(nowMs), 10).toISOString();
    signals.push({
      ...candidate,
      id: candidate.setupKey,
      status,
      action: actionFor(status, price, candidate),
      triggerPrice: round(price), currentPrice: round(price), returnPct: 0,
      createdAt: now, updatedAt: now, expiresAt,
      events: [event(status, price, now, status === 'Active' ? 'Signal activated inside its entry zone.' : 'Qualified setup added to the watch ledger.')],
    });
    changed = true;
  }

  const ranked = [...signals].sort((a, b) => {
    const priority = { Active: 5, 'Target 1': 4, Waiting: 3, 'Target 2': 2, Stopped: 1, Expired: 0, Cancelled: 0 };
    return (priority[b.status] || 0) - (priority[a.status] || 0) || b.score - a.score;
  });
  const counts = ranked.reduce((result, signal) => ({ ...result, [signal.status]: (result[signal.status] || 0) + 1 }), {});
  return {
    changed,
    signals: ranked,
    active: ranked.filter((signal) => ['Active', 'Target 1'].includes(signal.status)),
    waiting: ranked.filter((signal) => signal.status === 'Waiting'),
    closed: ranked.filter((signal) => terminalStates.has(signal.status)),
    counts,
  };
}
