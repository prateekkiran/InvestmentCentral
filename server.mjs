import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile, appendFile, stat, chmod } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { rankOrderBlocks } from './src/orderBlocks.js';
import { NIFTY50 } from './src/nifty50.js';
import { buildStrategyCandidates, reconcileSignalLedger } from './src/strategies.js';
import {
  isQuoteTimestampInActiveSession,
  isTradingSessionDate,
  nextTradingSessionDate,
  sanitizeDailyCandles,
  sessionState,
} from './src/marketCalendar.js';

const root = dirname(fileURLToPath(import.meta.url));
const isDev = process.argv.includes('--dev');
const port = Number(process.env.PORT || 5173);
const pollMs = Math.max(2000, Number(process.env.MARKET_POLL_MS || 5000));
const historyMs = Math.max(30000, Number(process.env.HISTORY_INTERVAL_MS || 60000));
const historyRetentionDays = Math.max(1, Number(process.env.HISTORY_RETENTION_DAYS || 30));
const alertConfirmPolls = Math.max(1, Number(process.env.ALERT_CONFIRM_POLLS || 3));
const signalHysteresis = Math.max(0, Number(process.env.SIGNAL_HYSTERESIS_PCT || 0.25));
const sweepIntervalMinutes = Math.max(30, Number(process.env.SWEEP_INTERVAL_MINUTES || 120));
const sweepStartMinutes = 9 * 60 + 15;
const sweepEndMinutes = 15 * 60 + 30;
const thresholds = {
  warning: Number(process.env.SIGNAL_WARNING_PCT || -3),
  invalidated: Number(process.env.SIGNAL_INVALIDATED_PCT || -5),
  confirmed: Number(process.env.SIGNAL_CONFIRMED_PCT || 2),
  extended: Number(process.env.SIGNAL_EXTENDED_PCT || 5),
};
const registryPath = join(root, 'data', 'ideas.json');
const eventsPath = join(root, 'data', 'monitor-events.jsonl');
const historyPath = join(root, 'data', 'quote-history.jsonl');
const sweepsPath = join(root, 'data', 'stock-sweeps.jsonl');
const fyersSessionPath = join(root, 'data', 'fyers-session.json');
const dailyHistoryPath = join(root, 'data', 'daily-history.json');
const strategySignalsPath = join(root, 'data', 'strategy-signals.json');
const clients = new Set();
let vite;
let pollTimer;
let polling = false;
let lastSignals = new Map();
let pendingSignals = new Map();
let fyersOauthState = null;
let fyersRefreshError = null;
let recentAlerts = [];
let historyMeta = { samples: 0, lastRecordedAt: null, rejectedClosedSession: 0 };
let sweepState = { latest: null, today: [] };
let strategyHistoryRefresh = null;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function indiaNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date()).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return parts;
}

function marketStatus() {
  const state = sessionState(new Date());
  return {
    ...state,
    label: state.open ? 'Market open' : state.reason,
    timezone: 'Asia/Kolkata',
    nextTradingDate: state.open ? state.date : nextTradingSessionDate(new Date()),
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function readJsonLines(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function eventId(event) {
  return createHash('sha1').update(`${event.at}:${event.symbol}:${event.from}:${event.to}`).digest('hex').slice(0, 12);
}

function normalizeEvent(event) {
  const severity = event.severity || (event.to === 'Invalidated' ? 'critical' : event.to === 'At risk' ? 'warning' : ['Confirmed', 'Extended'].includes(event.to) ? 'positive' : 'info');
  return { ...event, id: event.id || eventId(event), severity, notify: event.notify ?? ['Invalidated', 'At risk', 'Confirmed', 'Extended'].includes(event.to) };
}

async function loadMonitorState() {
  const [events, history, sweeps] = await Promise.all([readJsonLines(eventsPath), readJsonLines(historyPath), readJsonLines(sweepsPath)]);
  const historyCutoff = Date.now() - historyRetentionDays * 24 * 60 * 60 * 1000;
  const recentHistory = history.filter((sample) => new Date(sample.at).getTime() >= historyCutoff);
  const retainedHistory = recentHistory.filter((sample) => sessionState(sample.at).open);
  if (retainedHistory.length !== history.length) await writeFile(historyPath, retainedHistory.map((sample) => JSON.stringify(sample)).join('\n') + (retainedHistory.length ? '\n' : ''));
  recentAlerts = events.filter((item) => registry.ideas[item.symbol] && sessionState(item.at).open).slice(-20).reverse().map(normalizeEvent);
  historyMeta = { samples: retainedHistory.length, lastRecordedAt: retainedHistory.at(-1)?.at || null, rejectedClosedSession: recentHistory.length - retainedHistory.length };
  const today = indiaDate();
  const validSweeps = sweeps.filter((sweep) => isTradingSessionDate(sweep.marketDate));
  sweepState = { latest: validSweeps.at(-1) || null, today: validSweeps.filter((sweep) => sweep.marketDate === today) };
}

function indiaDate() {
  const now = indiaNow();
  return `${now.year}-${now.month}-${now.day}`;
}

function sweepSlots() {
  const slots = [];
  for (let minutes = sweepStartMinutes; minutes <= sweepEndMinutes; minutes += sweepIntervalMinutes) slots.push(minutes);
  return slots;
}

function timeLabel(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function nextSweepAt() {
  const now = indiaNow();
  const currentMinutes = Number(now.hour) * 60 + Number(now.minute);
  const tradingDay = isTradingSessionDate(indiaDate());
  const nextToday = tradingDay ? sweepSlots().find((slot) => slot > currentMinutes) : null;
  if (nextToday !== undefined && nextToday !== null) return `${indiaDate()}T${timeLabel(nextToday)}:00+05:30`;

  const base = new Date(`${indiaDate()}T12:00:00+05:30`);
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    if (isTradingSessionDate(candidate)) {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(candidate);
      return `${date}T${timeLabel(sweepSlots()[0])}:00+05:30`;
    }
  }
  return null;
}

async function loadScans() {
  const names = (await readdir(root)).filter((name) => /^positional-scan-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(root, name), 'utf8'))));
}

