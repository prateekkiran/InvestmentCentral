# Thesis Ledger

Thesis Ledger is a local dashboard for tracking every idea in `positional-scan-*.json`. It preserves the first recorded scan close as the suggestion basis, merges later scans without resetting that basis, and streams FYERS market quotes into the browser.

## Start the dashboard

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

For the production build:

```bash
npm run build
npm start
```

## Create the FYERS market-data app

1. Sign in to the [FYERS API Dashboard](https://fyers.in/web/api-dashboard/user-apps).
2. Create or activate an app intended for this personal dashboard.
3. Enable Market Data permissions: Quotes, Historical Data, and Market Depth. The dashboard does not place, modify, or cancel orders.
4. Register this redirect URL exactly:

   ```text
   http://127.0.0.1:5173/api/fyers/callback
   ```

5. Copy `.env.example` to `.env`.
6. Enter the App ID and Secret directly in `.env`:

   ```text
   FYERS_APP_ID=XXXXXXXXX-100
   FYERS_SECRET_ID=your-app-secret
   FYERS_REDIRECT_URI=http://127.0.0.1:5173/api/fyers/callback
   ```

7. Restart `npm run dev`.
8. Select **Connect FYERS** in the dashboard status bar. Sign in on FYERS and approve the app. FYERS redirects back to the local dashboard, where the server exchanges the authorization code and starts the quote feed.

The App Secret and tokens remain on the local Node server. They are never included in the frontend bundle, browser storage, or CSV export. The local OAuth session is stored with owner-only file permissions in `data/fyers-session.json`, which is ignored by Git.

FYERS sessions are checked by API liveness rather than assumed to last indefinitely. The server can attempt the official refresh-token exchange when a refresh token is available and `FYERS_PIN` is present in the local `.env` file:

```text
FYERS_PIN=your-private-fyers-pin
```

Enter the PIN directly in `.env`; do not paste it into the browser or commit it. Restart the server after adding it. The dashboard's Monitor desk will then report **FYERS renewal: Automatic**. FYERS notes that the refresh-token flow has limited availability and may be discontinued, so the reconnect flow remains the reliable fallback. If renewal fails or the refresh token expires, use **Reconnect FYERS**.

Without an authenticated FYERS session, the dashboard clearly runs in snapshot mode using the latest scan close.

## Symbol mapping

The existing scan symbols are mapped to FYERS NSE cash-market symbols using the `NSE:<symbol>-EQ` convention. For example:

```text
PERSISTENT -> NSE:PERSISTENT-EQ
COFORGE    -> NSE:COFORGE-EQ
```

The FYERS Quotes API validates these symbols when the feed connects.

## Market-data behavior

The server calls FYERS v3 `GET /data/quotes` with all tracked symbols in one request every five seconds. FYERS returns LTP, daily change, previous close, OHLC, and volume. The browser receives normalized updates through the local `/api/stream` event stream.

This cadence is intended for an investment-idea dashboard and signal monitor. Tick-level strategies should use the FYERS Market Data WebSocket instead of increasing REST polling frequency.

## Performance basis

The first appearance of a symbol is written to `data/ideas.json` with:

- `suggestedAt`: the scan date at the NSE close
- `suggestedPrice`: the scan's recorded close
- `basis`: `scan close`
- `marketSymbol`: the FYERS instrument symbol

Later scan files update the latest signal evidence but do not overwrite the original suggestion fields. If an idea is intentionally reissued as a new thesis, it should receive a separate thesis identifier in a future schema rather than resetting this record.

## Monitor states

The local server evaluates these default states after every quote update:

- `Invalidated`: return is at or below -5%
- `At risk`: return is at or below -3%
- `Extended`: return is at or above +5%
- `Confirmed`: return is at or above +2% with volume at or above its five-session baseline
- `Strengthening`: today's gain is at or above +1% with volume at or above baseline
- `Advancing`: price is above the suggestion basis
- `Watching`: price is below basis but above the warning threshold

The main return thresholds can be changed in `.env`. State transitions are appended to `data/monitor-events.jsonl`; repeated quote ticks with the same state are not logged.

To prevent threshold noise, a new candidate state must remain present for three consecutive quote polls before it is committed. A 0.25 percentage-point hysteresis buffer also keeps a committed state stable when price moves narrowly around its boundary. Configure these values with `ALERT_CONFIRM_POLLS` and `SIGNAL_HYSTERESIS_PCT`.

Material transitions into `At risk`, `Invalidated`, `Confirmed`, or `Extended` are eligible for browser notifications. Notifications are opt-in through **Enable browser alerts** in the Monitor desk and work while the dashboard is open, including when its tab is in the background. Every confirmed transition remains visible in the local activity console regardless of notification permission.

## Durable quote history

While the regular market is open, the server records one normalized quote snapshot per minute in `data/quote-history.jsonl`. Quotes received outside an active NSE equity session are treated as stale display snapshots and are never written to signal history. The archive is local, excluded from Git, and retained for 30 days by default.

```text
HISTORY_INTERVAL_MS=60000
HISTORY_RETENTION_DAYS=30
```

Opening an idea shows its recorded intraday price history above the original five-session scan chart. History collection continues while the Node process is running, even if the dashboard tab is closed.

## Two-hour stock sweeps

The server performs scheduled sweeps of every stock in the tracked idea registry at these NSE times:

- 09:15 IST
- 11:15 IST
- 13:15 IST
- 15:15 IST

The default cadence is controlled with:

```text
SWEEP_INTERVAL_MINUTES=120
```

At the first quote poll after a scheduled slot, the sweep ranks the connected universe with transparent inputs: performance from the immutable suggestion basis, current-day price change, volume relative to the recorded five-session baseline, and the stabilized monitor state. Each stock is assigned to one of five lanes:

- `Action now`: price and participation are aligned
- `Watch closely`: constructive direction without full confirmation
- `Risk review`: warning or invalidation criteria are active
- `Manage strength`: performance is extended from basis
- `No action`: evidence has not cleared an action threshold

Completed sweeps are appended to `data/stock-sweeps.jsonl`, which is ignored by Git. If the server starts after a scheduled slot while the market is open, it runs the most recent missed slot. The dashboard also provides **Run sweep now** for an immediate local snapshot.

## Order block decision desk

The Order block desk turns each idea's recorded five-session daily OHLCV sequence into a transparent supply-or-demand setup. It looks for the last opposing candle before a directional displacement of at least 0.25%, then ranks the setup using displacement, impulse volume, base recency, live direction, and distance from the zone. When no strict opposing-candle setup is available, the most compact base candle is retained as a lower-confidence monitoring candidate capped at 58/100.

For each stock the dashboard shows:

- the detected bullish demand or bearish supply zone
- current state: `In zone`, `Approaching`, `Confirmed`, `Monitoring`, `Extended`, or `Invalidated`
- structural invalidation and two calculated review objectives
- a confidence score and the evidence used to calculate it
- a five-candle chart with the zone and decision levels overlaid

The server recalculates the book after every quote poll, so the original daily zone stays stable while the current FYERS price, live volume ratio, proximity, and state update. The same fields are included in CSV exports and in the selected-idea drawer.

This is a deterministic research aid, not a proprietary institutional order-flow feed or an instruction to trade. The detected zones use the scan's five daily candles; intraday order blocks would require storing and evaluating intraday OHLCV history.

## Nifty 50 strategy engine

The tracked universe is the full 50-stock Nifty 50 list, rather than only the symbols found in a positional scan file. The explicit constituent catalog lives in `src/nifty50.js`; update it deliberately when NSE announces an index rebalance.

When FYERS is connected, the server fetches and caches roughly seven months of completed daily OHLCV candles for every constituent. Requests are paced and retried because FYERS applies a short-window historical-data rate limit. The local cache is stored in `data/daily-history.json`, excluded from Git, and refreshed when it is missing or more than 18 hours old. At least 55 completed sessions are required before a stock is eligible for a precision strategy.

The multi-strategy engine currently evaluates:

- **Momentum:** aligned 20/50-day exponential averages, 20-session rate of change, breakout proximity, RSI, ATR, and relative volume.
- **Mean reversion:** distance from the 20-day mean, two-standard-deviation stretch, RSI exhaustion, reversal-candle evidence, volume, and an intact 50-day trend.
- **Order block:** a strict opposing-candle demand zone with acceptable proximity, participation, evidence score, and at least 2R structural reward.

Momentum and mean-reversion setups must score at least 72/100. Order-block candidates use the same 72-point minimum and must also be strict patterns with at least 2R modelled reward. If no setup passes every gate, the correct output is no signal; the engine does not force every constituent into an action.

Every accepted setup defines an entry zone, stop loss, first target, final target, expiry, evidence, and current action. The durable ledger in `data/strategy-signals.json` follows the setup through these states:

- `Waiting`: qualified but price has not entered the planned zone
- `Active`: the entry zone has been reached
- `Target 1`: the first objective has been reached; manage or trail the remainder
- `Target 2`: the final objective has been reached
- `Stopped`: the defined stop-loss was reached
- `Cancelled`: invalidated before entry or no longer clears the precision gate
- `Expired`: the entry window elapsed without a valid trigger

Ledger events are retained instead of deleting failed or completed signals. Strategy scores rank the strength of observable evidence; they are not win probabilities. The dashboard does not place orders.

### Session and data-integrity policy

The strategy engine admits only completed NSE equity sessions. Daily rows are validated before indicator calculation and rejected when they are malformed, duplicated, dated in the future, attached to a Saturday or Sunday, attached to an exchange-declared holiday, or still represent the current incomplete session. The same sanitizer runs when FYERS history is fetched, when cached history is loaded, and again inside the strategy engine as defense in depth.

The included 2026 calendar follows the official NSE capital-market holiday schedule. Special sessions, such as Muhurat trading, are represented separately from regular sessions: a completed historical candle can be admitted for a recognized special trading date, but live signal processing remains frozen until the exchange's exact session window has been explicitly configured. The calendar catalog should be updated from the official NSE circular before each new calendar year.

When the exchange is closed:

- fresh candidates are not promoted into the ledger
- stale quote snapshots cannot trigger entries, targets, stops, cancellations, or monitor-state changes
- manual and scheduled stock sweeps remain disabled
- the dashboard labels the lifecycle as frozen and reports the next eligible trading date

Expiry is measured in trading sessions rather than calendar days, so weekends and declared holidays do not shorten a setup's opportunity window. On startup, persisted quote history, alerts, and sweeps from invalid session dates are excluded from the active dashboard. The Strategy desk exposes accepted-session coverage and every rejection category so a user can inspect the evidence boundary instead of assuming that all vendor rows were valid.

## Local endpoints

- `GET /api/health`: process and feed health
- `GET /api/ideas`: durable idea registry
- `GET /api/live`: current quote and signal snapshot
- `GET /api/order-blocks`: ranked order block decision book
- `GET /api/strategies`: qualified candidates and the durable setup lifecycle ledger
- `POST /api/strategies/history/refresh`: refresh missing or stale Nifty 50 daily history
- `GET /api/stream`: server-sent event stream used by the frontend
- `GET /api/alerts`: recent durable signal transitions
- `GET /api/history?symbol=HAL&limit=180`: recorded local price samples for one tracked symbol
- `GET /api/sweeps?limit=20`: persisted sweep history and schedule
- `POST /api/sweeps/run`: immediately rank the current connected quote snapshot
- `GET /api/fyers/status`: FYERS configuration and session status
- `GET /api/fyers/login`: starts the FYERS authorization flow
- `GET /api/fyers/callback`: registered OAuth redirect target

The monitor runs only while the Node process is running. A laptop that sleeps or shuts down cannot continue collecting quotes; continuous unattended monitoring needs the server to run on an always-on machine or hosted service.
