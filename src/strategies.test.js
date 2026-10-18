import test from 'node:test';
import assert from 'node:assert/strict';
import { NIFTY50 } from './nifty50.js';
import { buildStrategyCandidates, reconcileSignalLedger } from './strategies.js';

test('defines exactly 50 unique NIFTY constituents', () => {
  assert.equal(NIFTY50.length, 50);
  assert.equal(new Set(NIFTY50.map((stock) => stock.symbol)).size, 50);
  assert.ok(NIFTY50.every((stock) => stock.marketSymbol === `NSE:${stock.symbol}-EQ`));
});

test('abstains when there is not enough history for precision strategies', () => {
  const book = buildStrategyCandidates([{ symbol: 'SHORT', candles: [[10, 11, 9, 10.5, 1000]] }], {});
  assert.equal(book.candidates.length, 0);
  assert.equal(book.historyReady, 0);
});

const candidateBook = {
  candidates: [{
    setupKey: 'TEST:Momentum:1', symbol: 'TEST', company: 'Test', sector: 'Test', strategy: 'Momentum', direction: 'Long',
    score: 82, timeframe: 'Daily', currentPrice: 101, entryZone: { low: 100, high: 102 }, stopLoss: 95,
    target1: 110, target2: 118, riskReward: 3, rationale: 'Qualified test setup', evidence: ['Trend aligned'], indicators: {}, sourceCandleAt: 1,
  }],
  universeSize: 1, historyReady: 1, minimumScore: 72,
};

test('creates and advances a signal through its targets', () => {
  const created = reconcileSignalLedger([], candidateBook, { TEST: { lastPrice: 101 } }, '2026-10-17T00:00:00.000Z');
  assert.equal(created.signals[0].status, 'Active');
  const firstTarget = reconcileSignalLedger(created.signals, { candidates: [] }, { TEST: { lastPrice: 111 } }, '2026-10-18T00:00:00.000Z');
  assert.equal(firstTarget.signals[0].status, 'Target 1');
  const finalTarget = reconcileSignalLedger(firstTarget.signals, { candidates: [] }, { TEST: { lastPrice: 119 } }, '2026-10-19T00:00:00.000Z');
  assert.equal(finalTarget.signals[0].status, 'Target 2');
  assert.equal(finalTarget.signals[0].events.length, 3);
});

test('records a stop instead of silently dropping a failed setup', () => {
  const created = reconcileSignalLedger([], candidateBook, { TEST: { lastPrice: 101 } }, '2026-10-17T00:00:00.000Z');
  const stopped = reconcileSignalLedger(created.signals, { candidates: [] }, { TEST: { lastPrice: 94 } }, '2026-10-18T00:00:00.000Z');
  assert.equal(stopped.signals[0].status, 'Stopped');
  assert.match(stopped.signals[0].events.at(-1).note, /stop-loss/i);
});

test('cancels an untriggered setup that no longer clears the precision gate', () => {
  const lowScoreBook = { ...candidateBook, minimumScore: 72, candidates: [{ ...candidateBook.candidates[0], score: 70 }] };
  const created = reconcileSignalLedger([], lowScoreBook, { TEST: { lastPrice: 105 } }, '2026-10-17T00:00:00.000Z');
  assert.equal(created.signals[0].status, 'Waiting');
  const reviewed = reconcileSignalLedger(created.signals, { candidates: [], minimumScore: 72 }, { TEST: { lastPrice: 105 } }, '2026-10-18T00:00:00.000Z');
  assert.equal(reviewed.signals[0].status, 'Cancelled');
  assert.equal(reviewed.signals[0].action, 'Stand aside');
});

test('does not create or advance signals while the exchange lifecycle is frozen', () => {
  const frozenCreation = reconcileSignalLedger(
    [],
    candidateBook,
    { TEST: { lastPrice: 101, stale: true } },
    '2026-10-18T06:00:00.000Z',
    { advanceLifecycle: false },
  );
  assert.equal(frozenCreation.signals.length, 0);

  const created = reconcileSignalLedger(
    [],
    candidateBook,
    { TEST: { lastPrice: 101 } },
    '2026-10-16T06:00:00.000Z',
  );
  const eventCount = created.signals[0].events.length;
  const frozenTarget = reconcileSignalLedger(
    created.signals,
    { candidates: [], minimumScore: 72 },
    { TEST: { lastPrice: 119, stale: true } },
    '2026-10-18T06:00:00.000Z',
    { advanceLifecycle: false },
  );

  assert.equal(frozenTarget.signals[0].status, 'Active');
  assert.equal(frozenTarget.signals[0].events.length, eventCount);
});