async function buildRegistry(historyCache = { symbols: {} }) {
  const scans = await loadScans();
  const existing = await readJson(registryPath, { version: 1, ideas: {} });
  const scanRows = new Map();
  for (const scan of scans) {
    for (const row of scan.rows) {
      scanRows.set(row.symbol, { ...row, scanDate: scan.asOf });
    }
  }

  const ideas = {};
  for (const stock of NIFTY50) {
    const previous = existing.ideas[stock.symbol];
    const row = scanRows.get(stock.symbol);
    const rawHistory = historyCache.symbols?.[stock.symbol]?.candles || previous?.history || [];
    const sanitized = sanitizeDailyCandles(rawHistory);
    const history = sanitized.candles;
    const latestHistory = history.at(-1);
    const candles = history.length ? history.slice(-5).map((candle) => candle.slice(1)) : row?.candles || [];
    const scanPrice = Number(row?.lastClose ?? latestHistory?.[4] ?? previous?.scanPrice ?? previous?.suggestedPrice ?? 0);
    const volumeWindow = history.slice(-20).map((candle) => Number(candle[5]) || 0);
    const latestVolume = Number(latestHistory?.[5] || 0);
    const averageVolume = volumeWindow.length ? volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length : 0;
    const firstObservedAt = previous?.suggestedAt || (row ? `${row.scanDate}T15:30:00+05:30` : historyCache.symbols?.[stock.symbol]?.updatedAt || new Date().toISOString());
    ideas[stock.symbol] = {
      ...stock,
      securityId: row?.query?.securityId ? String(row.query.securityId) : previous?.securityId || null,
      exchangeSegment: row?.query?.exchangeSegment || previous?.exchangeSegment || 'NSE_EQ',
      suggestedAt: firstObservedAt,
      suggestedPrice: Number(previous?.suggestedPrice || scanPrice),
      basis: previous?.basis || (row ? 'scan close' : 'universe admission'),
      latestScanAt: row?.scanDate || previous?.latestScanAt || null,
      scanPrice,
      fourSessionChangePct: Number(row?.fourSessionChangePct ?? (history.length >= 5 && history.at(-5)?.[4] ? ((scanPrice / history.at(-5)[4]) - 1) * 100 : 0)),
      scanVolumeRatio: Number(row?.volumeRatio ?? (averageVolume ? latestVolume / averageVolume : 1)),
      candles,
      history,
      historyQuality: sanitized.diagnostics,
    };
  }

  const registry = { version: 2, index: 'NIFTY 50', updatedAt: new Date().toISOString(), ideas };
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

let dailyHistory = await readJson(dailyHistoryPath, { version: 1, updatedAt: null, symbols: {} });
const registry = await buildRegistry(dailyHistory);
let fyersSession = await readJson(fyersSessionPath, {});
let strategyLedger = await readJson(strategySignalsPath, { version: 1, updatedAt: null, signals: [] });
strategyLedger.signals = (strategyLedger.signals || []).filter((signal) => isTradingSessionDate(signal.createdAt));
await loadMonitorState();
const snapshotQuotes = Object.fromEntries(Object.values(registry.ideas).map((idea) => [idea.symbol, snapshotQuote(idea)]));
const initialOrderBlocks = rankOrderBlocks(registry.ideas, snapshotQuotes, registry.updatedAt);
const initialCandidateBook = buildStrategyCandidates(registry.ideas, snapshotQuotes, initialOrderBlocks, registry.updatedAt);
const initialMarket = marketStatus();
const initialLedgerView = reconcileSignalLedger(strategyLedger.signals, initialCandidateBook, snapshotQuotes, registry.updatedAt, { advanceLifecycle: initialMarket.open });
strategyLedger = { version: 1, updatedAt: registry.updatedAt, signals: initialLedgerView.signals };
await writeFile(strategySignalsPath, `${JSON.stringify(strategyLedger, null, 2)}\n`);
let liveState = {
  provider: 'snapshot',
  connected: false,
  message: process.env.FYERS_APP_ID ? 'Connect your FYERS session to enable live prices.' : 'Add FYERS app credentials to enable live prices.',
  updatedAt: registry.updatedAt,
  market: initialMarket,
  auth: fyersAuthState(),
  monitor: monitorState(),
  quotes: snapshotQuotes,
  universe: publicUniverse(),
  orderBlocks: initialOrderBlocks,
  strategies: { ...initialCandidateBook, ...initialLedgerView, dataQuality: strategyDataQuality() },
};

function publicUniverse() {
  return Object.values(registry.ideas).map(({ history, ...idea }) => idea);
}

function strategyDataQuality() {
  const qualities = Object.values(registry.ideas).map((idea) => idea.historyQuality || {});
  const total = (key) => qualities.reduce((sum, quality) => sum + Number(quality[key] || 0), 0);
  const lastValidSession = qualities.map((quality) => quality.lastValidSession).filter(Boolean).sort().at(-1) || null;
  return {
    acceptedSessions: total('accepted'),
    rejectedRecords: total('rejected'),
    rejectedWeekend: total('weekend'),
    rejectedHoliday: total('holiday'),
    rejectedFuture: total('future'),
    rejectedIncomplete: total('incomplete'),
    rejectedDuplicate: total('duplicate'),
    rejectedInvalid: total('invalid'),
    rejectedClosedSessionSamples: historyMeta.rejectedClosedSession,
    lastValidSession,
    lifecycleFrozen: !marketStatus().open,
    policy: 'Completed NSE equity sessions only',
  };
}

function decodeTokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

function fyersAuthState() {
  const accessToken = process.env.FYERS_ACCESS_TOKEN || fyersSession.accessToken;
  return {
    configured: Boolean(process.env.FYERS_APP_ID && process.env.FYERS_SECRET_ID && process.env.FYERS_REDIRECT_URI),
    authenticated: Boolean(accessToken),
    refreshAvailable: Boolean(fyersSession.refreshToken),
    autoRefreshConfigured: Boolean(!process.env.FYERS_ACCESS_TOKEN && fyersSession.refreshToken && process.env.FYERS_PIN),
    refreshStatus: fyersRefreshError ? 'failed' : (!process.env.FYERS_ACCESS_TOKEN && fyersSession.refreshToken && process.env.FYERS_PIN) ? 'ready' : 'manual',
    refreshMessage: fyersRefreshError,
    expiresAt: accessToken ? decodeTokenExpiry(accessToken) : null,
    lastRefreshedAt: fyersSession.refreshedAt || null,
    loginPath: '/api/fyers/login',
  };
}

function monitorState() {
  return {
    pollMs,
    historyIntervalMs: historyMs,
    historyRetentionDays,
    historySamples: historyMeta.samples,
    lastHistoryAt: historyMeta.lastRecordedAt,
    recentAlerts,
    confirmPolls: alertConfirmPolls,
    hysteresisPct: signalHysteresis,
    sweep: {
      intervalMinutes: sweepIntervalMinutes,
      slots: sweepSlots().map(timeLabel),
      latest: sweepState.latest,
      today: sweepState.today,
      nextScheduledAt: nextSweepAt(),
    },
  };
}

function snapshotQuote(idea) {
  return {
    symbol: idea.symbol,
    lastPrice: idea.scanPrice,
    suggestedPrice: idea.suggestedPrice,
    suggestedAt: idea.suggestedAt,
    basis: idea.basis,
    performancePct: percentChange(idea.scanPrice, idea.suggestedPrice),
    dayChangePct: null,
    volume: null,
    volumeRatio: idea.scanVolumeRatio,
    signal: evaluateSignal(percentChange(idea.scanPrice, idea.suggestedPrice), null, idea.scanVolumeRatio),
    stale: true,
  };
}

function percentChange(current, basis) {
  return basis ? ((current / basis) - 1) * 100 : 0;
}

function evaluateSignal(performancePct, dayChangePct, volumeRatio, previousState = null) {
  if (previousState === 'Invalidated' && performancePct <= thresholds.invalidated + signalHysteresis) return { state: 'Invalidated', tone: 'risk', reason: `Down ${Math.abs(thresholds.invalidated)}% or more from suggestion` };
  if (previousState === 'At risk' && performancePct <= thresholds.warning + signalHysteresis && performancePct > thresholds.invalidated) return { state: 'At risk', tone: 'risk', reason: `Approaching the ${Math.abs(thresholds.invalidated)}% review threshold` };
  if (previousState === 'Extended' && performancePct >= thresholds.extended - signalHysteresis) return { state: 'Extended', tone: 'warm', reason: `Up ${thresholds.extended}% or more from suggestion` };
  if (previousState === 'Confirmed' && performancePct >= thresholds.confirmed - signalHysteresis && (volumeRatio || 0) >= 0.9) return { state: 'Confirmed', tone: 'strong', reason: 'Positive return with above-baseline volume' };
  if (previousState === 'Strengthening' && (dayChangePct || 0) >= 1 - signalHysteresis && (volumeRatio || 0) >= 0.9) return { state: 'Strengthening', tone: 'strong', reason: 'Price and volume are confirming today' };
  if (performancePct <= thresholds.invalidated) return { state: 'Invalidated', tone: 'risk', reason: `Down ${Math.abs(thresholds.invalidated)}% or more from suggestion` };
  if (performancePct <= thresholds.warning) return { state: 'At risk', tone: 'risk', reason: `Approaching the ${Math.abs(thresholds.invalidated)}% review threshold` };
  if (performancePct >= thresholds.extended) return { state: 'Extended', tone: 'warm', reason: `Up ${thresholds.extended}% or more from suggestion` };
  if (performancePct >= thresholds.confirmed && (volumeRatio || 0) >= 1) return { state: 'Confirmed', tone: 'strong', reason: 'Positive return with above-baseline volume' };
  if ((dayChangePct || 0) >= 1 && (volumeRatio || 0) >= 1) return { state: 'Strengthening', tone: 'strong', reason: 'Price and volume are confirming today' };
  if (performancePct >= 0) return { state: 'Advancing', tone: 'positive', reason: 'Trading above the suggestion basis' };
  return { state: 'Watching', tone: 'neutral', reason: 'Below basis but inside the review threshold' };
}

function fyersLoginUrl() {
  fyersOauthState = randomBytes(24).toString('hex');
  const params = new URLSearchParams({
    client_id: process.env.FYERS_APP_ID,
    redirect_uri: process.env.FYERS_REDIRECT_URI,
    response_type: 'code',
    state: fyersOauthState,
  });
  return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
}

async function exchangeFyersAuthCode(code) {
  const appIdHash = createHash('sha256').update(`${process.env.FYERS_APP_ID}:${process.env.FYERS_SECRET_ID}`).digest('hex');
  const response = await fetch('https://api-t1.fyers.in/api/v3/validate-authcode', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Thesis-Ledger/1.0' },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code }),
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.s !== 'ok' || !payload.access_token) throw new Error(payload.message || `FYERS authorization returned ${response.status}`);
  fyersSession = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    connectedAt: new Date().toISOString(),
  };
  await persistFyersSession();
  return fyersSession;
}

