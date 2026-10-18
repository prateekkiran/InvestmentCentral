import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addTradingSessions,
  isQuoteTimestampInActiveSession,
  isTradingSessionDate,
  sanitizeDailyCandles,
  sessionState,
} from './marketCalendar.js';

const epoch = (date) => Math.floor(new Date(`${date}T15:30:00+05:30`).getTime() / 1000);
const candle = (date, close = 100) => [epoch(date), close - 1, close + 2, close - 2, close, 1000];

test('recognises NSE weekends, holidays and an explicit special session', () => {
  assert.equal(isTradingSessionDate('2026-10-17'), false);
  assert.equal(isTradingSessionDate('2026-10-20'), false);
  assert.equal(isTradingSessionDate('2026-10-21'), true);
  assert.equal(isTradingSessionDate('2026-11-08'), true);
  assert.equal(sessionState(new Date('2026-11-08T11:00:00+05:30')).open, false);
});

test('removes closed-day, future, duplicate and incomplete daily candles', () => {
  const result = sanitizeDailyCandles([
    candle('2026-10-15', 100),
    candle('2026-10-16', 101),
    candle('2026-10-16', 102),
    candle('2026-10-17', 103),
    candle('2026-10-20', 104),
    candle('2026-10-21', 105),
    candle('2026-10-22', 106),
  ], { now: new Date('2026-10-21T12:00:00+05:30') });
  assert.deepEqual(result.candles.map((row) => row[4]), [100, 102]);
  assert.equal(result.diagnostics.duplicate, 1);
  assert.equal(result.diagnostics.weekend, 1);
  assert.equal(result.diagnostics.holiday, 1);
  assert.equal(result.diagnostics.incomplete, 1);
  assert.equal(result.diagnostics.future, 1);
});

test('freezes market state on weekends and exchange holidays', () => {
  assert.match(sessionState(new Date('2026-10-18T11:00:00+05:30')).reason, /Weekend/);
  assert.match(sessionState(new Date('2026-10-20T11:00:00+05:30')).reason, /holiday/);
  assert.equal(sessionState(new Date('2026-10-21T11:00:00+05:30')).open, true);
});

test('expires setups after trading sessions rather than calendar days', () => {
  const expiry = addTradingSessions(new Date('2026-10-16T15:30:00+05:30'), 2);
  assert.equal(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(expiry), '2026-10-21');
});

test('accepts only a quote timestamp from the current active session', () => {
  const now = new Date('2026-10-21T11:00:00+05:30');
  assert.equal(isQuoteTimestampInActiveSession(new Date('2026-10-21T10:59:00+05:30'), now), true);
  assert.equal(isQuoteTimestampInActiveSession(new Date('2026-10-20T10:59:00+05:30'), now), false);
  assert.equal(isQuoteTimestampInActiveSession(new Date('2026-10-21T08:30:00+05:30'), now), false);
});
