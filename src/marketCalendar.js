const MARKET_TIMEZONE = 'Asia/Kolkata';

// Official NSE equity-market closures. Keep this list versioned with the
// exchange calendar so a vendor candle can never make a closed day look like
// a valid session. Exceptional live sessions belong in the separate allowlist.
export const NSE_EQUITY_HOLIDAYS = new Set([
  '2026-01-15',
  '2026-01-26',
  '2026-03-03',
  '2026-03-26',
  '2026-03-31',
  '2026-04-03',
  '2026-04-14',
  '2026-05-01',
  '2026-05-28',
  '2026-06-26',
  '2026-09-14',
  '2026-10-02',
  '2026-10-20',
  '2026-11-10',
  '2026-11-24',
  '2026-12-25',
]);

// Muhurat trading is a real exchange session even when it falls on Sunday.
// Keeping exceptional sessions explicit prevents ordinary weekend data from
// being admitted while preserving legitimate exchange activity.
export const NSE_SPECIAL_TRADING_DAYS = new Set(['2026-11-08']);
export const NSE_SPECIAL_SESSION_WINDOWS = Object.freeze({});

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MARKET_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIMEZONE,
  weekday: 'short',
});

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: MARKET_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T12:00:00+05:30`);
  return new Date(value);
}

export function indiaDateKey(value = new Date()) {
  const date = toDate(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : null;
}

export function isTradingSessionDate(value, {
  holidays = NSE_EQUITY_HOLIDAYS,
  specialTradingDays = NSE_SPECIAL_TRADING_DAYS,
} = {}) {
  const date = toDate(value);
  if (!Number.isFinite(date.getTime())) return false;
  const key = indiaDateKey(date);
  if (specialTradingDays.has(key)) return true;
  const weekday = weekdayFormatter.format(date);
  return !['Sat', 'Sun'].includes(weekday) && !holidays.has(key);
}

export function sessionState(value = new Date(), options = {}) {
  const date = toDate(value);
  const dateKey = indiaDateKey(date);
  const special = (options.specialTradingDays || NSE_SPECIAL_TRADING_DAYS).has(dateKey);
  const holiday = (options.holidays || NSE_EQUITY_HOLIDAYS).has(dateKey) && !special;
  const weekday = weekdayFormatter.format(date);
  const weekend = ['Sat', 'Sun'].includes(weekday) && !special;
  const [hour, minute] = timeFormatter.format(date).split(':').map(Number);
  const minutes = hour * 60 + minute;
  const tradingDay = !weekend && !holiday;
  const specialWindow = special ? (options.specialSessionWindows || NSE_SPECIAL_SESSION_WINDOWS)[dateKey] : null;
  const openMinute = special ? specialWindow?.open : 9 * 60 + 15;
  const closeMinute = special ? specialWindow?.close : 15 * 60 + 30;
  const hasKnownWindow = !special || Boolean(specialWindow);
  const open = tradingDay && hasKnownWindow && minutes >= openMinute && minutes <= closeMinute;
  const completed = tradingDay && hasKnownWindow && minutes > closeMinute;
  let reason = 'Outside regular market hours';
  if (weekend) reason = 'Weekend — signals frozen';
  else if (holiday) reason = 'NSE trading holiday — signals frozen';
  else if (special && !specialWindow) reason = 'Special session timing unconfirmed — signals frozen';
  else if (open) reason = special ? 'Special NSE session active' : 'Regular NSE session active';
  else if (completed) reason = 'Session closed — awaiting next trading day';
  else reason = 'Pre-open — signal lifecycle paused';
  return { date: dateKey, weekday, tradingDay, special, holiday, weekend, open, completed, reason };
}

export function nextTradingSessionDate(value = new Date(), options = {}) {
  const base = toDate(value);
  for (let offset = 1; offset <= 370; offset += 1) {
    const candidate = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    if (isTradingSessionDate(candidate, options)) return indiaDateKey(candidate);
  }
  return null;
}

export function addTradingSessions(value, sessionCount, options = {}) {
  let candidate = toDate(value);
  let remaining = Math.max(0, Number(sessionCount) || 0);
  while (remaining > 0) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    if (isTradingSessionDate(candidate, options)) remaining -= 1;
  }
  return candidate;
}

function validOhlcv(candle) {
  const [, open, high, low, close, volume] = candle;
  if (![open, high, low, close, volume].every(Number.isFinite)) return false;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || volume < 0) return false;
  return high >= Math.max(open, close) && low <= Math.min(open, close) && high >= low;
}

export function sanitizeDailyCandles(rows = [], {
  now = new Date(),
  holidays = NSE_EQUITY_HOLIDAYS,
  specialTradingDays = NSE_SPECIAL_TRADING_DAYS,
} = {}) {
  const diagnostics = {
    received: Array.isArray(rows) ? rows.length : 0,
    accepted: 0,
    invalid: 0,
    weekend: 0,
    holiday: 0,
    future: 0,
    incomplete: 0,
    duplicate: 0,
  };
  const sessions = new Map();
  const nowDate = toDate(now);
  const today = indiaDateKey(nowDate);
  const currentSession = sessionState(nowDate, { holidays, specialTradingDays });

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 6) { diagnostics.invalid += 1; continue; }
    const candle = row.slice(0, 6).map(Number);
    const at = toDate(candle[0]);
    if (!Number.isFinite(at.getTime()) || !validOhlcv(candle)) { diagnostics.invalid += 1; continue; }
    const dateKey = indiaDateKey(at);
    const special = specialTradingDays.has(dateKey);
    const weekday = weekdayFormatter.format(at);
    if (!special && ['Sat', 'Sun'].includes(weekday)) { diagnostics.weekend += 1; continue; }
    if (!special && holidays.has(dateKey)) { diagnostics.holiday += 1; continue; }
    if (dateKey > today) { diagnostics.future += 1; continue; }
    if (dateKey === today && !currentSession.completed) { diagnostics.incomplete += 1; continue; }
    if (sessions.has(dateKey)) diagnostics.duplicate += 1;
    sessions.set(dateKey, candle);
  }

  const candles = [...sessions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candle]) => candle);
  diagnostics.accepted = candles.length;
  return {
    candles,
    diagnostics: {
      ...diagnostics,
      rejected: diagnostics.invalid + diagnostics.weekend + diagnostics.holiday + diagnostics.future + diagnostics.incomplete + diagnostics.duplicate,
      lastValidSession: candles.length ? indiaDateKey(candles.at(-1)[0]) : null,
    },
  };
}

export function isQuoteTimestampInActiveSession(timestamp, now = new Date(), options = {}) {
  const state = sessionState(now, options);
  if (!state.open) return false;
  const quoteAt = toDate(timestamp);
  if (!Number.isFinite(quoteAt.getTime())) return false;
  if (indiaDateKey(quoteAt) !== state.date) return false;
  const [hour, minute] = timeFormatter.format(quoteAt).split(':').map(Number);
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