async function persistFyersSession() {
  await writeFile(fyersSessionPath, `${JSON.stringify(fyersSession, null, 2)}\n`, { mode: 0o600 });
  await chmod(fyersSessionPath, 0o600);
}

async function refreshFyersAccessToken() {
  if (process.env.FYERS_ACCESS_TOKEN) throw new Error('The manually configured FYERS token cannot be renewed automatically.');
  if (!fyersSession.refreshToken || !process.env.FYERS_PIN) throw new Error('Automatic renewal needs FYERS_PIN in the local .env file.');
  const appIdHash = createHash('sha256').update(`${process.env.FYERS_APP_ID}:${process.env.FYERS_SECRET_ID}`).digest('hex');
  const response = await fetch('https://api-t1.fyers.in/api/v3/validate-refresh-token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Thesis-Ledger/1.0' },
    body: JSON.stringify({ grant_type: 'refresh_token', appIdHash, refresh_token: fyersSession.refreshToken, pin: process.env.FYERS_PIN }),
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.s !== 'ok' || !payload.access_token) {
    fyersRefreshError = payload.message || `FYERS renewal returned ${response.status}`;
    throw new Error(fyersRefreshError);
  }
  fyersRefreshError = null;
  fyersSession = { ...fyersSession, accessToken: payload.access_token, refreshedAt: new Date().toISOString() };
  await persistFyersSession();
  return fyersSession.accessToken;
}

