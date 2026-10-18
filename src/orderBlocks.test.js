import test from 'node:test';
import assert from 'node:assert/strict';
import { detectOrderBlock, rankOrderBlocks } from './orderBlocks.js';

const bullishIdea = {
  symbol: 'BULL', fourSessionChangePct: 7, scanVolumeRatio: 1.8,
  candles: [
    [100, 102, 97, 98, 1000],
    [98, 99, 95, 96, 900],
    [97, 106, 97, 105, 2100],
    [105, 110, 103, 109, 1800],
    [109, 114, 108, 113, 1900],
  ],
};

const bearishIdea = {
  symbol: 'BEAR', fourSessionChangePct: -6, scanVolumeRatio: 1.5,
  candles: [
    [200, 205, 198, 204, 1000],
    [204, 208, 203, 207, 900],
    [206, 207, 195, 196, 2200],
    [196, 198, 188, 190, 1800],
    [190, 192, 182, 184, 1700],
  ],
};

test('detects a bullish demand zone before upward displacement', () => {
  const setup = detectOrderBlock(bullishIdea, { lastPrice: 100, dayChangePct: 0.8, volumeRatio: 1.4, stale: false });
  assert.equal(setup.side, 'bullish');
  assert.ok(setup.zone.low < setup.zone.high);
  assert.ok(setup.invalidation < setup.zone.low);
  assert.ok(setup.target1 > setup.zone.high);
  assert.ok(setup.score >= 50);
});

test('detects a bearish supply zone before downward displacement', () => {
  const setup = detectOrderBlock(bearishIdea, { lastPrice: 202, dayChangePct: -0.7, volumeRatio: 1.3, stale: false });
  assert.equal(setup.side, 'bearish');
  assert.ok(setup.invalidation > setup.zone.high);
  assert.ok(setup.target1 < setup.zone.low);
  assert.ok(setup.target2 < setup.target1);
});

test('caps the score after structural invalidation', () => {
  const setup = detectOrderBlock(bullishIdea, { lastPrice: 90, volumeRatio: 1, stale: false });
  assert.equal(setup.state, 'Invalidated');
  assert.ok(setup.score <= 28);
});

test('keeps sub-threshold price noise as a lower-confidence compact-base candidate', () => {
  const quietIdea = {
    symbol: 'QUIET', fourSessionChangePct: 0.08, scanVolumeRatio: 1,
    candles: [
      [100, 100.2, 99.8, 100.05, 1000],
      [100.04, 100.18, 99.9, 100.1, 980],
      [100.1, 100.2, 99.95, 100.08, 1010],
      [100.08, 100.2, 99.9, 100.12, 990],
      [100.11, 100.2, 99.95, 100.13, 1005],
    ],
  };
  const setup = detectOrderBlock(quietIdea, { lastPrice: 100.13, dayChangePct: 0.02, volumeRatio: 1 });
  assert.equal(setup.strictPattern, false);
  assert.ok(setup.displacementPct < 0.25);
  assert.ok(setup.score <= 58);
});

test('ranks the universe and exposes side collections', () => {
  const book = rankOrderBlocks([bullishIdea, bearishIdea], {
    BULL: { lastPrice: 100, dayChangePct: 0.5, volumeRatio: 1.2 },
    BEAR: { lastPrice: 202, dayChangePct: -0.5, volumeRatio: 1.2 },
  }, '2026-10-17T00:00:00.000Z');
  assert.equal(book.setups.length, 2);
  assert.equal(book.bullish.length, 1);
  assert.equal(book.bearish.length, 1);
  assert.equal(book.generatedAt, '2026-10-17T00:00:00.000Z');
});
