import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  ArrowsClockwise,
  BookmarkSimple,
  Bell,
  BellRinging,
  CaretLeft,
  CaretRight,
  Check,
  ClockCounterClockwise,
  Crosshair,
  Database,
  DownloadSimple,
  Funnel,
  MagnifyingGlass,
  NotePencil,
  Pulse,
  ShieldCheck,
  Star,
  Timer,
  TrendDown,
  TrendUp,
  WifiHigh,
  WifiSlash,
  X,
} from '@phosphor-icons/react';
import { rankOrderBlocks } from './orderBlocks.js';
gsap.registerPlugin(ScrollTrigger, useGSAP);

const STORAGE_KEY = 'thesis-ledger-state-v1';
const ALERTS_KEY = 'thesis-ledger-browser-alerts-v1';
const formatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const statuses = ['Inbox', 'Researching', 'Watching', 'Archived'];
const scanFiles = import.meta.glob('../positional-scan-*.json', { eager: true, import: 'default' });
const scans = Object.values(scanFiles).sort((a, b) => a.asOf.localeCompare(b.asOf));
const latestRows = new Map();
scans.forEach((scan) => scan.rows.forEach((row) => latestRows.set(row.symbol, { ...row, scanDate: scan.asOf })));
const source = {
  asOf: scans.at(-1)?.asOf || new Date().toISOString().slice(0, 10),
  rows: [...latestRows.values()],
};
const initialLiveState = {
  provider: 'snapshot', connected: false, updatedAt: null,
  market: { open: false, label: 'Checking market' }, quotes: {},
  universe: [],
  auth: {}, monitor: { recentAlerts: [], historySamples: 0 },
  orderBlocks: { setups: [], bullish: [], bearish: [], counts: {} },
  strategies: { signals: [], active: [], waiting: [], closed: [], candidates: [], counts: {}, universeSize: 50, historyReady: 0, dataQuality: {} },
  message: 'Connecting to the local monitor…',
};

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function Sparkline({ candles, id, large = false }) {
  if (!candles?.length || candles.length < 2) return <div className="history-empty">Daily history is being prepared.</div>;
  const closes = candles.map((candle) => candle[3]);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const width = large ? 720 : 240;
  const height = large ? 210 : 74;
  const points = closes
    .map((value, index) => `${(index / (closes.length - 1)) * width},${height - ((value - min) / (max - min || 1)) * (height - 12) - 6}`)
    .join(' ');
  const area = `0,${height} ${points} ${width},${height}`;

  return (
    <svg className={large ? 'sparkline sparkline--large' : 'sparkline'} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${id} five-session closing price trend`}>
      <defs>
        <linearGradient id={`fade-${id}-${large}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d7ff63" stopOpacity=".3" />
          <stop offset="100%" stopColor="#d7ff63" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#fade-${id}-${large})`} />
      <polyline points={points} fill="none" stroke="#d7ff63" strokeWidth={large ? 3 : 2} vectorEffect="non-scaling-stroke" />
      {large && closes.map((value, index) => {
        const x = (index / (closes.length - 1)) * width;
        const y = height - ((value - min) / (max - min || 1)) * (height - 12) - 6;
        return <circle key={index} cx={x} cy={y} r="5" fill="#111310" stroke="#d7ff63" strokeWidth="3" />;
      })}
    </svg>
  );
}

function MarketMarquee({ ideas }) {
  const entries = ideas.slice(0, 18);
  if (!entries.length) return null;
  return (
    <div className="market-marquee" aria-label="Nifty 50 market tape">
      <div className="market-marquee__track">
        {[...entries, ...entries].map((idea, index) => (
          <span key={`${idea.symbol}-${index}`} aria-hidden={index >= entries.length}>
            <b>{idea.symbol}</b>
            <i className={idea.performancePct >= 0 ? 'positive' : 'negative'}>{idea.performancePct >= 0 ? '+' : ''}{idea.performancePct.toFixed(2)}%</i>
            <small>{idea.liveVolumeRatio.toFixed(2)}×</small>
          </span>
        ))}
      </div>
    </div>
  );
}

function DashboardHero({ market }) {
  return (
    <section className="terminal-hero shell" aria-labelledby="dashboard-title">
      <div className="terminal-hero__ambient" aria-hidden="true" />
      <p className="terminal-hero__eyebrow">Nifty 50 decision intelligence</p>
      <h1 id="dashboard-title">
        Read the market.
        <span>Track the <span className="hero-inline-chart" aria-hidden="true"><svg viewBox="0 0 180 52"><path d="M4 40 L28 33 L51 37 L76 19 L101 25 L126 9 L151 14 L176 4" /><circle cx="176" cy="4" r="4" /></svg></span> thesis.</span>
      </h1>
      <p className="terminal-hero__copy">One research surface for qualified setups, explicit risk, and an immutable path from entry zone to final outcome.</p>
      <div className="terminal-hero__actions">
        <a className="hero-action hero-action--primary" href="#strategies">Review strategy ledger <ArrowDown size={17} /></a>
        <a className="hero-action hero-action--secondary" href="#monitor">Inspect data integrity <ArrowRight size={17} /></a>
      </div>
      <div className="terminal-hero__session"><span className={market?.open ? 'market-dot open' : 'market-dot'} /><strong>{market?.open ? 'Signals advancing' : 'Lifecycle frozen'}</strong><span>{market?.reason || market?.label || 'Checking NSE session'}</span></div>
    </section>
  );
}