async function fetchFyersQuotes(allowRefresh = true) {
  const appId = process.env.FYERS_APP_ID;
  let accessToken = process.env.FYERS_ACCESS_TOKEN || fyersSession.accessToken;
  if (!appId || !accessToken) return null;
  const expiresAt = decodeTokenExpiry(accessToken);
  if (allowRefresh && expiresAt && new Date(expiresAt).getTime() - Date.now() < 5 * 60 * 1000 && fyersAuthState().autoRefreshConfigured) {
    accessToken = await refreshFyersAccessToken();
  }
  const symbols = Object.values(registry.ideas).map((idea) => idea.marketSymbol).join(',');
  const url = new URL('https://api-t1.fyers.in/data/quotes');
  url.searchParams.set('symbols', symbols);
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `${appId}:${accessToken}`, 'User-Agent': 'Thesis-Ledger/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.s !== 'ok') {
    const expired = response.status === 401 || [-8, -15, -16, -17].includes(Number(payload.code));
    if (expired && allowRefresh && fyersAuthState().autoRefreshConfigured) {
      await refreshFyersAccessToken();
      return fetchFyersQuotes(false);
    }
    if (expired) throw new Error('FYERS session expired. Reconnect from the dashboard.');
    throw new Error(payload.message || `FYERS quotes returned ${response.status}`);
  }
  return payload.d || [];
}

async function fetchFyersDailyHistory(idea, allowRefresh = true) {
  const appId = process.env.FYERS_APP_ID;
  let accessToken = process.env.FYERS_ACCESS_TOKEN || fyersSession.accessToken;
  if (!appId || !accessToken) throw new Error('Connect FYERS before refreshing strategy history.');
  const expiresAt = decodeTokenExpiry(accessToken);
  if (allowRefresh && expiresAt && new Date(expiresAt).getTime() - Date.now() < 5 * 60 * 1000 && fyersAuthState().autoRefreshConfigured) {
    accessToken = await refreshFyersAccessToken();
  }
  const rangeTo = indiaDate();
  const rangeFrom = new Date(Date.now() - 210 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = new URL('https://api-t1.fyers.in/data/history');
  url.searchParams.set('symbol', idea.marketSymbol);
  url.searchParams.set('resolution', 'D');
  url.searchParams.set('date_format', '1');
  url.searchParams.set('range_from', rangeFrom);
  url.searchParams.set('range_to', rangeTo);
  url.searchParams.set('cont_flag', '0');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `${appId}:${accessToken}`, 'User-Agent': 'Thesis-Ledger/1.0' },
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.s !== 'ok' || !Array.isArray(payload.candles)) {
    const expired = response.status === 401 || [-8, -15, -16, -17].includes(Number(payload.code));
    if (expired && allowRefresh && fyersAuthState().autoRefreshConfigured) {
      await refreshFyersAccessToken();
      return fetchFyersDailyHistory(idea, false);
    }
    throw new Error(payload.message || `FYERS history returned ${response.status}`);
  }
  const rawCandles = payload.candles.map((candle) => candle.slice(0, 6).map(Number));
  return sanitizeDailyCandles(rawCandles);
}

function applyHistoryToIdea(idea, history, diagnostics = null) {
  if (!history.length) return;
  idea.history = history;
  idea.historyQuality = diagnostics || sanitizeDailyCandles(history).diagnostics;
  idea.candles = history.slice(-5).map((candle) => candle.slice(1));
  idea.scanPrice = history.at(-1)[4];
  idea.fourSessionChangePct = history.length >= 5 ? percentChange(history.at(-1)[4], history.at(-5)[4]) : 0;
  const volumes = history.slice(-20).map((candle) => candle[5]);
  idea.scanVolumeRatio = history.at(-1)[5] / Math.max(volumes.reduce((sum, value) => sum + value, 0) / Math.max(volumes.length, 1), 1);
  if (!idea.suggestedPrice) {
    idea.suggestedPrice = idea.scanPrice;
    idea.suggestedAt = new Date().toISOString();
    idea.basis = 'universe admission';
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchFyersDailyHistoryWithRetry(idea) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await fetchFyersDailyHistory(idea);
    } catch (error) {
      lastError = error;
      const rateLimited = /rate-limit|request limit/i.test(error.message);
      if (!rateLimited || attempt === 3) throw error;
      await wait(1250 * (attempt + 1));
    }
  }
  throw lastError;
}