function StrategyDesk({ book, onOpen }) {
  const [filter, setFilter] = useState('All');
  const visible = (book.signals || []).filter((signal) => filter === 'All' || signal.strategy === filter);
  const staged = (book.candidates || []).filter((candidate) => filter === 'All' || candidate.strategy === filter);
  const [selectedId, setSelectedId] = useState(visible[0]?.id || null);
  const selected = visible.find((signal) => signal.id === selectedId) || visible[0];
  useEffect(() => {
    if (selected && !visible.some((signal) => signal.id === selectedId)) setSelectedId(visible[0]?.id || null);
  }, [filter, selectedId, visible, selected]);
  const completion = book.universeSize ? Math.round((book.historyReady / book.universeSize) * 100) : 0;
  const quality = book.dataQuality || {};
  const filters = ['All', 'Momentum', 'Mean reversion', 'Order block'];
  const events = selected?.events || [];
  const [eventIndex, setEventIndex] = useState(Math.max(0, events.length - 1));
  useEffect(() => setEventIndex(Math.max(0, (selected?.events?.length || 1) - 1)), [selected?.id, selected?.events?.length]);
  const auditEvent = events[eventIndex] || events.at(-1);
  return (
    <section className="strategy-section" id="strategies" aria-labelledby="strategy-title">
      <div className="strategy-heading">
        <div><span>Multi-strategy engine</span><h2 id="strategy-title">The evidence floor is high by design.</h2><p>Momentum, mean reversion, and order-block structure compete for attention. Only completed NSE sessions can change the ledger.</p></div>
        <div className="strategy-coverage"><strong>{book.historyReady || 0}<small>/ {book.universeSize || 50}</small></strong><span>history ready · {completion}%</span></div>
      </div>
      <div className="strategy-bento" aria-label="Strategy and data quality summary">
        <div className="strategy-bento__coverage">
          <div><span>Evidence coverage</span><strong>{completion}%</strong><p>{formatter.format(quality.acceptedSessions || 0)} completed daily sessions across the Nifty 50 are eligible for analysis.</p></div>
          <div className="coverage-orbit" style={{ '--coverage': `${completion * 3.6}deg` }}><span>{book.historyReady || 0}<small>stocks</small></span></div>
          <footer><ShieldCheck size={18} /><span>{quality.policy || 'Completed NSE equity sessions only'}</span><b>{quality.lastValidSession || 'Awaiting history'}</b></footer>
        </div>
        <div><span>Active setups</span><strong>{book.active?.length || 0}</strong><small>inside planned entry</small></div>
        <div><span>Waiting</span><strong>{book.waiting?.length || 0}</strong><small>qualified, not triggered</small></div>
        <div><span>Resolved</span><strong>{(book.counts?.['Target 1'] || 0) + (book.counts?.['Target 2'] || 0) + (book.counts?.Stopped || 0)}</strong><small>targets and defined exits</small></div>
        <div className="strategy-bento__quality"><span>Rejected inputs</span><strong>{quality.rejectedRecords || 0}</strong><small>{quality.lifecycleFrozen ? 'lifecycle currently frozen' : 'market-session gate active'}</small></div>
      </div>
      <div className="strategy-filters" aria-label="Filter strategy signals">{filters.map((item) => <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>)}</div>
      {!selected ? (
        <div className="strategy-empty">
          <strong>{book.historyReady < book.universeSize ? 'Building the Nifty 50 evidence base' : quality.lifecycleFrozen && staged.length ? `${staged.length} qualified ${staged.length === 1 ? 'plan is' : 'plans are'} staged` : 'No setup clears the precision gate'}</strong>
          <p>{book.historyReady < book.universeSize ? 'Daily FYERS history is refreshing in the background. Signals appear only after at least 55 completed sessions are available.' : quality.lifecycleFrozen && staged.length ? 'These plans use the last completed NSE session. They remain read-only candidates until the next active session confirms a current, in-session quote.' : 'The engine is intentionally abstaining. It will add a setup only when every required confirmation and reward-to-risk rule is satisfied.'}</p>
          {quality.lifecycleFrozen && staged.length > 0 && <div className="strategy-staged-grid" aria-label="Qualified plans staged for the next active session">{staged.slice(0, 4).map((candidate) => (
            <article key={candidate.setupKey}>
              <header><span>{candidate.strategy}</span><strong>{candidate.score}</strong></header>
              <h3>{candidate.symbol}</h3>
              <p>{candidate.direction} · {candidate.riskReward.toFixed(1)}R</p>
              <footer><span>Entry ₹{formatter.format(candidate.entryZone.low)}–₹{formatter.format(candidate.entryZone.high)}</span><b>Wait for open</b></footer>
            </article>
          ))}</div>}
        </div>
      ) : (
        <div className="strategy-workspace">
          <aside className="strategy-list" aria-label="Tracked strategy signals">{visible.map((signal) => (
            <button key={signal.id} className={selected.id === signal.id ? 'active' : ''} onClick={() => setSelectedId(signal.id)}>
              <span className={`strategy-state strategy-state--${signal.status.toLowerCase().replaceAll(' ', '-')}`} />
              <span><strong>{signal.symbol}</strong><small>{signal.strategy}</small></span>
              <span><strong>{signal.score}</strong><small>{signal.status}</small></span>
            </button>
          ))}</aside>
          <article className="strategy-analysis" aria-live="polite">
            <header><div><span>{selected.strategy} · {selected.timeframe}</span><h3>{selected.symbol}</h3><p>{selected.rationale}</p></div><div className="strategy-score"><strong>{selected.score}</strong><span>Evidence score</span></div></header>
            <div className="strategy-action"><div><span>Action now</span><strong>{selected.action}</strong><p>{selected.status} · {selected.direction} setup · {selected.riskReward.toFixed(1)}R modelled reward/risk</p></div><button onClick={() => onOpen(selected.symbol)}>Open research <ArrowUpRight size={16} /></button></div>
            <div className="strategy-levels">
              <div><span>Entry zone</span><strong>₹{formatter.format(selected.entryZone.low)}–₹{formatter.format(selected.entryZone.high)}</strong></div>
              <div className="risk"><span>Stop loss</span><strong>₹{formatter.format(selected.stopLoss)}</strong></div>
              <div><span>Target 1</span><strong>₹{formatter.format(selected.target1)}</strong></div>
              <div><span>Target 2</span><strong>₹{formatter.format(selected.target2)}</strong></div>
            </div>
            <div className="strategy-proof"><div><span>Why it qualified</span><ul>{selected.evidence.map((item) => <li key={item}>{item}</li>)}</ul></div><div className="signal-audit-carousel"><header><span>Signal audit</span><div><button onClick={() => setEventIndex((value) => Math.max(0, value - 1))} disabled={eventIndex <= 0} aria-label="Previous lifecycle event"><CaretLeft size={15} /></button><b>{events.length ? eventIndex + 1 : 0} / {events.length}</b><button onClick={() => setEventIndex((value) => Math.min(events.length - 1, value + 1))} disabled={eventIndex >= events.length - 1} aria-label="Next lifecycle event"><CaretRight size={15} /></button></div></header>{auditEvent ? <article><b>{auditEvent.status}</b><small>{new Date(auditEvent.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · ₹{formatter.format(auditEvent.price)}</small><p>{auditEvent.note}</p></article> : <p>No lifecycle event recorded.</p>}</div></div>
          </article>
        </div>
      )}
      <footer><span>Minimum strategy score {book.minimumScore || 72}</span><p>{book.disclaimer}</p><span>{quality.lifecycleFrozen ? 'Closed session · no lifecycle changes' : 'Signals persist to a defined outcome'}</span></footer>
    </section>
  );
}

function Metric({ value, label, accent = false }) {
  return (
    <div className="metric">
      <strong className={accent ? 'accent' : ''}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function HistorySparkline({ points, symbol }) {
  if (points.length < 2) return <div className="history-empty">The minute archive starts with the next connected market sample.</div>;
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const width = 720;
  const height = 190;
  const line = prices.map((price, index) => `${(index / (prices.length - 1)) * width},${height - ((price - min) / (max - min || 1)) * (height - 18) - 9}`).join(' ');
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg className="history-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${symbol} recorded live price history`}>
      <defs><linearGradient id={`history-${symbol}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d7ff63" stopOpacity=".28" /><stop offset="100%" stopColor="#d7ff63" stopOpacity="0" /></linearGradient></defs>
      <polygon points={area} fill={`url(#history-${symbol})`} />
      <polyline points={line} fill="none" stroke="#d7ff63" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function SignalField({ ideas, onSelect }) {
  const width = 720;
  const height = 360;
  const inset = 42;
  const minPerformance = Math.min(-6, ...ideas.map((idea) => idea.performancePct));
  const maxPerformance = Math.max(6, ...ideas.map((idea) => idea.performancePct));
  const maxVolume = Math.max(2.5, ...ideas.map((idea) => idea.liveVolumeRatio));
  const xFor = (value) => inset + ((value - minPerformance) / (maxPerformance - minPerformance || 1)) * (width - inset * 2);
  const yFor = (value) => height - inset - (value / maxVolume) * (height - inset * 2);
  const toneColor = { risk: '#ff806d', warm: '#e7b75f', strong: '#d7ff63', positive: '#b8db60', neutral: '#72766b' };
  return (
    <svg className="signal-field" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Performance and volume signal field">
      <line x1={xFor(0)} x2={xFor(0)} y1={inset} y2={height - inset} className="field-axis" />
      <line x1={inset} x2={width - inset} y1={yFor(1)} y2={yFor(1)} className="field-axis" />
      <text x={inset} y={height - 12} className="field-label">Risk</text><text x={width - inset} y={height - 12} textAnchor="end" className="field-label">Performance</text>
      <text x={12} y={inset} className="field-label">Volume</text>
      {ideas.map((idea) => {
        const x = xFor(idea.performancePct);
        const y = yFor(idea.liveVolumeRatio);
        return <g key={idea.symbol} className="field-point" role="button" tabIndex="0" onClick={() => onSelect(idea.symbol)} onKeyDown={(event) => event.key === 'Enter' && onSelect(idea.symbol)}><circle cx={x} cy={y} r={8 + Math.min(7, Math.abs(idea.dayChangePct || 0) * 2)} fill={toneColor[idea.signal.tone] || toneColor.neutral} /><circle cx={x} cy={y} r="18" fill="transparent" /><text x={x + 13} y={y + 4}>{idea.symbol}</text></g>;
      })}
    </svg>
  );
}

function OrderBlockMap({ setups, selectedSymbol, onSelect }) {
  const shown = [...setups]
    .sort((a, b) => b.score - a.score)
    .reduce((groups, setup) => {
      const key = setup.side;
      if (groups[key].length < 5) groups[key].push(setup);
      return groups;
    }, { bullish: [], bearish: [] });
  const plotted = [...shown.bearish.map((setup, index) => ({ setup, index, count: shown.bearish.length })), ...shown.bullish.map((setup, index) => ({ setup, index, count: shown.bullish.length }))];
  return (
    <svg className="ob-map" viewBox="0 0 1000 264" role="img" aria-label="Ranked bearish and bullish order-block decision field">
      <rect className="ob-map__bear" x="0" y="0" width="492" height="264" />
      <rect className="ob-map__bull" x="508" y="0" width="492" height="264" />
      <text className="ob-map__heading" x="30" y="31">Bearish supply</text>
      <text className="ob-map__heading" x="970" y="31" textAnchor="end">Bullish demand</text>
      <line className="ob-map__spine" x1="500" x2="500" y1="36" y2="234" />
      <text className="ob-map__centre" x="500" y="250" textAnchor="middle">Zone proximity</text>
      {plotted.map(({ setup, index, count }) => {
        const direction = setup.side === 'bullish' ? 1 : -1;
        const x = 500 + direction * (125 + setup.score * 3.05);
        const y = 68 + index * (142 / Math.max(1, count - 1));
        const active = setup.symbol === selectedSymbol;
        const controlX = 500 + direction * 92;
        return (
          <g className={`ob-map__node ob-map__node--${setup.side}${active ? ' active' : ''}`} key={setup.symbol} role="button" tabIndex="0" aria-label={`${setup.symbol}, ${setup.sideLabel}, score ${setup.score}`} onClick={() => onSelect(setup.symbol)} onKeyDown={(event) => event.key === 'Enter' && onSelect(setup.symbol)}>
            <path d={`M500 ${y} C${controlX} ${y}, ${x - direction * 42} ${y}, ${x} ${y}`} />
            <circle cx={x} cy={y} r={active ? 12 : 8} />
            <text x={x + direction * 16} y={y - 3} textAnchor={direction > 0 ? 'start' : 'end'}>{setup.symbol}</text>
            <text className="ob-map__score" x={x + direction * 16} y={y + 11} textAnchor={direction > 0 ? 'start' : 'end'}>{setup.score} · {setup.state}</text>
          </g>
        );
      })}
    </svg>
  );
}

function OrderBlockChart({ setup }) {
  const candles = setup.candles || [];
  const width = 760;
  const height = 250;
  const top = 20;
  const bottom = 28;
  const values = candles.flatMap((candle) => [candle[1], candle[2]]).concat([setup.invalidation, setup.target1, setup.target2, setup.currentPrice]);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yFor = (value) => top + ((max - value) / Math.max(max - min, 0.01)) * (height - top - bottom);
  const step = width / Math.max(candles.length, 1);
  const zoneX = Math.max(0, setup.baseCandleIndex * step + step * 0.15);
  const zoneY = yFor(setup.zone.high);
  const zoneHeight = Math.max(4, yFor(setup.zone.low) - zoneY);
  const lines = [
    { value: setup.target2, label: 'Objective 2', className: 'target' },
    { value: setup.target1, label: 'Objective 1', className: 'target' },
    { value: setup.currentPrice, label: 'Current', className: 'current' },
    { value: setup.invalidation, label: 'Invalidation', className: 'invalidation' },
  ];
  return (
    <svg className={`ob-chart ob-chart--${setup.side}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${setup.symbol} candles with order-block zone, objectives and invalidation`}>
      <rect className="ob-chart__zone" x={zoneX} y={zoneY} width={width - zoneX} height={zoneHeight} />
      <text className="ob-chart__zone-label" x={zoneX + 8} y={Math.max(14, zoneY - 7)}>Order-block zone</text>
      {lines.map((line) => {
        const y = yFor(line.value);
        return <g className={`ob-chart__level ob-chart__level--${line.className}`} key={line.label}><line x1="0" x2={width} y1={y} y2={y} /><text x="8" y={Math.max(11, y - 5)}>{line.label} · ₹{formatter.format(line.value)}</text></g>;
      })}
      {candles.map((candle, index) => {
        const [open, high, low, close] = candle;
        const x = index * step + step / 2;
        const up = close >= open;
        const bodyY = yFor(Math.max(open, close));
        const bodyHeight = Math.max(3, Math.abs(yFor(open) - yFor(close)));
        return <g className={up ? 'ob-candle up' : 'ob-candle down'} key={index}><line x1={x} x2={x} y1={yFor(high)} y2={yFor(low)} /><rect x={x - Math.min(20, step * 0.2)} y={bodyY} width={Math.min(40, step * 0.4)} height={bodyHeight} /></g>;
      })}
      <text className="ob-chart__period" x={width - 6} y={height - 7} textAnchor="end">Five daily candles</text>
    </svg>
  );
}

function OrderBlockDesk({ book, ideas, onOpen }) {
  const [filter, setFilter] = useState('All');
  const [selectedSymbol, setSelectedSymbol] = useState(book.setups?.[0]?.symbol || null);
  const filtered = (book.setups || []).filter((setup) => filter === 'All' || setup.side === filter.toLowerCase());
  const selected = (book.setups || []).find((setup) => setup.symbol === selectedSymbol) || filtered[0] || book.setups?.[0];
  const idea = ideas.find((item) => item.symbol === selected?.symbol);
  useEffect(() => {
    if (selected && !filtered.some((setup) => setup.symbol === selected.symbol)) setSelectedSymbol(filtered[0]?.symbol || null);
  }, [filter, filtered, selected]);
  if (!selected) return null;
  const stats = {
    bullish: book.bullish?.length || 0,
    bearish: book.bearish?.length || 0,
    near: (book.setups || []).filter((setup) => ['In zone', 'Approaching'].includes(setup.state)).length,
    invalidated: book.counts?.Invalidated || 0,
  };
  return (
    <section className="orderblock-section" id="order-blocks" aria-labelledby="orderblock-title">
      <div className="orderblock-heading">
        <div><h2 id="orderblock-title">Order block desk</h2><p>Transparent zones derived from displacement, participation, recency, and live proximity.</p></div>
        <div className="ob-filters" aria-label="Filter order blocks by direction">{['All', 'Bullish', 'Bearish'].map((item) => <button className={filter === item ? 'active' : ''} key={item} onClick={() => setFilter(item)}>{item}</button>)}</div>
      </div>
      <div className="ob-summary" aria-label="Order block summary">
        <div><TrendUp size={18} /><span>Bullish zones</span><strong>{stats.bullish}</strong></div>
        <div><TrendDown size={18} /><span>Bearish zones</span><strong>{stats.bearish}</strong></div>
        <div><Crosshair size={18} /><span>Near decision</span><strong>{stats.near}</strong></div>
        <div><ShieldCheck size={18} /><span>Invalidated</span><strong>{stats.invalidated}</strong></div>
      </div>
      <div className="ob-field-wrap"><OrderBlockMap setups={filtered} selectedSymbol={selected.symbol} onSelect={setSelectedSymbol} /></div>
      <div className="ob-workspace">
        <aside className="ob-rankings" aria-label="Ranked order block setups">
          <div className="ob-rankings__head"><span>Ranked setups</span><b>{filtered.length}</b></div>
          <div className="ob-rankings__scroll">{filtered.map((setup, index) => (
            <button className={`ob-rank-row ${selected.symbol === setup.symbol ? 'active' : ''}`} key={setup.symbol} onClick={() => setSelectedSymbol(setup.symbol)}>
              <span className={`ob-side-mark ${setup.side}`} />
              <span><strong>{setup.symbol}</strong><small>{setup.sideLabel}</small></span>
              <span><strong>{setup.score}</strong><small>{setup.state}</small></span>
              <b>{index + 1}</b>
            </button>
          ))}</div>
        </aside>
        <article className="ob-analysis" aria-live="polite">
          <header className="ob-analysis__head">
            <div><span className={`signal-label signal-${selected.tone}`}>{selected.state}</span><h3>{selected.symbol}</h3><p>{selected.reason}</p></div>
            <div className="ob-confidence"><strong>{selected.score}</strong><span>Confidence</span></div>
          </header>
          <div className="ob-chart-wrap"><OrderBlockChart setup={selected} /></div>
          <div className="ob-levels">
            <div><span>Zone</span><strong>₹{formatter.format(selected.zone.low)}–₹{formatter.format(selected.zone.high)}</strong></div>
            <div><span>Invalidation</span><strong>₹{formatter.format(selected.invalidation)}</strong></div>
            <div><span>Objective 1</span><strong>₹{formatter.format(selected.target1)}</strong></div>
            <div><span>Objective 2</span><strong>₹{formatter.format(selected.target2)}</strong></div>
          </div>
          <div className="ob-decision">
            <div><span>Decision</span><strong>{selected.decision}</strong><p>{selected.sideLabel} · {selected.distanceToZonePct.toFixed(2)}% from zone · {selected.riskReward.toFixed(1)}R modelled reward/risk</p></div>
            <ul>{selected.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
            <button onClick={() => onOpen(selected.symbol)}>Open full thesis <ArrowUpRight size={16} /></button>
          </div>
        </article>
      </div>
      <footer className="ob-method"><span>{book.timeframe} · {selected.source}</span><p>{book.disclaimer}</p><span>{idea?.stale ? 'Snapshot evidence' : 'Live price overlay'}</span></footer>
    </section>
  );
}

function App() {
  const root = useRef(null);
  const [ideaState, setIdeaState] = useState(loadState);
  const [query, setQuery] = useState('');
  const [direction, setDirection] = useState('All');
  const [sortBy, setSortBy] = useState('Performance');
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [researchSymbol, setResearchSymbol] = useState(null);
  const [liveState, setLiveState] = useState(initialLiveState);
  const [history, setHistory] = useState([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const [sweepRunning, setSweepRunning] = useState(false);
  const [browserAlerts, setBrowserAlerts] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(ALERTS_KEY) === 'enabled');
  const lastNotifiedAlert = useRef(null);

  const universeRows = liveState.universe?.length ? liveState.universe : source.rows;
  const ideas = useMemo(() => universeRows.map((row, index) => {
    const quote = liveState.quotes[row.symbol];
    const referencePrice = Number(row.lastClose ?? row.scanPrice ?? quote?.lastPrice ?? 0);
    const currentPrice = quote?.lastPrice ?? referencePrice;
    const suggestedPrice = quote?.suggestedPrice || row.suggestedPrice || referencePrice || currentPrice;
    const performancePct = quote?.performancePct ?? ((currentPrice / suggestedPrice) - 1) * 100;
    return {
      ...row,
      query: row.query || { securityId: row.securityId, exchangeSegment: row.exchangeSegment },
      lastClose: referencePrice,
      scanDate: row.scanDate || row.latestScanAt || source.asOf,
      rank: index + 1,
      currentPrice,
      suggestedPrice,
      suggestedAt: quote?.suggestedAt ?? `${row.scanDate}T15:30:00+05:30`,
      performancePct,
      dayChangePct: quote?.dayChangePct ?? null,
      liveVolumeRatio: quote?.volumeRatio ?? row.volumeRatio ?? row.scanVolumeRatio ?? 1,
      signal: quote?.signal ?? { state: 'Watching', tone: 'neutral', reason: 'Waiting for the live monitor' },
      stale: quote?.stale ?? true,
      status: ideaState[row.symbol]?.status || 'Inbox',
      conviction: ideaState[row.symbol]?.conviction || 3,
      note: ideaState[row.symbol]?.note || '',
      saved: ideaState[row.symbol]?.saved || false,
    };
  }), [ideaState, liveState, universeRows]);

  const filtered = useMemo(() => {
    const result = ideas.filter((idea) => {
      const matchesQuery = idea.symbol.toLowerCase().includes(query.toLowerCase());
      const matchesDirection = direction === 'All' || (direction === 'Rising' ? idea.performancePct >= 0 : idea.performancePct < 0);
      return matchesQuery && matchesDirection;
    });
    return [...result].sort((a, b) => {
      if (sortBy === 'Performance') return b.performancePct - a.performancePct;
      if (sortBy === 'Momentum') return b.fourSessionChangePct - a.fourSessionChangePct;
      if (sortBy === 'Volume') return b.liveVolumeRatio - a.liveVolumeRatio;
      if (sortBy === 'Price') return b.currentPrice - a.currentPrice;
      return Number(b.saved) - Number(a.saved);
    });
  }, [ideas, query, direction, sortBy]);

  const leaders = [...ideas].sort((a, b) => b.performancePct - a.performancePct);
  const rising = ideas.filter((idea) => idea.performancePct > 0).length;
  const unusualVolume = ideas.filter((idea) => idea.liveVolumeRatio > 1).length;
  const avgMove = ideas.reduce((total, idea) => total + idea.performancePct, 0) / ideas.length;
  const selected = ideas.find((idea) => idea.symbol === selectedSymbol) || null;
  const fallbackOrderBlocks = useMemo(() => rankOrderBlocks(universeRows, liveState.quotes, liveState.updatedAt || source.asOf), [universeRows, liveState.quotes, liveState.updatedAt]);
  const orderBook = liveState.orderBlocks?.setups?.length ? liveState.orderBlocks : fallbackOrderBlocks;
  const strategyBook = liveState.strategies || initialLiveState.strategies;
  const selectedOrderBlock = orderBook.setups.find((setup) => setup.symbol === selectedSymbol) || null;
  const alerts = liveState.monitor?.recentAlerts || [];
  const sweepMonitor = liveState.monitor?.sweep || { slots: ['09:15', '11:15', '13:15', '15:15'], today: [] };
  const latestSweep = sweepMonitor.latest?.universeSize === ideas.length ? sweepMonitor.latest : null;
  const fallbackSignals = ideas.map((idea) => ({
    symbol: idea.symbol, price: idea.currentPrice, performancePct: idea.performancePct, dayChangePct: idea.dayChangePct,
    volumeRatio: idea.liveVolumeRatio, state: idea.signal.state, tone: idea.signal.tone, reason: idea.signal.reason,
    lane: idea.stale ? 'No action' : ['Invalidated', 'At risk'].includes(idea.signal.state) ? 'Risk review' : ['Confirmed', 'Strengthening'].includes(idea.signal.state) ? 'Action now' : idea.signal.state === 'Extended' ? 'Manage strength' : idea.signal.state === 'Advancing' ? 'Watch closely' : 'No action',
    thesis: idea.stale ? 'Reconnect FYERS before acting on the cached daily close.' : idea.signal.reason,
    score: idea.stale ? 0 : Math.round(Math.min(100, Math.max(0, 50 + idea.performancePct * 4 + (idea.dayChangePct || 0) * 5 + (idea.liveVolumeRatio - 1) * 10))),
  }));
  const sweepSignals = latestSweep?.ranked || fallbackSignals;
  const actionableSignals = sweepSignals.filter((signal) => signal.lane !== 'No action');
  const focusedSignal = actionableSignals[focusIndex % Math.max(1, actionableSignals.length)] || sweepSignals[0];
  const actionLanes = ['Action now', 'Watch closely', 'Risk review', 'Manage strength'].map((lane) => ({ lane, items: sweepSignals.filter((signal) => signal.lane === lane) })).filter((group) => group.items.length);
  const topSignals = [...sweepSignals].sort((a, b) => b.score - a.score).slice(0, 6);
  const researchIdea = ideas.find((idea) => idea.symbol === (researchSymbol || focusedSignal?.symbol)) || leaders[0];
  const researchSignal = sweepSignals.find((signal) => signal.symbol === researchIdea?.symbol) || fallbackSignals.find((signal) => signal.symbol === researchIdea?.symbol);
  const riskCount = sweepSignals.filter((signal) => signal.lane === 'Risk review').length;
  const breadthPct = Math.round((rising / Math.max(1, ideas.length)) * 100);
  const liveSession = Boolean(liveState.connected && liveState.market?.open);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ideaState));
  }, [ideaState]);

  useEffect(() => {
    let active = true;
    fetch('/api/live').then((response) => response.json()).then((payload) => active && setLiveState(payload)).catch(() => {});
    const stream = new EventSource('/api/stream');
    stream.onmessage = (event) => active && setLiveState(JSON.parse(event.data));
    stream.onerror = () => active && setLiveState((current) => ({ ...current, connected: false, message: 'Local monitor disconnected. Reconnecting…' }));
    return () => { active = false; stream.close(); };
  }, []);

  useEffect(() => {
    if (!selectedSymbol) { setHistory([]); return; }
    const controller = new AbortController();
    fetch(`/api/history?symbol=${encodeURIComponent(selectedSymbol)}&limit=240`, { signal: controller.signal })
      .then((response) => response.json())
      .then((payload) => setHistory(payload.points || []))
      .catch((error) => error.name !== 'AbortError' && setHistory([]));
    return () => controller.abort();
  }, [selectedSymbol, liveState.monitor?.lastHistoryAt]);

  useEffect(() => {
    if (!selectedSymbol) return;
    const onKey = (event) => event.key === 'Escape' && setSelectedSymbol(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedSymbol]);

  useEffect(() => {
    const latest = alerts[0];
    if (!latest) return;
    if (lastNotifiedAlert.current === null) { lastNotifiedAlert.current = latest.id; return; }
    if (latest.id === lastNotifiedAlert.current) return;
    lastNotifiedAlert.current = latest.id;
    if (browserAlerts && latest.notify && Notification.permission === 'granted') {
      new Notification(`${latest.symbol}: ${latest.to}`, { body: `${latest.reason} · ₹${formatter.format(latest.price)}`, tag: latest.id });
    }
  }, [alerts, browserAlerts]);

  useEffect(() => setFocusIndex(0), [latestSweep?.id]);

  useGSAP(() => {
    const mm = gsap.matchMedia();
    const targets = (selector) => gsap.utils.toArray(selector, root.current);
    const animateFrom = (selector, vars) => {
      const elements = targets(selector);
      return elements.length ? gsap.from(elements, vars) : null;
    };
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      animateFrom('.terminal-hero__eyebrow, .terminal-hero h1, .terminal-hero__copy, .terminal-hero__actions, .terminal-hero__session', { y: 34, opacity: 0, duration: 0.85, stagger: 0.08, ease: 'power3.out' });
      const inlineChart = targets('.hero-inline-chart');
      if (inlineChart.length) gsap.fromTo(inlineChart, { scale: 0.8, opacity: 0.25 }, { scale: 1, opacity: 1, duration: 1.1, delay: 0.35, ease: 'expo.out' });
      const commandTargets = targets('.command-bar > *, .pulse-metric');
      if (commandTargets.length) gsap.from(commandTargets, { y: 16, opacity: 0, duration: 0.55, stagger: 0.055, ease: 'power3.out', scrollTrigger: { trigger: root.current.querySelector('.workspace'), start: 'top 88%' } });
      animateFrom('.signal-queue__item', { x: -14, opacity: 0, duration: 0.5, stagger: 0.045, ease: 'power2.out', delay: 0.18 });
      animateFrom('.research-desk > *', { y: 14, opacity: 0, duration: 0.55, stagger: 0.065, ease: 'power2.out', delay: 0.22 });
      gsap.utils.toArray('.insight-card, .monitor-panel').forEach((panel) => gsap.from(panel, { y: 20, opacity: 0, duration: 0.6, ease: 'power2.out', scrollTrigger: { trigger: panel, start: 'top 92%' } }));
      const strategyAnalysis = targets('.strategy-analysis');
      const strategySection = root.current.querySelector('.strategy-section');
      if (strategyAnalysis.length && strategySection) {
        gsap.fromTo(strategyAnalysis, { scale: 0.88, opacity: 0.28 }, { scale: 1, opacity: 1, ease: 'none', scrollTrigger: { trigger: strategySection, start: 'top 88%', end: 'center 48%', scrub: 0.7 } });
        gsap.to(strategyAnalysis, { opacity: 0.22, ease: 'none', scrollTrigger: { trigger: strategySection, start: 'bottom 38%', end: 'bottom top', scrub: 0.7 } });
      }
    });
    mm.add('(min-width: 1051px) and (prefers-reduced-motion: no-preference)', () => {
      const strategyWorkspace = root.current.querySelector('.strategy-workspace');
      const strategyList = root.current.querySelector('.strategy-list');
      if (strategyWorkspace && strategyList) ScrollTrigger.create({ trigger: strategyWorkspace, start: 'top 92px', end: 'bottom bottom', pin: strategyList, pinSpacing: false });
    });
    mm.add('(prefers-reduced-motion: reduce)', () => {
      const staticTargets = targets('.terminal-hero__eyebrow, .terminal-hero h1, .terminal-hero__copy, .terminal-hero__actions, .terminal-hero__session, .hero-inline-chart, .command-bar > *, .pulse-metric, .signal-queue__item, .research-desk > *, .insight-card, .monitor-panel, .strategy-analysis');
      if (staticTargets.length) gsap.set(staticTargets, { clearProps: 'all', opacity: 1, scale: 1 });
    });
    return () => mm.revert();
  }, { scope: root });

  function updateIdea(symbol, patch) {
    setIdeaState((current) => ({ ...current, [symbol]: { ...current[symbol], ...patch } }));
  }

  async function enableBrowserAlerts() {
    if (typeof Notification === 'undefined') return;
    const permission = await Notification.requestPermission();
    const enabled = permission === 'granted';
    setBrowserAlerts(enabled);
    localStorage.setItem(ALERTS_KEY, enabled ? 'enabled' : 'disabled');
  }

  async function runSweep() {
    if (sweepRunning) return;
    setSweepRunning(true);
    try {
      const response = await fetch('/api/sweeps/run', { method: 'POST' });
      if (!response.ok) throw new Error('Sweep unavailable');
      const payload = await fetch('/api/live').then((result) => result.json());
      setLiveState(payload);
    } finally {
      setSweepRunning(false);
    }
  }

  function exportCsv() {
    const headers = ['Symbol', 'Suggested at', 'Suggested price', 'Current price', 'Return since suggestion %', 'Day change %', 'Signal', 'Volume ratio', 'Strategy', 'Strategy status', 'Strategy score', 'Entry low', 'Entry high', 'Stop loss', 'Target 1', 'Target 2', 'Order block side', 'Order block state', 'Zone low', 'Zone high', 'Invalidation', 'Objective 1', 'Objective 2', 'Order block score', 'Status', 'Conviction', 'Saved', 'Note'];
    const rows = ideas.map((idea) => {
      const block = orderBook.setups.find((setup) => setup.symbol === idea.symbol);
      const strategy = strategyBook.signals?.find((signal) => signal.symbol === idea.symbol && !['Target 2', 'Stopped', 'Expired', 'Cancelled'].includes(signal.status));
      return [idea.symbol, idea.suggestedAt, idea.suggestedPrice, idea.currentPrice, idea.performancePct.toFixed(2), idea.dayChangePct?.toFixed(2) ?? '', idea.signal.state, idea.liveVolumeRatio.toFixed(2), strategy?.strategy || '', strategy?.status || '', strategy?.score || '', strategy?.entryZone.low || '', strategy?.entryZone.high || '', strategy?.stopLoss || '', strategy?.target1 || '', strategy?.target2 || '', block?.side || '', block?.state || '', block?.zone.low || '', block?.zone.high || '', block?.invalidation || '', block?.target1 || '', block?.target2 || '', block?.score || '', idea.status, idea.conviction, idea.saved ? 'Yes' : 'No', idea.note];
    });
    const csv = [headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `thesis-ledger-${source.asOf}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app" ref={root} data-ui>
      <header className="app-header">
        <div className="shell app-header__inner">
          <a className="wordmark" href="#top" aria-label="Thesis Ledger signal desk"><span>TL</span><strong>Thesis Ledger</strong></a>
          <nav className="nav-links" aria-label="Main navigation"><a href="#top">Signals</a><a href="#strategies">Strategies</a><a href="#order-blocks">Order blocks</a><a href="#ideas">Ideas</a><a href="#monitor">Monitor</a></nav>
          <div className="header-actions">
            <button className={`icon-action ${browserAlerts ? 'active' : ''}`} onClick={enableBrowserAlerts} aria-label={browserAlerts ? 'Browser alerts enabled' : 'Enable browser alerts'}>{browserAlerts ? <BellRinging size={19} /> : <Bell size={19} />}</button>
            <button className="export-action" onClick={exportCsv}><DownloadSimple size={18} /><span>Export</span></button>
          </div>
        </div>
      </header>

      <div className={`connection-strip ${liveSession ? 'is-live' : 'is-snapshot'}`} role="status">
        <div className="shell connection-strip__inner">
          <div className="feed-state">{liveSession ? <WifiHigh size={16} /> : <WifiSlash size={16} />}<strong>{liveSession ? 'Live FYERS feed' : liveState.connected ? 'FYERS connected · quotes frozen' : 'Snapshot mode'}</strong></div>
          <span className="feed-copy">{liveState.message}</span>
          {!liveState.connected && liveState.auth?.configured && <a href={liveState.auth.loginPath || '/api/fyers/login'}>{liveState.auth.authenticated ? 'Reconnect FYERS' : 'Connect FYERS'}</a>}
          <div className="market-clock"><span className={liveState.market?.open ? 'market-dot open' : 'market-dot'} />{liveState.market?.label}{liveState.updatedAt && <time>{new Date(liveState.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</time>}</div>
        </div>
      </div>

      <DashboardHero market={liveState.market} />
      <MarketMarquee ideas={ideas} />

      <section className="workspace shell" id="top">
        <div className="command-bar">
          <div><h1>Signal desk</h1><p>{latestSweep ? `Sweep completed ${new Date(latestSweep.ranAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'Live ranking from the current monitor state'}</p></div>
          <div className="sweep-schedule" aria-label="Scheduled sweep times">
            <Timer size={17} />
            {sweepMonitor.slots.map((slot) => { const complete = sweepMonitor.today?.some((sweep) => sweep.scheduledAt?.includes(`T${slot}:`)); return <span className={complete ? 'complete' : ''} key={slot}>{complete && <Check size={11} />}{slot}</span>; })}
          </div>
          <button className="run-sweep" onClick={runSweep} disabled={sweepRunning || !liveSession}><ArrowsClockwise className={sweepRunning ? 'spinning' : ''} size={17} />{sweepRunning ? 'Sweeping…' : 'Run sweep'}</button>
        </div>

        <div className="pulse-strip" aria-label="Portfolio signal summary">
          <div className="pulse-metric"><span>Needs action</span><strong>{actionableSignals.length}</strong><small>of {ideas.length} ideas</small></div>
          <div className="pulse-metric"><span>Risk review</span><strong className={riskCount ? 'negative' : ''}>{riskCount}</strong><small>below threshold</small></div>
          <div className="pulse-metric"><span>Above basis</span><strong>{breadthPct}%</strong><small>{rising} ideas advancing</small></div>
          <div className="pulse-metric"><span>Average return</span><strong className={avgMove >= 0 ? 'positive' : 'negative'}>{avgMove >= 0 ? '+' : ''}{avgMove.toFixed(2)}%</strong><small>since first signal</small></div>
          <div className="pulse-metric pulse-metric--leader"><span>Leader</span><strong>{leaders[0]?.symbol}</strong><small>{leaders[0]?.performancePct >= 0 ? '+' : ''}{leaders[0]?.performancePct.toFixed(2)}%</small></div>
        </div>

        <div className="decision-grid">
          <aside className="signal-queue" aria-label="Priority signal queue">
            <div className="panel-heading"><div><h2>Priority queue</h2><p>Ranked by evidence strength</p></div><span>{topSignals.length} shown</span></div>
            <div className="signal-queue__list">
              {topSignals.map((signal) => (
                <button className={`signal-queue__item ${researchIdea?.symbol === signal.symbol ? 'active' : ''}`} key={signal.symbol} onClick={() => setResearchSymbol(signal.symbol)}>
                  <span className={`signal-dot signal-${signal.tone}`} />
                  <span className="queue-name"><strong>{signal.symbol}</strong><small>{signal.lane}</small></span>
                  <span className="queue-metrics"><strong className={signal.performancePct >= 0 ? 'positive' : 'negative'}>{signal.performancePct >= 0 ? '+' : ''}{signal.performancePct.toFixed(2)}%</strong><small>{signal.volumeRatio.toFixed(2)}× vol</small></span>
                  <span className="score-chip">{signal.score}</span>
                </button>
              ))}
            </div>
            <a className="queue-link" href="#ideas">View all {ideas.length} ideas <ArrowRight size={16} /></a>
          </aside>

          {researchIdea && researchSignal && (
            <article className="research-desk" aria-live="polite">
              <div className="research-head">
                <div><span className={`signal-label signal-${researchSignal.tone}`}>{researchSignal.lane}</span><h2>{researchIdea.symbol}</h2><p>{researchIdea.signal.reason}</p></div>
                <div className="research-actions"><button onClick={() => setFocusIndex((current) => (current - 1 + actionableSignals.length) % Math.max(1, actionableSignals.length))} aria-label="Previous priority signal"><CaretLeft size={18} /></button><button onClick={() => setFocusIndex((current) => (current + 1) % Math.max(1, actionableSignals.length))} aria-label="Next priority signal"><CaretRight size={18} /></button><button className="open-research" onClick={() => setSelectedSymbol(researchIdea.symbol)}>Open research <ArrowUpRight size={16} /></button></div>
              </div>
              <div className="research-body">
                <div className="research-chart"><Sparkline candles={researchIdea.candles} id={`research-${researchIdea.symbol}`} large /><div className="chart-scale"><span>Five sessions</span><strong>₹{formatter.format(researchIdea.currentPrice)}</strong></div></div>
                <div className="score-panel"><strong>{researchSignal.score}</strong><span>Signal score</span><div style={{ '--score': `${researchSignal.score}%` }}><i /></div></div>
              </div>
              <div className="evidence-grid">
                <div><span>Price evidence</span><strong className={researchIdea.performancePct >= 0 ? 'positive' : 'negative'}>{researchIdea.performancePct >= 0 ? '+' : ''}{researchIdea.performancePct.toFixed(2)}%</strong><p>from ₹{formatter.format(researchIdea.suggestedPrice)} suggestion basis</p></div>
                <div><span>Participation</span><strong>{researchIdea.liveVolumeRatio.toFixed(2)}×</strong><p>{researchIdea.liveVolumeRatio >= 1 ? 'Volume is above its recent baseline' : 'Volume is below its recent baseline'}</p></div>
                <div><span>Short momentum</span><strong className={researchIdea.fourSessionChangePct >= 0 ? 'positive' : 'negative'}>{researchIdea.fourSessionChangePct >= 0 ? '+' : ''}{researchIdea.fourSessionChangePct.toFixed(2)}%</strong><p>across the source scan window</p></div>
                <div className="risk-note"><span>Decision check</span><strong>{researchIdea.performancePct <= -3 ? 'Review invalidation' : researchIdea.performancePct >= 5 ? 'Manage extension' : 'Thesis intact'}</strong><p>{researchIdea.signal.reason}</p></div>
              </div>
            </article>
          )}
        </div>

        <div className="insight-grid">
          <article className="insight-card field-card"><div className="panel-heading"><div><h2>Signal field</h2><p>Return versus relative volume</p></div><Crosshair size={19} /></div><SignalField ideas={ideas} onSelect={setResearchSymbol} /></article>
          <article className="insight-card breadth-card"><div className="panel-heading"><div><h2>Return distribution</h2><p>Every idea against its suggestion basis</p></div><span>{rising} up · {ideas.length - rising} down</span></div><div className="return-distribution">{[...ideas].sort((a, b) => b.performancePct - a.performancePct).map((idea) => <button key={idea.symbol} onClick={() => setResearchSymbol(idea.symbol)}><span>{idea.symbol}</span><div className={idea.performancePct >= 0 ? 'up' : 'down'}><i style={{ width: `${Math.min(100, Math.abs(idea.performancePct) * 12 + 6)}%` }} /></div><strong className={idea.performancePct >= 0 ? 'positive' : 'negative'}>{idea.performancePct >= 0 ? '+' : ''}{idea.performancePct.toFixed(2)}%</strong></button>)}</div></article>
        </div>

        <StrategyDesk book={strategyBook} onOpen={setSelectedSymbol} />
        <OrderBlockDesk book={orderBook} ideas={ideas} onOpen={setSelectedSymbol} />
      </section>

      <section className="ideas-section" id="ideas">
        <div className="shell">
          <div className="section-bar"><div><h2>Idea universe</h2><p>{filtered.length} of {ideas.length} tracked ideas</p></div><div className="toolbar"><label className="search"><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search symbol" aria-label="Search symbols" /></label><div className="filter-group" aria-label="Filter by return">{['All', 'Rising', 'Falling'].map((item) => <button key={item} className={direction === item ? 'active' : ''} onClick={() => setDirection(item)}>{item}</button>)}</div><label className="sort"><Funnel size={17} /><span>Sort</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option>Performance</option><option>Momentum</option><option>Volume</option><option>Price</option><option>Saved</option></select></label></div></div>
          <div className="idea-table">
            <div className="table-head"><span>Idea</span><span>Price</span><span>Return</span><span>Volume</span><span>Workflow</span><span>Conviction</span><span /></div>
            {filtered.map((idea) => (
              <article className="idea-row" key={idea.symbol} onClick={() => setSelectedSymbol(idea.symbol)} tabIndex="0" onKeyDown={(event) => event.key === 'Enter' && setSelectedSymbol(idea.symbol)}>
                <div className="idea-name"><button className={`save ${idea.saved ? 'saved' : ''}`} onClick={(event) => { event.stopPropagation(); updateIdea(idea.symbol, { saved: !idea.saved }); }} aria-label={`${idea.saved ? 'Unsave' : 'Save'} ${idea.symbol}`}><Star size={18} weight={idea.saved ? 'fill' : 'regular'} /></button><div><strong>{idea.symbol}</strong><span className={`signal-label signal-${idea.signal.tone}`}>{idea.signal.state}</span></div></div>
                <div className="price"><strong>₹{formatter.format(idea.currentPrice)}</strong><span>{idea.stale ? 'Scan close' : 'Live price'}</span></div>
                <div className={`move ${idea.performancePct >= 0 ? 'positive' : 'negative'}`}>{idea.performancePct >= 0 ? <TrendUp size={17} /> : <TrendDown size={17} />}<strong>{idea.performancePct >= 0 ? '+' : ''}{idea.performancePct.toFixed(2)}%</strong></div>
                <div className="volume"><strong>{idea.liveVolumeRatio.toFixed(2)}×</strong><div><span style={{ width: `${Math.min(100, idea.liveVolumeRatio / 2.5 * 100)}%` }} /></div></div>
                <div><select className="status" value={idea.status} aria-label={`${idea.symbol} workflow status`} onClick={(event) => event.stopPropagation()} onChange={(event) => updateIdea(idea.symbol, { status: event.target.value })}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></div>
                <div className="conviction" onClick={(event) => event.stopPropagation()}>{[1, 2, 3, 4, 5].map((value) => <button key={value} className={value <= idea.conviction ? 'filled' : ''} onClick={() => updateIdea(idea.symbol, { conviction: value })} aria-label={`Set ${idea.symbol} conviction to ${value}`} />)}</div>
                <button className="open" aria-label={`Open ${idea.symbol}`}><ArrowUpRight size={19} /></button>
              </article>
            ))}
            {!filtered.length && <div className="empty">No ideas match this view.</div>}
          </div>
        </div>
      </section>

      <section className="monitor-section shell" id="monitor">
        <div className="section-bar"><div><h2>Monitor health</h2><p>Collection, alerts, and FYERS session state</p></div><button className={`alert-toggle ${browserAlerts ? 'enabled' : ''}`} onClick={enableBrowserAlerts}>{browserAlerts ? <BellRinging size={18} /> : <Bell size={18} />}{browserAlerts ? 'Alerts enabled' : 'Enable alerts'}</button></div>
        <div className="monitor-grid">
          <div className="monitor-panel monitor-stats"><div><Pulse size={19} /><span>Quote loop</span><strong>{Math.round((liveState.monitor?.pollMs || 5000) / 1000)} sec</strong><small>{Object.values(liveState.quotes).filter((quote) => !quote.stale).length} live symbols</small></div><div><Database size={19} /><span>Local archive</span><strong>{liveState.monitor?.historySamples || 0}</strong><small>samples retained</small></div><div><ShieldCheck size={19} /><span>FYERS session</span><strong>{liveState.auth?.refreshStatus === 'failed' ? 'Reconnect' : liveState.auth?.authenticated ? 'Ready' : 'Offline'}</strong><small>{liveState.auth?.refreshStatus === 'failed' ? 'refresh unavailable' : liveState.auth?.expiresAt ? `expires ${new Date(liveState.auth.expiresAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : 'manual login'}</small></div></div>
          <div className="monitor-panel event-feed" aria-label="Recent signal transitions"><div className="panel-heading"><div><h3>Recent transitions</h3><p>Confirmed state changes</p></div><ClockCounterClockwise size={18} /></div>{alerts.slice(0, 6).map((alert) => <button key={alert.id} onClick={() => setSelectedSymbol(alert.symbol)}><span className={`signal-dot signal-${alert.severity === 'positive' ? 'strong' : alert.severity === 'warning' || alert.severity === 'critical' ? 'risk' : 'neutral'}`} /><span><strong>{alert.symbol}</strong><small>{alert.reason}</small></span><span><b>{alert.to}</b><small>{new Date(alert.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</small></span></button>)}{!alerts.length && <div className="empty">No confirmed transitions yet.</div>}</div>
        </div>
      </section>

      <section className="closing-cta shell" aria-labelledby="closing-title">
        <div><span>Research is only useful when it stays accountable.</span><h2 id="closing-title">Carry every setup to a defined outcome.</h2></div>
        <div><button onClick={exportCsv}>Export the complete ledger <DownloadSimple size={18} /></button><a href="#top">Return to signal desk <ArrowUpRight size={17} /></a></div>
      </section>

      <footer className="app-footer shell"><span>Thesis Ledger · Local research workspace</span><span>Completed NSE sessions only · Source scan {source.asOf}</span></footer>

      {selected && (
        <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setSelectedSymbol(null)}>
          <aside className="drawer" aria-modal="true" role="dialog" aria-label={`${selected.symbol} investment idea`}>
            <div className="drawer-top"><div><span>NSE · {selected.query?.securityId}</span><h2>{selected.symbol}</h2><p>{selected.signal.reason}</p></div><button onClick={() => setSelectedSymbol(null)} aria-label="Close details"><X size={22} /></button></div>
            <div className="drawer-metrics"><Metric value={`₹${formatter.format(selected.currentPrice)}`} label={selected.stale ? 'Scan close' : 'Live price'} /><Metric value={`${selected.performancePct >= 0 ? '+' : ''}${selected.performancePct.toFixed(2)}%`} label="Since suggested" accent={selected.performancePct >= 0} /><Metric value={`${selected.liveVolumeRatio.toFixed(2)}×`} label="Volume ratio" /></div>
            {selectedOrderBlock && <section className={`drawer-orderblock drawer-orderblock--${selectedOrderBlock.side}`}><div><span>{selectedOrderBlock.sideLabel}</span><strong>{selectedOrderBlock.state}</strong><p>{selectedOrderBlock.reason}</p></div><div><span>Decision zone</span><strong>₹{formatter.format(selectedOrderBlock.zone.low)}–₹{formatter.format(selectedOrderBlock.zone.high)}</strong><small>Invalidation ₹{formatter.format(selectedOrderBlock.invalidation)} · score {selectedOrderBlock.score}</small></div></section>}
            <div className={`signal-callout signal-${selected.signal.tone}`}><div><span>Monitor state</span><strong>{selected.signal.state}</strong></div><p>{selected.signal.reason}</p><small>Basis ₹{formatter.format(selected.suggestedPrice)} · {new Date(selected.suggestedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</small></div>
            <section className="drawer-analysis"><h3>Evidence review</h3><div><article><span>Price</span><strong className={selected.performancePct >= 0 ? 'positive' : 'negative'}>{selected.performancePct >= 0 ? '+' : ''}{selected.performancePct.toFixed(2)}%</strong><p>Return from the first recorded suggestion.</p></article><article><span>Participation</span><strong>{selected.liveVolumeRatio.toFixed(2)}×</strong><p>{selected.liveVolumeRatio >= 1 ? 'Above-baseline volume supports the move.' : 'Participation is not yet confirming the move.'}</p></article><article><span>Risk</span><strong>{selected.performancePct <= -3 ? 'Elevated' : 'Normal'}</strong><p>{selected.performancePct <= -3 ? 'Price is close to or through the review threshold.' : 'No return-based invalidation is active.'}</p></article></div></section>
            <div className="history-panel"><div><span>Recorded live history</span><b>{history.length} samples</b></div><HistorySparkline points={history} symbol={selected.symbol} />{history.length > 1 && <footer><span>{new Date(history[0].at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span><span>₹{formatter.format(Math.min(...history.map((point) => point.price)))} — ₹{formatter.format(Math.max(...history.map((point) => point.price)))}</span><span>{new Date(history.at(-1).at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span></footer>}</div>
            <div className="chart-panel"><div><span>Five-session price action</span><b>₹{formatter.format(Math.min(...selected.candles.map((c) => c[2])))} — ₹{formatter.format(Math.max(...selected.candles.map((c) => c[1])))}</b></div><Sparkline candles={selected.candles} id={`drawer-${selected.symbol}`} large /></div>
            <div className="candle-grid">{selected.candles.map((candle, index) => <div key={index}><span>{index === selected.candles.length - 1 ? 'Latest' : `T-${selected.candles.length - 1 - index}`}</span><strong className={candle[3] >= candle[0] ? 'positive' : 'negative'}>{candle[3] >= candle[0] ? '+' : ''}{((candle[3] / candle[0] - 1) * 100).toFixed(2)}%</strong><small>₹{formatter.format(candle[3])}</small></div>)}</div>
            <div className="drawer-controls"><label>Status<select value={ideaState[selected.symbol]?.status || 'Inbox'} onChange={(event) => updateIdea(selected.symbol, { status: event.target.value })}>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label><label>Conviction<div className="conviction conviction--large">{[1, 2, 3, 4, 5].map((value) => <button key={value} className={value <= (ideaState[selected.symbol]?.conviction || 3) ? 'filled' : ''} onClick={() => updateIdea(selected.symbol, { conviction: value })} aria-label={`Set conviction to ${value}`} />)}</div></label></div>
            <label className="notes"><span><NotePencil size={19} /> Thesis notes</span><textarea value={ideaState[selected.symbol]?.note || ''} onChange={(event) => updateIdea(selected.symbol, { note: event.target.value })} placeholder="Catalyst, invalidation, entry logic, open questions…" /></label>
            <button className="drawer-save" onClick={() => updateIdea(selected.symbol, { saved: !(ideaState[selected.symbol]?.saved || false) })}>{ideaState[selected.symbol]?.saved ? <Check size={18} /> : <BookmarkSimple size={18} />} {ideaState[selected.symbol]?.saved ? 'Saved to shortlist' : 'Save to shortlist'}</button>
          </aside>
        </div>
      )}
    </main>
  );
}

export default App;