async function refreshHistoricalUniverse({ force = false } = {}) {
  if (strategyHistoryRefresh) return strategyHistoryRefresh;
  strategyHistoryRefresh = (async () => {
    const startedAt = new Date().toISOString();
    const targets = Object.values(registry.ideas).filter((idea) => {
      const cached = dailyHistory.symbols?.[idea.symbol];
      const stale = !cached?.updatedAt || Date.now() - new Date(cached.updatedAt).getTime() > 18 * 60 * 60 * 1000;
      return force || !cached?.candles?.length || cached.candles.length < 55 || stale;
    });
    const errors = [];
    let refreshed = 0;
    for (const idea of targets) {
      try {
          const { candles, diagnostics } = await fetchFyersDailyHistoryWithRetry(idea);
        if (candles.length) {
          const updatedAt = new Date().toISOString();
            dailyHistory.symbols[idea.symbol] = { updatedAt, candles, diagnostics };
            applyHistoryToIdea(idea, candles, diagnostics);
          refreshed += 1;
        } else {
          errors.push({ symbol: idea.symbol, error: 'No daily candles returned' });
        }
      } catch (error) {
        errors.push({ symbol: idea.symbol, error: error.message });
      }
      await wait(375);
    }
    dailyHistory = { ...dailyHistory, version: 1, updatedAt: new Date().toISOString(), symbols: dailyHistory.symbols || {} };
    registry.updatedAt = dailyHistory.updatedAt;
    await Promise.all([
      writeFile(dailyHistoryPath, `${JSON.stringify(dailyHistory)}\n`),
      writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`),
    ]);
    return { startedAt, completedAt: dailyHistory.updatedAt, requested: targets.length, refreshed, errors };
  })();
  try {
    return await strategyHistoryRefresh;
  } finally {
    strategyHistoryRefresh = null;
  }
}

async function updateStrategyState(quotes, orderBlocks, generatedAt, { advanceLifecycle = marketStatus().open } = {}) {
  const candidateBook = buildStrategyCandidates(registry.ideas, quotes, orderBlocks, generatedAt);
  const ledgerView = reconcileSignalLedger(strategyLedger.signals, candidateBook, quotes, generatedAt, { advanceLifecycle });
  if (ledgerView.changed) {
    strategyLedger = { version: 1, updatedAt: generatedAt, signals: ledgerView.signals };
    await writeFile(strategySignalsPath, `${JSON.stringify(strategyLedger, null, 2)}\n`);
  } else {
    strategyLedger.signals = ledgerView.signals;
  }
  return { ...candidateBook, ...ledgerView, dataQuality: strategyDataQuality() };
}

function normalizeQuotes(rows, market = marketStatus()) {
  const quotes = {};
  const bySymbol = new Map(rows.map((row) => [row.n, row.v || {}]));
  for (const idea of Object.values(registry.ideas)) {
    const raw = bySymbol.get(idea.marketSymbol);
    if (!raw) { quotes[idea.symbol] = snapshotQuote(idea); continue; }
    const stale = !market.open || !isQuoteTimestampInActiveSession(raw.tt, new Date());
    if (stale) {
      quotes[idea.symbol] = { ...snapshotQuote(idea), lastTradeTime: raw.tt, marketSymbol: idea.marketSymbol, stale: true };
      continue;
    }
    const lastPrice = Number(raw.lp);
    const previousClose = Number(raw.prev_close_price);
    const volumeCandles = idea.history?.length ? idea.history.slice(-20).map((candle) => Number(candle[5]) || 0) : (idea.candles || []).map((candle) => Number(candle[4]) || 0);
    const averageVolume = volumeCandles.reduce((sum, volume) => sum + volume, 0) / Math.max(volumeCandles.length, 1);
    const volumeRatio = raw.volume ? Number(raw.volume) / averageVolume : idea.scanVolumeRatio;
    const performancePct = percentChange(lastPrice, idea.suggestedPrice);
    const dayChangePct = previousClose ? percentChange(lastPrice, previousClose) : null;
    const previousSignal = lastSignals.get(idea.symbol);
    const candidate = evaluateSignal(performancePct, dayChangePct, volumeRatio, previousSignal?.state);
    let signal = candidate;
    if (!previousSignal) {
      lastSignals.set(idea.symbol, candidate);
    } else if (candidate.state === previousSignal.state) {
      pendingSignals.delete(idea.symbol);
      lastSignals.set(idea.symbol, candidate);
    } else {
      const pending = pendingSignals.get(idea.symbol);
      const next = pending?.state === candidate.state ? { state: candidate.state, count: pending.count + 1 } : { state: candidate.state, count: 1 };
      if (next.count >= alertConfirmPolls) {
        lastSignals.set(idea.symbol, candidate);
        pendingSignals.delete(idea.symbol);
      } else {
        pendingSignals.set(idea.symbol, next);
        signal = previousSignal;
      }
    }
    quotes[idea.symbol] = {
      symbol: idea.symbol, lastPrice, suggestedPrice: idea.suggestedPrice, suggestedAt: idea.suggestedAt,
      basis: idea.basis, performancePct, dayChangePct, volume: Number(raw.volume) || null,
      volumeRatio, signal,
      ohlc: { open: raw.open_price, high: raw.high_price, low: raw.low_price, close: raw.prev_close_price },
      lastTradeTime: raw.tt, marketSymbol: idea.marketSymbol, stale,
    };
  }
  return quotes;
}

async function recordSignalChanges(quotes, previousSignals) {
  const events = [];
  for (const quote of Object.values(quotes)) {
    const previous = previousSignals.get(quote.symbol)?.state;
    const current = quote.signal.state;
    if (previous && previous !== current) events.push(normalizeEvent({ at: new Date().toISOString(), symbol: quote.symbol, from: previous, to: current, price: quote.lastPrice, performancePct: quote.performancePct, reason: quote.signal.reason }));
  }
  if (events.length) {
    await appendFile(eventsPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
    recentAlerts = [...events].reverse().concat(recentAlerts).slice(0, 20);
  }
  return events;
}

async function recordPriceHistory(quotes, market) {
  if (!market.open) return;
  const today = `${indiaNow().year}-${indiaNow().month}-${indiaNow().day}`;
  const lastDay = historyMeta.lastRecordedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(historyMeta.lastRecordedAt)) : null;
  if (lastDay === today && historyMeta.lastRecordedAt && Date.now() - new Date(historyMeta.lastRecordedAt).getTime() < historyMs) return;
  const sample = {
    at: new Date().toISOString(),
    quotes: Object.fromEntries(Object.values(quotes).map((quote) => [quote.symbol, {
      price: quote.lastPrice,
      performancePct: quote.performancePct,
      dayChangePct: quote.dayChangePct,
      volumeRatio: quote.volumeRatio,
      signal: quote.signal.state,
    }])),
  };
  await appendFile(historyPath, `${JSON.stringify(sample)}\n`);
  historyMeta = { samples: historyMeta.samples + 1, lastRecordedAt: sample.at };
}

async function getSymbolHistory(symbol, limit = 180) {
  const samples = await readJsonLines(historyPath);
  return samples.flatMap((sample) => sample.quotes?.[symbol] ? [{ at: sample.at, ...sample.quotes[symbol] }] : []).slice(-limit);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sweepAction(quote) {
  if (['Invalidated', 'At risk'].includes(quote.signal.state)) return { lane: 'Risk review', priority: 4, thesis: 'Protect capital and review the original invalidation case.' };
  if (quote.signal.state === 'Extended') return { lane: 'Manage strength', priority: 3, thesis: 'Momentum is mature; review sizing and avoid chasing.' };
  if (['Confirmed', 'Strengthening'].includes(quote.signal.state)) return { lane: 'Action now', priority: 5, thesis: 'Price and participation are aligned with the thesis.' };
  if (quote.signal.state === 'Advancing' || (quote.dayChangePct || 0) > 0.75) return { lane: 'Watch closely', priority: 2, thesis: 'Direction is constructive but confirmation is incomplete.' };
  return { lane: 'No action', priority: 1, thesis: 'Evidence has not cleared an action threshold.' };
}

function sweepScore(quote) {
  const base = 50 + clamp(quote.performancePct, -8, 8) * 4 + clamp(quote.dayChangePct || 0, -4, 4) * 5 + clamp((quote.volumeRatio || 1) - 1, -1, 3) * 10;
  const stateAdjustment = { Invalidated: -22, 'At risk': -12, Watching: -4, Advancing: 3, Strengthening: 12, Confirmed: 16, Extended: 8 }[quote.signal.state] || 0;
  return Math.round(clamp(base + stateAdjustment, 0, 100));
}

async function runSweep(quotes, { source = 'scheduled', scheduledMinutes = null } = {}) {
  const marketDate = indiaDate();
  const ranAt = new Date().toISOString();
  const scheduledLabel = scheduledMinutes === null ? null : timeLabel(scheduledMinutes);
  const ranked = Object.values(quotes).map((quote) => {
    const action = sweepAction(quote);
    return {
      symbol: quote.symbol,
      price: quote.lastPrice,
      performancePct: quote.performancePct,
      dayChangePct: quote.dayChangePct,
      volumeRatio: quote.volumeRatio,
      state: quote.signal.state,
      tone: quote.signal.tone,
      reason: quote.signal.reason,
      lane: action.lane,
      thesis: action.thesis,
      priority: action.priority,
      score: sweepScore(quote),
    };
  }).sort((a, b) => b.priority - a.priority || b.score - a.score);
  const actionCounts = ranked.reduce((counts, item) => ({ ...counts, [item.lane]: (counts[item.lane] || 0) + 1 }), {});
  const sweep = {
    id: source === 'scheduled' ? `${marketDate}-${scheduledLabel}` : `${marketDate}-manual-${Date.now()}`,
    marketDate,
    scheduledAt: scheduledLabel ? `${marketDate}T${scheduledLabel}:00+05:30` : null,
    ranAt,
    source,
    universeSize: ranked.length,
    breadth: ranked.filter((item) => item.performancePct >= 0).length,
    averagePerformancePct: ranked.reduce((sum, item) => sum + item.performancePct, 0) / (ranked.length || 1),
    actionCounts,
    ranked,
  };
  await appendFile(sweepsPath, `${JSON.stringify(sweep)}\n`);
  sweepState = { latest: sweep, today: [...sweepState.today.filter((item) => item.id !== sweep.id), sweep] };
  return sweep;
}

async function maybeRunScheduledSweep(quotes, market) {
  if (!market.open) return null;
  const now = indiaNow();
  const currentMinutes = Number(now.hour) * 60 + Number(now.minute);
  const eligible = sweepSlots().filter((slot) => slot <= currentMinutes);
  const slot = eligible.at(-1);
  if (slot === undefined) return null;
  const id = `${indiaDate()}-${timeLabel(slot)}`;
  if (sweepState.today.some((sweep) => sweep.id === id)) return null;
  return runSweep(quotes, { source: 'scheduled', scheduledMinutes: slot });
}

function broadcast() {
  const message = `data: ${JSON.stringify(liveState)}\n\n`;
  for (const response of clients) response.write(message);
}

async function pollMarket() {
  if (polling) return;
  polling = true;
  try {
    const market = marketStatus();
    const data = await fetchFyersQuotes();
    if (!data) {
      const updatedAt = new Date().toISOString();
      const orderBlocks = rankOrderBlocks(registry.ideas, liveState.quotes, updatedAt);
      const strategies = await updateStrategyState(liveState.quotes, orderBlocks, updatedAt, { advanceLifecycle: market.open });
      liveState = { ...liveState, provider: process.env.FYERS_APP_ID ? 'FYERS' : 'snapshot', auth: fyersAuthState(), market, updatedAt, universe: publicUniverse(), orderBlocks, strategies };
    } else {
      const previousSignals = new Map(lastSignals);
      const quotes = normalizeQuotes(data, market);
      if (market.open) {
        await recordSignalChanges(quotes, previousSignals);
        await recordPriceHistory(quotes, market);
        await maybeRunScheduledSweep(quotes, market);
      }
      const updatedAt = new Date().toISOString();
      const orderBlocks = rankOrderBlocks(registry.ideas, quotes, updatedAt);
      const strategies = await updateStrategyState(quotes, orderBlocks, updatedAt, { advanceLifecycle: market.open });
      const message = market.open ? 'FYERS live quote feed connected.' : `${market.reason} Incoming quotes are marked stale and cannot advance signals.`;
      liveState = { provider: 'FYERS', connected: true, message, updatedAt, market, auth: fyersAuthState(), monitor: monitorState(), quotes, universe: publicUniverse(), orderBlocks, strategies };
    }
  } catch (error) {
    liveState = { ...liveState, connected: false, provider: 'FYERS', updatedAt: new Date().toISOString(), market: marketStatus(), auth: fyersAuthState(), monitor: monitorState(), message: error.message };
  } finally {
    polling = false;
    broadcast();
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const safePath = normalize(join(root, 'dist', requested));
  if (!safePath.startsWith(join(root, 'dist'))) return sendJson(response, 403, { error: 'Forbidden' });
  try {
    const info = await stat(safePath);
    const finalPath = info.isDirectory() ? join(safePath, 'index.html') : safePath;
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(finalPath)] || 'application/octet-stream' });
    response.end(await readFile(finalPath));
  } catch {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(await readFile(join(root, 'dist', 'index.html')));
  }
}

async function handler(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/fyers/status') return sendJson(response, 200, { ...fyersAuthState(), provider: liveState.provider, connected: liveState.connected, message: liveState.message });
  if (url.pathname === '/api/fyers/login') {
    if (!fyersAuthState().configured) return sendJson(response, 400, { error: 'Add FYERS_APP_ID, FYERS_SECRET_ID and FYERS_REDIRECT_URI to .env, then restart the dashboard.' });
    response.writeHead(302, { Location: fyersLoginUrl(), 'Cache-Control': 'no-store' });
    return response.end();
  }
  if (url.pathname === '/api/fyers/callback') {
    try {
      const code = url.searchParams.get('auth_code');
      const state = url.searchParams.get('state');
      if (!code) throw new Error('FYERS did not return an authorization code.');
      if (!fyersOauthState || state !== fyersOauthState) throw new Error('The FYERS login state did not match. Start the connection again from this dashboard.');
      fyersOauthState = null;
      await exchangeFyersAuthCode(code);
      await pollMarket();
      response.writeHead(302, { Location: '/?fyers=connected', 'Cache-Control': 'no-store' });
      return response.end();
    } catch (error) {
      response.writeHead(302, { Location: `/?fyers=error&message=${encodeURIComponent(error.message)}`, 'Cache-Control': 'no-store' });
      return response.end();
    }
  }
  if (url.pathname === '/api/live') return sendJson(response, 200, liveState);
  if (url.pathname === '/api/ideas') return sendJson(response, 200, registry);
  if (url.pathname === '/api/order-blocks') return sendJson(response, 200, liveState.orderBlocks);
  if (url.pathname === '/api/strategies' && request.method === 'GET') return sendJson(response, 200, liveState.strategies);
  if (url.pathname === '/api/strategies/history/refresh' && request.method === 'POST') {
    if (!fyersAuthState().authenticated) return sendJson(response, 409, { error: 'Connect FYERS before refreshing daily strategy history.' });
    const result = await refreshHistoricalUniverse({ force: url.searchParams.get('force') === '1' });
    await pollMarket();
    return sendJson(response, 200, { result, strategies: liveState.strategies });
  }
  if (url.pathname === '/api/alerts') return sendJson(response, 200, { alerts: recentAlerts });
  if (url.pathname === '/api/sweeps' && request.method === 'GET') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 20)));
    const sweeps = await readJsonLines(sweepsPath);
    return sendJson(response, 200, { sweeps: sweeps.slice(-limit).reverse(), schedule: monitorState().sweep });
  }
  if (url.pathname === '/api/sweeps/run' && request.method === 'POST') {
    if (!liveState.connected) return sendJson(response, 409, { error: 'The FYERS quote feed must be connected before running a sweep.' });
    if (!liveState.market?.open) return sendJson(response, 409, { error: 'Sweeps run only during an active NSE equity session. Weekend and holiday data is ignored.' });
    const sweep = await runSweep(liveState.quotes, { source: 'manual' });
    liveState = { ...liveState, monitor: monitorState(), updatedAt: new Date().toISOString() };
    broadcast();
    return sendJson(response, 201, { sweep });
  }
  if (url.pathname === '/api/history') {
    const symbol = String(url.searchParams.get('symbol') || '').toUpperCase();
    if (!registry.ideas[symbol]) return sendJson(response, 400, { error: 'Choose a tracked symbol.' });
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 180)));
    return sendJson(response, 200, { symbol, points: await getSymbolHistory(symbol, limit), intervalMs: historyMs });
  }
  if (url.pathname === '/api/health') return sendJson(response, 200, { ok: true, provider: liveState.provider, connected: liveState.connected, ideas: Object.keys(registry.ideas).length, updatedAt: liveState.updatedAt, monitor: monitorState() });
  if (url.pathname === '/api/stream') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write(`data: ${JSON.stringify(liveState)}\n\n`);
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (isDev) return vite.middlewares(request, response);
  return serveStatic(request, response);
}

if (isDev) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'spa' });
}

await pollMarket();
pollTimer = setInterval(pollMarket, pollMs);
const server = createServer((request, response) => handler(request, response).catch((error) => sendJson(response, 500, { error: error.message })));
server.listen(port, '127.0.0.1', () => console.log(`Thesis Ledger running at http://127.0.0.1:${port} (${liveState.provider})`));

if (fyersAuthState().authenticated) {
  refreshHistoricalUniverse().then(() => pollMarket()).catch((error) => console.error(`Strategy history refresh failed: ${error.message}`));
}

function shutdown() {
  clearInterval(pollTimer);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
