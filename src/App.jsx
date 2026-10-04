import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

// ⚠️ PROTOTYPE ONLY: wiring an API key directly into client code exposes it
// to anyone who opens dev tools / views source. Fine for local practice; do
// NOT ship this key in a publicly-shared build. A real deployment should
// proxy these calls through a backend so the key never reaches the browser.
const FINNHUB_API_KEY = import.meta.env.VITE_FINNHUB_API_KEY || '';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// India runs on simulated prices, not a live feed. Three free-tier providers
// were tried in turn and every one of them gates Indian exchange data (NSE
// and, on the ones that even cover it, BSE) behind a paid plan:
//   - Finnhub:       403 "You don't have access to this resource" on .NS
//   - Alpha Vantage: covers .BSE only, and only ~25 requests/day — far too
//                     thin for an 8-symbol watchlist
//   - Twelve Data:   404 "This symbol is available starting with the Grow
//                     or Venture plan" on both NSE and BSE
// A simulated random walk keeps the India market fully usable — the whole
// point of this app is practicing trade mechanics risk-free, not sourcing
// real NSE data — without an API key, rate limits, or a paid plan.

const MARKETS = {
  US: {
    id: 'US',
    label: 'United States',
    flag: '🇺🇸',
    currencySymbol: '$',
    startingCash: 10000,
    provider: 'finnhub',
    watchlist: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'NFLX'],
  },
  IN: {
    id: 'IN',
    label: 'India',
    flag: '🇮🇳',
    currencySymbol: '₹',
    startingCash: 1000000,
    provider: 'simulated',
    watchlist: [
      'RELIANCE.NS',
      'TCS.NS',
      'INFY.NS',
      'HDFCBANK.NS',
      'ICICIBANK.NS',
      'ITC.NS',
      'SBIN.NS',
      'TATAMOTORS.NS',
    ],
  },
  CRYPTO: {
    id: 'CRYPTO',
    label: 'Crypto',
    flag: '🪙',
    currencySymbol: '$',
    startingCash: 10000,
    provider: 'crypto',
    watchlist: [
      'BINANCE:BTCUSDT',
      'BINANCE:ETHUSDT',
      'BINANCE:SOLUSDT',
      'BINANCE:BNBUSDT',
      'BINANCE:XRPUSDT',
      'BINANCE:ADAUSDT',
      'BINANCE:DOGEUSDT',
      'BINANCE:MATICUSDT',
    ],
  },
};

// ---------------------------------------------------------------------------
// PERSISTENCE (localStorage) — see the note in TradingApp/App for how it's wired
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'candlefolio:session:v1';

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null; // corrupt data, storage disabled, private browsing, etc.
  }
}

function saveSession(session) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch (e) {
    // Storage full or unavailable — the app still works, it just won't
    // survive a refresh this time.
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}

const CANDLE_INTERVAL_MS = 30000; // sample live quotes into 30s candles
const QUOTE_POLL_MS = 5000; // US (Finnhub) auto-poll interval
const SIMULATED_TICK_MS = 3000; // India (simulated) price-update interval

const LESSONS = [
  {
    id: 'basics',
    title: 'What is a Stock?',
    body:
      'A share of stock represents partial ownership in a company. When you buy shares, you own a small slice of that business — its assets, earnings, and future growth. Prices move based on supply and demand, driven by news, earnings, and investor sentiment.',
    quiz: {
      q: 'Owning a share of stock means you own...',
      options: ['A loan to the company', 'Partial ownership of the company', 'A government bond', 'Nothing, it is just a number'],
      answer: 1,
    },
  },
  {
    id: 'bid-ask',
    title: 'Reading a Quote',
    body:
      'A live quote shows the current price, the change from the previous close, and percent change. "Previous close" is the price the stock ended the last trading session at — a key reference point for judging whether today is a good or bad day.',
    quiz: {
      q: 'The "previous close" refers to...',
      options: ["Tomorrow's opening price", 'The price at the end of the last session', 'The lowest price ever', 'A random benchmark'],
      answer: 1,
    },
  },
  {
    id: 'diversification',
    title: 'Why Diversify?',
    body:
      'Putting all your capital into one stock means one bad earnings report can wipe out your portfolio. Spreading capital across several unrelated companies reduces the impact any single loser has on your overall performance.',
    quiz: {
      q: 'Diversification primarily helps you...',
      options: ['Guarantee profits', 'Reduce risk from any single position', 'Avoid paying taxes', 'Time the market perfectly'],
      answer: 1,
    },
  },
  {
    id: 'orders',
    title: 'Market vs Limit Orders',
    body:
      'A market order buys or sells immediately at the best available current price — fast, but you accept whatever price the market gives you. A limit order lets you set a target price; it only fills once the live price reaches that level, so you control the price but not the timing.',
    quiz: {
      q: 'A limit order fills...',
      options: ['Immediately, always', 'Only once the market price reaches your target', 'At the end of the trading day', 'Never, it is just a note'],
      answer: 1,
    },
  },
  {
    id: 'stop-orders',
    title: 'Stop Orders (Stop-Loss & Stop-Buy)',
    body:
      'A stop order sits quietly until the price moves past a trigger you set, then fires as a market order. A stop-loss sell triggers if the price falls to your trigger — a safety net that caps how much you can lose on a position without watching it constantly. A stop-buy triggers if the price rises to your trigger — often used to enter a breakout once a stock proves it can push through a resistance level. This is the opposite direction from a limit order at the same price: a limit waits for a better price, a stop waits for the market to confirm a move.',
    quiz: {
      q: 'A stop-loss sell order triggers when the price...',
      options: ['Rises above your trigger', 'Falls to or below your trigger', 'Never changes', 'Reaches the opening price'],
      answer: 1,
    },
  },
  {
    id: 'pnl',
    title: 'Understanding P&L',
    body:
      'Unrealized profit and loss (P&L) is the paper gain or loss on positions you still hold, based on the current market price versus what you paid. It only becomes "realized" once you actually sell.',
    quiz: {
      q: 'Unrealized P&L becomes realized when you...',
      options: ['Watch the chart', 'Sell the position', 'Set a price alert', 'Wait 24 hours'],
      answer: 1,
    },
  },
  {
    id: 'india-data',
    title: 'Why India Prices Are Simulated',
    body:
      "The US watchlist runs on real live quotes from Finnhub. India is different: every free-tier market data API tried for this app — Finnhub, Alpha Vantage, Twelve Data — gates NSE (India's main stock exchange) behind a paid plan, and the one that did offer free access (BSE data via Alpha Vantage) allowed only about 25 requests a day, nowhere near enough for a live 8-stock watchlist. Rather than show you a mostly-broken feed, the India market instead runs a simulated random walk seeded from realistic price levels for each company. The mechanics — buying, selling, limit orders, P&L — all work identically either way; only the India price movements themselves aren't real.",
    quiz: {
      q: 'Why does the India market use simulated prices instead of a live feed?',
      options: [
        'India stocks are too risky to show live',
        'Every free-tier data API blocks or severely limits NSE/BSE access',
        'The app cannot handle a different currency',
        'Simulated prices are more accurate than real ones',
      ],
      answer: 1,
    },
  },
];

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function fmtMoney(amount, currencySymbol) {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return `${currencySymbol}—`;
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${amount < 0 ? '-' : ''}${currencySymbol}${formatted}`;
}

function fmtPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initials(symbol) {
  // Crypto symbols look like "BINANCE:BTCUSDT" — use the coin ticker, not "BI".
  const cryptoMatch = symbol.match(/^[A-Z]+:([A-Z]+?)USDT?$/);
  if (cryptoMatch) return cryptoMatch[1].slice(0, 2).toUpperCase();
  return symbol.replace(/\.(NS|BO|BSE)$/, '').slice(0, 2).toUpperCase();
}

// deterministic pastel-ish hue per symbol, for avatar chips
function hueFor(symbol) {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) % 360;
  return hash;
}

async function fetchQuote(symbol) {
  const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Quote fetch failed for ${symbol}: ${res.status}`);
  return res.json(); // { c, d, dp, h, l, o, pc, t }
}

async function searchSymbols(query) {
  const url = `${FINNHUB_BASE}/search?q=${encodeURIComponent(query)}&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

// ---------------------------------------------------------------------------
// SIMULATED PRICE ENGINE (India market — see the note above CONFIG)
// ---------------------------------------------------------------------------

// Approximate real-world price levels as of the app's build date, just so
// the simulation starts somewhere plausible — these are seeds for a random
// walk, not live prices, and will drift away from reality over a session.
const SIMULATED_STOCK_DIRECTORY = [
  { symbol: 'RELIANCE.NS', name: 'Reliance Industries Ltd', basePrice: 1330 },
  { symbol: 'TCS.NS', name: 'Tata Consultancy Services Ltd', basePrice: 4150 },
  { symbol: 'INFY.NS', name: 'Infosys Ltd', basePrice: 1850 },
  { symbol: 'HDFCBANK.NS', name: 'HDFC Bank Ltd', basePrice: 1650 },
  { symbol: 'ICICIBANK.NS', name: 'ICICI Bank Ltd', basePrice: 1280 },
  { symbol: 'ITC.NS', name: 'ITC Ltd', basePrice: 465 },
  { symbol: 'SBIN.NS', name: 'State Bank of India', basePrice: 830 },
  { symbol: 'TATAMOTORS.NS', name: 'Tata Motors Ltd', basePrice: 990 },
  { symbol: 'BHARTIARTL.NS', name: 'Bharti Airtel Ltd', basePrice: 1700 },
  { symbol: 'WIPRO.NS', name: 'Wipro Ltd', basePrice: 570 },
  { symbol: 'HINDUNILVR.NS', name: 'Hindustan Unilever Ltd', basePrice: 2450 },
  { symbol: 'MARUTI.NS', name: 'Maruti Suzuki India Ltd', basePrice: 12800 },
  { symbol: 'ASIANPAINT.NS', name: 'Asian Paints Ltd', basePrice: 2350 },
  { symbol: 'AXISBANK.NS', name: 'Axis Bank Ltd', basePrice: 1150 },
  { symbol: 'KOTAKBANK.NS', name: 'Kotak Mahindra Bank Ltd', basePrice: 1780 },
  { symbol: 'BAJFINANCE.NS', name: 'Bajaj Finance Ltd', basePrice: 7100 },
  { symbol: 'LT.NS', name: 'Larsen & Toubro Ltd', basePrice: 3600 },
  { symbol: 'SUNPHARMA.NS', name: 'Sun Pharmaceutical Industries Ltd', basePrice: 1780 },
];

function basePriceFor(symbol) {
  const known = SIMULATED_STOCK_DIRECTORY.find((s) => s.symbol === symbol);
  if (known) return known.basePrice;
  // Any symbol outside the directory (shouldn't normally happen, since
  // search only returns directory entries) gets a deterministic fallback
  // price derived from its name so it's at least stable across renders.
  return 200 + (hueFor(symbol) % 15) * 100;
}

async function searchSymbolsSimulated(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SIMULATED_STOCK_DIRECTORY.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).map((s) => ({
    symbol: s.symbol,
    description: s.name,
  }));
}

// ---------------------------------------------------------------------------
// CRYPTO (Finnhub covers crypto quotes on the free tier, but its generic
// /search endpoint is built for stock tickers and doesn't surface trading
// pairs well — so crypto search uses a small static directory instead,
// same approach as the simulated India directory above.)
// ---------------------------------------------------------------------------

const CRYPTO_DIRECTORY = [
  { symbol: 'BINANCE:BTCUSDT', name: 'Bitcoin' },
  { symbol: 'BINANCE:ETHUSDT', name: 'Ethereum' },
  { symbol: 'BINANCE:SOLUSDT', name: 'Solana' },
  { symbol: 'BINANCE:BNBUSDT', name: 'BNB' },
  { symbol: 'BINANCE:XRPUSDT', name: 'XRP' },
  { symbol: 'BINANCE:ADAUSDT', name: 'Cardano' },
  { symbol: 'BINANCE:DOGEUSDT', name: 'Dogecoin' },
  { symbol: 'BINANCE:MATICUSDT', name: 'Polygon' },
  { symbol: 'BINANCE:DOTUSDT', name: 'Polkadot' },
  { symbol: 'BINANCE:LTCUSDT', name: 'Litecoin' },
  { symbol: 'BINANCE:AVAXUSDT', name: 'Avalanche' },
  { symbol: 'BINANCE:LINKUSDT', name: 'Chainlink' },
];

async function searchSymbolsCrypto(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return CRYPTO_DIRECTORY.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).map((s) => ({
    symbol: s.symbol,
    description: s.name,
  }));
}

// ---------------------------------------------------------------------------
// STYLES — Groww-style mobile app: mint green, white cards, bottom tab bar
// ---------------------------------------------------------------------------

// Trading-floor palette: warm brass accent (not the mint-green every neobroker
// uses) on a near-black ground, with green/red kept strictly semantic
// (candle direction, P&L) and separate from the accent.
const colors = {
  bg: '#14171c',
  bgAlt: '#242938',
  card: '#1c2029',
  border: '#2f3544',
  text: '#eef0f3',
  textDim: '#9aa1b2',
  textFaint: '#6b7280',
  accent: '#d9a441',
  accentDark: '#b9832c',
  accentSoft: 'rgba(217,164,65,0.14)',
  up: '#34c78a',
  upSoft: 'rgba(52,199,138,0.16)',
  down: '#f0576a',
  downSoft: 'rgba(240,87,106,0.16)',
  amber: '#f0b429',
  amberSoft: 'rgba(240,180,41,0.14)',
  navy: '#f3efe6', // warm ivory for headings/emphasis — ties to the brass accent
};

const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif";
const FONT_MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const SHELL_WIDTH = 430;

const s = {
  page: {
    minHeight: '100vh',
    background: colors.bgAlt,
    display: 'flex',
    justifyContent: 'center',
    fontFamily: FONT_BODY,
  },
  shell: {
    width: '100%',
    maxWidth: SHELL_WIDTH,
    minHeight: '100vh',
    background: colors.bg,
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    boxShadow: `0 0 0 1px ${colors.border}, 0 20px 60px rgba(0,0,0,0.45)`,
  },
  centerScreen: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'column',
    padding: 24,
    width: '100%',
  },
  card: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: 16,
    padding: 28,
    width: '100%',
    maxWidth: 380,
    boxShadow: '0 2px 12px rgba(20,30,45,0.06)',
  },
  logoDot: {
    width: 44,
    height: 44,
    borderRadius: 14,
    background: `linear-gradient(145deg, ${colors.accent}, ${colors.accentDark})`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    margin: '0 auto 14px',
  },
  h1: { fontFamily: FONT_DISPLAY, fontSize: 24, fontWeight: 600, marginBottom: 6, textAlign: 'center', color: colors.navy },
  mono: { fontFamily: FONT_MONO, fontVariantNumeric: 'tabular-nums' },
  sub: { color: colors.textDim, marginBottom: 24, textAlign: 'center', fontSize: 13.5 },
  input: {
    width: '100%',
    padding: '13px 15px',
    borderRadius: 12,
    border: `1.5px solid ${colors.border}`,
    background: colors.bgAlt,
    color: colors.text,
    fontSize: 15,
    marginBottom: 14,
    boxSizing: 'border-box',
  },
  btn: {
    width: '100%',
    padding: '14px 15px',
    borderRadius: 12,
    border: 'none',
    background: colors.accent,
    color: colors.bg,
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
  },
  btnGhost: {
    padding: '9px 14px',
    borderRadius: 10,
    border: `1.5px solid ${colors.border}`,
    background: colors.card,
    color: colors.text,
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
  },
  marketCard: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: 16,
    padding: 18,
    cursor: 'pointer',
    marginBottom: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    boxShadow: '0 2px 10px rgba(20,30,45,0.05)',
  },

  // App chrome
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 18px 10px',
  },
  greeting: { fontSize: 13, color: colors.textDim },
  greetingName: { fontSize: 17, fontWeight: 700, color: colors.navy },
  demoChip: {
    background: colors.amberSoft,
    color: colors.amber,
    fontSize: 10.5,
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: 20,
    letterSpacing: 0.3,
  },
  scrollArea: { flex: 1, overflowY: 'auto', padding: '4px 18px 96px', WebkitOverflowScrolling: 'touch' },

  bottomNav: {
    position: 'sticky',
    bottom: 0,
    display: 'flex',
    background: colors.card,
    borderTop: `1px solid ${colors.border}`,
    padding: '8px 6px calc(8px + env(safe-area-inset-bottom, 0px))',
  },
  navItem: (active) => ({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '4px 0',
    cursor: 'pointer',
    color: active ? colors.accent : colors.textFaint,
  }),
  navLabel: { fontSize: 10.5, fontWeight: 600 },

  netWorthCard: {
    background: `linear-gradient(135deg, #1f2530, ${colors.card})`,
    border: `1px solid ${colors.border}`,
    color: colors.text,
    borderRadius: 18,
    padding: '20px 20px',
    marginBottom: 16,
  },
  netWorthLabel: { fontSize: 12, opacity: 0.75, marginBottom: 4 },
  netWorthValue: { fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 600, marginBottom: 8 },

  sectionTitle: { fontSize: 14, fontWeight: 700, color: colors.navy, margin: '18px 0 10px' },

  stockRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 4px',
    borderBottom: `1px solid ${colors.border}`,
    cursor: 'pointer',
  },
  avatarChip: (symbol) => ({
    width: 38,
    height: 38,
    borderRadius: 10,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12.5,
    fontWeight: 700,
    color: `hsl(${hueFor(symbol)}, 45%, 32%)`,
    background: `hsl(${hueFor(symbol)}, 65%, 92%)`,
  }),
  pill: (tone) => ({
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    background: tone === 'up' ? colors.upSoft : tone === 'down' ? colors.downSoft : tone === 'amber' ? colors.amberSoft : colors.accentSoft,
    color: tone === 'up' ? colors.up : tone === 'down' ? colors.down : tone === 'amber' ? colors.amber : colors.accent,
  }),

  holdingCard: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },

  statTile: {
    background: colors.card,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    padding: 14,
  },

  // Full-screen stock page
  stockPage: {
    position: 'absolute',
    inset: 0,
    background: colors.bg,
    display: 'flex',
    flexDirection: 'column',
    zIndex: 20,
    animation: 'cfSlideInRight 0.18s ease-out',
  },
  stockHeader: { display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px 10px' },
  backBtn: { fontSize: 20, cursor: 'pointer', color: colors.navy, lineHeight: 1 },

  actionBar: {
    display: 'flex',
    gap: 10,
    padding: '12px 18px calc(12px + env(safe-area-inset-bottom, 0px))',
    borderTop: `1px solid ${colors.border}`,
    background: colors.card,
  },
  actionBtn: (tone) => ({
    flex: 1,
    padding: '13px 0',
    borderRadius: 12,
    border: 'none',
    fontSize: 15,
    fontWeight: 700,
    color: '#fff',
    cursor: 'pointer',
    background: tone === 'up' ? colors.up : colors.down,
  }),

  // Bottom sheet order pad
  sheetBackdrop: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(20,30,45,0.4)',
    zIndex: 30,
    display: 'flex',
    alignItems: 'flex-end',
  },
  sheet: {
    width: '100%',
    background: colors.card,
    borderRadius: '20px 20px 0 0',
    padding: '10px 20px calc(20px + env(safe-area-inset-bottom, 0px))',
    maxHeight: '86%',
    overflowY: 'auto',
    boxShadow: '0 -8px 30px rgba(20,30,45,0.18)',
    animation: 'cfSlideUp 0.2s ease-out',
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 4, background: colors.border, margin: '0 auto 14px' },
};

// ---------------------------------------------------------------------------
// DONUT CHART (portfolio allocation)
// ---------------------------------------------------------------------------

function DonutChart({ slices, size = 150, centerLabel, centerSub }) {
  const total = slices.reduce((sum, sl) => sum + sl.value, 0);
  const r = size / 2;
  const stroke = size * 0.2;
  const radius = r - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const gapPx = slices.length > 1 ? 2.5 : 0;
  let offset = 0;

  if (total <= 0) {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={r} cy={r} r={radius} fill="none" stroke={colors.border} strokeWidth={stroke} />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <g transform={`rotate(-90 ${r} ${r})`}>
        <circle cx={r} cy={r} r={radius} fill="none" stroke={colors.bgAlt} strokeWidth={stroke} />
        {slices.map((sl, i) => {
          const frac = sl.value / total;
          const dash = frac * circumference;
          const el = (
            <circle
              key={i}
              cx={r}
              cy={r}
              r={radius}
              fill="none"
              stroke={sl.color}
              strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, dash - gapPx)} ${circumference - dash + gapPx}`}
              strokeDashoffset={-offset}
              strokeLinecap="round"
            />
          );
          offset += dash;
          return el;
        })}
      </g>
      {centerLabel && (
        <text x={r} y={r - 1} textAnchor="middle" fontFamily={FONT_DISPLAY} fontSize={size * 0.135} fontWeight={600} fill={colors.navy}>
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text x={r} y={r + size * 0.13} textAnchor="middle" fontFamily={FONT_BODY} fontSize={size * 0.065} fill={colors.textDim}>
          {centerSub}
        </text>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// LOGIN / MARKET SELECT
// ---------------------------------------------------------------------------

function LoginScreen({ onLogin }) {
  const [name, setName] = useState('');
  return (
    <div style={s.centerScreen}>
      <div style={s.card}>
        <div style={s.logoDot}>🕯️</div>
        <div style={s.h1}>Candlefolio</div>
        <div style={s.sub}>Practice trading with a demo account. No real money, ever.</div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onLogin(name.trim());
          }}
        >
          <input style={s.input} placeholder="Enter your name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <button style={s.btn} type="submit" disabled={!name.trim()}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}

function MarketSelectScreen({ userName, portfolios, onSelect, onLogout }) {
  return (
    <div style={s.centerScreen}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={s.h1}>Hi, {userName}</div>
        <div style={s.sub}>Pick a market for your demo account</div>
        {Object.values(MARKETS).map((m) => {
          const saved = portfolios && portfolios[m.id];
          const netWorth = saved ? saved.cash + Object.values(saved.holdings || {}).reduce((sum, h) => sum + h.qty * h.avgCost, 0) : null;
          return (
            <div key={m.id} style={s.marketCard} onClick={() => onSelect(m.id)}>
              <div style={{ fontSize: 28 }}>{m.flag}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: colors.navy }}>{m.label} Market</div>
                <div style={{ color: colors.textDim, fontSize: 12.5 }}>
                  {saved ? `Resume — ${fmtMoney(netWorth, m.currencySymbol)} approx.` : `Demo balance: ${fmtMoney(m.startingCash, m.currencySymbol)}`}
                </div>
              </div>
              <div style={{ color: colors.accent, fontWeight: 700 }}>→</div>
            </div>
          );
        })}
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <button style={{ ...s.btnGhost, border: 'none', color: colors.textDim }} onClick={onLogout}>
            Not you? Log out and clear saved progress
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DATA HOOKS
// ---------------------------------------------------------------------------

// provider: 'finnhub' polls Finnhub every QUOTE_POLL_MS, like a live
// terminal. 'simulated' runs an in-memory random walk every SIMULATED_TICK_MS
// instead of calling any network API — see the note above CONFIG for why.

// Simulation state persists per symbol across ticks (a real quote-derived
// price only ever gets seen once and thrown away otherwise). Kept outside
// React state since it's an internal random-walk detail, not something
// anything renders directly — only the derived quote objects are.
function makeSimulatedState(symbol) {
  const base = basePriceFor(symbol);
  const overnightGap = base * (Math.random() - 0.5) * 0.01; // small gap vs. yesterday's close
  const open = base + overnightGap;
  return { price: open, open, high: open, low: open, prevClose: base };
}

function tickSimulatedState(state) {
  const drift = state.price * (Math.random() - 0.5) * 0.006; // ~±0.3% per tick
  const price = Math.max(0.5, state.price + drift);
  return { ...state, price, high: Math.max(state.high, price), low: Math.min(state.low, price) };
}

function simulatedStateToQuote(state) {
  return {
    c: state.price,
    d: state.price - state.prevClose,
    dp: ((state.price - state.prevClose) / state.prevClose) * 100,
    h: state.high,
    l: state.low,
    o: state.open,
    pc: state.prevClose,
  };
}

function useQuotes(symbols, provider = 'finnhub') {
  const [quotes, setQuotes] = useState({});
  const [errors, setErrors] = useState({});
  const [refreshing, setRefreshing] = useState(false);
  const simStateRef = useRef({});

  const applyResult = useCallback((sym, result) => {
    if (result.status === 'fulfilled') {
      setQuotes((prev) => ({ ...prev, [sym]: { ...result.value, fetchedAt: Date.now() } }));
      setErrors((prev) => ({ ...prev, [sym]: null }));
    } else {
      setErrors((prev) => ({ ...prev, [sym]: String(result.reason) }));
    }
  }, []);

  const fetchAll = useCallback(
    async (isCancelled = () => false) => {
      setRefreshing(true);
      if (provider === 'simulated') {
        symbols.forEach((sym) => {
          if (!simStateRef.current[sym]) simStateRef.current[sym] = makeSimulatedState(sym);
          simStateRef.current[sym] = tickSimulatedState(simStateRef.current[sym]);
        });
        if (!isCancelled()) {
          setQuotes((prev) => {
            const next = { ...prev };
            symbols.forEach((sym) => {
              next[sym] = { ...simulatedStateToQuote(simStateRef.current[sym]), fetchedAt: Date.now() };
            });
            return next;
          });
        }
      } else {
        const results = await Promise.allSettled(symbols.map((sym) => fetchQuote(sym)));
        if (!isCancelled()) results.forEach((r, i) => applyResult(symbols[i], r));
      }
      if (!isCancelled()) setRefreshing(false);
    },
    [symbols.join(','), provider]
  );

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (cancelled) return;
      await fetchAll(() => cancelled);
    }

    run();
    // Any provider that hits a real network API (finnhub, crypto) polls at
    // the same live-terminal cadence; only the simulated provider ticks on
    // its own separate, faster schedule.
    const pollMs = provider === 'simulated' ? SIMULATED_TICK_MS : QUOTE_POLL_MS;
    const id = setInterval(run, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbols.join(','), provider]);

  return { quotes, errors, refresh: fetchAll, refreshing, isManual: false };
}

function useCandles(symbol, quotes) {
  const [candles, setCandles] = useState([]);
  const bucketRef = useRef(null);

  useEffect(() => {
    setCandles([]);
    bucketRef.current = null;
  }, [symbol]);

  useEffect(() => {
    const q = quotes[symbol];
    if (!q || !q.c) return;
    const bucketStart = Math.floor(Date.now() / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
    setCandles((prev) => {
      const price = q.c;
      if (bucketRef.current === bucketStart && prev.length) {
        const last = prev[prev.length - 1];
        const updated = { ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price };
        return [...prev.slice(0, -1), updated];
      }
      bucketRef.current = bucketStart;
      const newCandle = { t: bucketStart, o: price, h: price, l: price, c: price };
      const next = [...prev, newCandle];
      return next.length > 60 ? next.slice(next.length - 60) : next;
    });
  }, [symbol, quotes[symbol] && quotes[symbol].c, quotes[symbol] && quotes[symbol].fetchedAt]);

  return candles;
}

// ---------------------------------------------------------------------------
// CHART
// ---------------------------------------------------------------------------

function CandleChart({ candles, currencySymbol, height = 220 }) {
  const width = 380;
  const padding = { top: 12, right: 52, bottom: 16, left: 4 };

  if (!candles.length) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textDim,
          border: `1px dashed ${colors.border}`,
          borderRadius: 12,
          fontSize: 13,
          textAlign: 'center',
          padding: 16,
        }}
      >
        Building chart from live quotes... check back in a few seconds.
      </div>
    );
  }

  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const range = max - min || max * 0.01 || 1;
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const candleW = Math.max(2, Math.min(14, chartW / candles.length - 3));
  const gap = chartW / candles.length;
  const dayOpen = candles[0].o;
  const last = candles[candles.length - 1];
  const lastUp = last.c >= dayOpen;

  const yFor = (price) => padding.top + chartH - ((price - min) / range) * chartH;
  const gridSteps = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="cfChartBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colors.card} />
          <stop offset="100%" stopColor={colors.bgAlt} />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={width} height={height} fill="url(#cfChartBg)" rx={12} />
      {gridSteps.map((f) => {
        const y = padding.top + chartH * f;
        const price = max - range * f;
        return (
          <g key={f}>
            <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke={colors.border} strokeWidth={f === 0 || f === 1 ? 1 : 0.5} strokeDasharray={f === 0 || f === 1 ? 'none' : '2 3'} />
            <text x={width - padding.right + 6} y={y + 3.5} fontSize={9.5} fontFamily={FONT_MONO} fill={colors.textDim}>
              {fmtMoney(price, currencySymbol)}
            </text>
          </g>
        );
      })}
      {/* Day-open reference line — shows how far price has moved from where the session started */}
      <line
        x1={padding.left}
        x2={width - padding.right}
        y1={yFor(dayOpen)}
        y2={yFor(dayOpen)}
        stroke={colors.textFaint}
        strokeWidth={1}
        strokeDasharray="1 4"
      />
      {candles.map((c, i) => {
        const x = padding.left + i * gap + gap / 2;
        const isUp = c.c >= c.o;
        const color = isUp ? colors.up : colors.down;
        const yHigh = yFor(c.h);
        const yLow = yFor(c.l);
        const yOpen = yFor(c.o);
        const yClose = yFor(c.c);
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
        return (
          <g key={c.t}>
            <line x1={x} x2={x} y1={yHigh} y2={yLow} stroke={color} strokeWidth={1.2} />
            <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={color} stroke={color} strokeWidth={0.5} rx={1} />
          </g>
        );
      })}
      {/* Emphasized endpoint — the current price, called out with a dot and a tag */}
      <circle cx={padding.left + (candles.length - 0.5) * gap} cy={yFor(last.c)} r={3} fill={lastUp ? colors.up : colors.down} />
      <text
        x={width - padding.right + 6}
        y={yFor(last.c) + 3.5}
        fontSize={10}
        fontFamily={FONT_MONO}
        fontWeight={600}
        fill={lastUp ? colors.up : colors.down}
      >
        {fmtMoney(last.c, currencySymbol)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// APP CHROME
// ---------------------------------------------------------------------------

function TopBar({ userName, market, onSwitchMarket }) {
  return (
    <div style={s.topBar}>
      <div>
        <div style={s.greeting}>
          {market.flag} {market.label}
        </div>
        <div style={s.greetingName}>Hi, {userName}</div>
        <div style={{ marginTop: 3 }}><MarketStatusChip market={market} /></div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={s.demoChip}>DEMO</span>
        <button style={s.btnGhost} onClick={onSwitchMarket}>
          Switch
        </button>
      </div>
    </div>
  );
}

const NAV_ITEMS = [
  { id: 'watchlist', label: 'Watchlist', icon: '☰' },
  { id: 'portfolio', label: 'Portfolio', icon: '◔' },
  { id: 'orders', label: 'Orders', icon: '⇅' },
  { id: 'learn', label: 'Learn', icon: '▤' },
];

function BottomNav({ nav, setNav, openOrdersCount }) {
  return (
    <nav style={s.bottomNav}>
      {NAV_ITEMS.map((it) => (
        <div key={it.id} style={s.navItem(nav === it.id)} onClick={() => setNav(it.id)}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>{it.icon}</span>
          <span style={s.navLabel}>
            {it.label}
            {it.id === 'orders' && openOrdersCount ? ` (${openOrdersCount})` : ''}
          </span>
        </div>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// ORDER PAD — bottom sheet, Market/Limit + confirmation step
// ---------------------------------------------------------------------------

function OrderPad({ market, symbol, side, quote, position, cash, onClose, onSubmit }) {
  const cs = market.currencySymbol;
  const [orderType, setOrderType] = useState('MARKET');
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState(quote ? quote.c.toFixed(2) : '');
  const [step, setStep] = useState('form');
  const [error, setError] = useState(null);
  const [doneMessage, setDoneMessage] = useState(null);

  const n = Number(qty);
  const needsTargetPrice = orderType === 'LIMIT' || orderType === 'STOP';
  const effectivePrice = orderType === 'MARKET' ? (quote ? quote.c : null) : Number(limitPrice);
  const estTotal = effectivePrice && n ? effectivePrice * n : null;
  const targetPriceLabel = orderType === 'STOP' ? 'Stop price' : 'Limit price';
  // Limit and Stop orders of the same side wait for opposite price moves:
  // a Limit-BUY waits for the price to fall to your target (a good deal),
  // while a Stop-BUY waits for it to rise past your target (breakout entry)
  // — and the reverse for SELL. Same underlying "crossed a threshold"
  // mechanism, just triggered by movement toward vs. away from the price.
  const crossDirection =
    orderType === 'STOP'
      ? side === 'BUY'
        ? 'rises to or above'
        : 'drops to or below'
      : side === 'BUY'
      ? 'drops to or below'
      : 'rises to or above';

  const validate = () => {
    if (!n || n <= 0) return 'Enter a valid quantity.';
    if (needsTargetPrice && (!limitPrice || Number(limitPrice) <= 0)) return `Enter a valid ${targetPriceLabel.toLowerCase()}.`;
    if (orderType === 'MARKET' && (!quote || !quote.c)) return 'No live price available yet for this symbol.';
    if (side === 'BUY' && estTotal !== null && estTotal > cash) {
      return `Insufficient margin. Need ${fmtMoney(estTotal, cs)}, have ${fmtMoney(cash, cs)}.`;
    }
    if (side === 'SELL' && (!position || position.qty < n)) {
      return `You only hold ${position ? position.qty : 0} shares.`;
    }
    return null;
  };

  const goReview = () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep('confirm');
  };

  const confirmOrder = () => {
    const result = onSubmit({
      symbol,
      side,
      orderType,
      qty: n,
      limitPrice: needsTargetPrice ? Number(limitPrice) : null,
      marketPrice: quote ? quote.c : null,
    });
    setDoneMessage(result.message);
    setStep('done');
  };

  return (
    <div style={s.sheetBackdrop} onClick={onClose}>
      <div style={s.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={s.sheetHandle} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 17, color: colors.navy }}>{symbol}</div>
          <button style={{ ...s.btnGhost, border: 'none', fontSize: 18, padding: '2px 6px' }} onClick={onClose}>
            ✕
          </button>
        </div>
        <div style={{ marginBottom: 16 }}>
          <span style={s.pill(side === 'BUY' ? 'up' : 'down')}>{side}</span>{' '}
          <span style={{ color: colors.textDim, fontSize: 12, marginLeft: 6 }}>Demo order — virtual funds only</span>
        </div>

        {step === 'form' && (
          <>
            <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 10 }}>LTP: {quote ? fmtMoney(quote.c, cs) : '…'}</div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              {['MARKET', 'LIMIT', 'STOP'].map((t) => (
                <button
                  key={t}
                  onClick={() => setOrderType(t)}
                  style={{
                    ...s.btnGhost,
                    flex: 1,
                    padding: '10px 0',
                    background: orderType === t ? colors.accentSoft : colors.card,
                    borderColor: orderType === t ? colors.accent : colors.border,
                    color: orderType === t ? colors.accent : colors.text,
                  }}
                >
                  {t === 'MARKET' ? 'Market' : t === 'LIMIT' ? 'Limit' : 'Stop'}
                </button>
              ))}
            </div>

            <label style={{ fontSize: 11.5, color: colors.textDim, textTransform: 'uppercase', fontWeight: 600 }}>Quantity</label>
            <input style={s.input} type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} />

            {needsTargetPrice && (
              <>
                <label style={{ fontSize: 11.5, color: colors.textDim, textTransform: 'uppercase', fontWeight: 600 }}>{targetPriceLabel}</label>
                <input style={s.input} type="number" step="0.01" min={0} value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
                <div style={{ fontSize: 11.5, color: colors.textDim, marginTop: -8, marginBottom: 14 }}>
                  {orderType === 'STOP'
                    ? `Stop-${side === 'BUY' ? 'buy' : 'loss'} — order stays open and triggers as a market order once price ${crossDirection} your stop.`
                    : `Order stays open until price ${crossDirection} your limit.`}
                </div>
              </>
            )}

            <div style={{ fontSize: 13, color: colors.textDim, marginBottom: 16 }}>
              Est. {needsTargetPrice ? `value at ${orderType === 'STOP' ? 'stop' : 'limit'}` : 'total'}: {estTotal ? fmtMoney(estTotal, cs) : '…'}
            </div>

            {error && <div style={{ color: colors.down, fontSize: 13, marginBottom: 12 }}>{error}</div>}

            <button style={{ ...s.btn, background: side === 'BUY' ? colors.up : colors.down }} onClick={goReview}>
              Review {side === 'BUY' ? 'Buy' : 'Sell'} Order
            </button>
          </>
        )}

        {step === 'confirm' && (
          <>
            <div style={{ background: colors.bgAlt, borderRadius: 14, padding: 16, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, marginBottom: 10, color: colors.navy }}>Confirm order</div>
              <Row label="Symbol" value={symbol} />
              <Row label="Action" value={side} />
              <Row label="Order type" value={orderType === 'MARKET' ? 'Market' : orderType === 'LIMIT' ? 'Limit' : 'Stop'} />
              <Row label="Quantity" value={n} />
              {needsTargetPrice && <Row label={targetPriceLabel} value={fmtMoney(Number(limitPrice), cs)} />}
              {orderType === 'MARKET' && <Row label="Reference price (LTP)" value={fmtMoney(quote.c, cs)} />}
              <Row label={needsTargetPrice ? `Est. value at ${orderType === 'STOP' ? 'stop' : 'limit'}` : 'Est. total'} value={fmtMoney(estTotal, cs)} strong />
            </div>
            <div style={{ fontSize: 12, color: colors.amber, background: colors.amberSoft, padding: '10px 12px', borderRadius: 10, marginBottom: 16 }}>
              This is a demo trade using virtual funds. No real order will be placed with any broker or exchange.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...s.btnGhost, flex: 1, padding: '13px 0' }} onClick={() => setStep('form')}>
                Back
              </button>
              <button style={{ ...s.btn, flex: 2, background: side === 'BUY' ? colors.up : colors.down }} onClick={confirmOrder}>
                Confirm &amp; Place
              </button>
            </div>
          </>
        )}

        {step === 'done' && (
          <>
            <div style={{ fontSize: 15, fontWeight: 700, color: colors.up, marginBottom: 10 }}>✓ Order placed</div>
            <div style={{ fontSize: 13.5, color: colors.text, marginBottom: 20, lineHeight: 1.5 }}>{doneMessage}</div>
            <button style={s.btn} onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13.5 }}>
      <span style={{ color: colors.textDim }}>{label}</span>
      <span style={{ fontWeight: strong ? 700 : 500, color: colors.navy }}>{value}</span>
    </div>
  );
}

function EmptyState({ icon, title, subtitle, actionLabel, onAction }) {
  return (
    <div style={{ textAlign: 'center', padding: '30px 16px', marginBottom: 8 }}>
      <div style={{ fontSize: 30, marginBottom: 8, opacity: 0.7 }}>{icon}</div>
      <div style={{ fontWeight: 700, color: colors.navy, fontSize: 14, marginBottom: subtitle ? 4 : 0 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12.5, color: colors.textDim, marginBottom: actionLabel ? 14 : 0 }}>{subtitle}</div>}
      {actionLabel && (
        <button style={{ ...s.btnGhost, borderColor: colors.accent, color: colors.accent }} onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FULL-SCREEN STOCK PAGE
// ---------------------------------------------------------------------------

function StockPage({ market, symbol, quote, err, position, candles, onBack, onOpenOrderPad }) {
  const cs = market.currencySymbol;
  return (
    <div style={s.stockPage}>
      <div style={s.stockHeader}>
        <span style={s.backBtn} onClick={onBack}>
          ←
        </span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, color: colors.navy }}>{symbol}</div>
          {err && <div style={{ color: colors.amber, fontSize: 11 }}>Data may be delayed for this symbol.</div>}
        </div>
      </div>

      <div style={s.scrollArea}>
        <div style={{ marginBottom: 4 }}>
          <div style={{ ...s.mono, fontFamily: FONT_DISPLAY, fontSize: 32, fontWeight: 600, color: colors.navy }}>{quote ? fmtMoney(quote.c, cs) : '…'}</div>
          {quote && (
            <span style={{ ...s.pill(quote.dp >= 0 ? 'up' : 'down'), ...s.mono }}>
              {fmtMoney(quote.d, cs)} ({fmtPct(quote.dp)})
            </span>
          )}
        </div>

        <div style={{ margin: '18px 0' }}>
          <CandleChart candles={candles} currencySymbol={cs} height={200} />
        </div>

        {quote && (
          <div style={{ ...s.mono, display: 'flex', gap: 16, fontSize: 12, marginBottom: 14 }}>
            <span style={{ color: colors.textDim }}>Bid <span style={{ color: colors.up }}>{fmtMoney(quote.c * 0.9999, cs)}</span></span>
            <span style={{ color: colors.textDim }}>Ask <span style={{ color: colors.down }}>{fmtMoney(quote.c * 1.0001, cs)}</span></span>
          </div>
        )}
        {quote && <RangeBar label="Today's Range" low={quote.l} high={quote.h} price={quote.c} cs={cs} />}
        {quote && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 8 }}>
            <MiniStat label="Open" value={fmtMoney(quote.o, cs)} />
            <MiniStat label="Prev Close" value={fmtMoney(quote.pc, cs)} />
            <MiniStat label="High" value={fmtMoney(quote.h, cs)} />
            <MiniStat label="Low" value={fmtMoney(quote.l, cs)} />
          </div>
        )}

        {quote && <MarketDepth symbol={symbol} price={quote.c} cs={cs} />}

        {position && position.qty > 0 && quote && (
          <div style={{ marginTop: 16, background: colors.accentSoft, borderRadius: 12, padding: 12, fontSize: 13, color: colors.navy }}>
            <div>You hold <strong>{position.qty}</strong> @ avg {fmtMoney(position.avgCost, cs)}</div>
            <div style={{ ...s.mono, marginTop: 4, color: quote.c >= position.avgCost ? colors.up : colors.down }}>
              P&amp;L {fmtMoney((quote.c - position.avgCost) * position.qty, cs)} ({fmtPct(((quote.c - position.avgCost) / position.avgCost) * 100)})
            </div>
          </div>
        )}
      </div>

      <div style={s.actionBar}>
        <button style={s.actionBtn('down')} onClick={() => onOpenOrderPad('SELL')}>
          Sell
        </button>
        <button style={s.actionBtn('up')} onClick={() => onOpenOrderPad('BUY')}>
          Buy
        </button>
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={s.statTile}>
      <div style={{ fontSize: 10.5, color: colors.textDim, textTransform: 'uppercase', fontWeight: 600, marginBottom: 3 }}>{label}</div>
      <div style={{ ...s.mono, fontSize: 14, fontWeight: 600, color: colors.navy }}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// REAL-TRADING-APP WIDGETS: market status, ticker tape, range bar, depth
// ---------------------------------------------------------------------------

function getMarketStatus(market) {
  if (market.provider === 'crypto') return { open: true, label: 'LIVE 24/7' };
  const isIndia = market.provider === 'simulated';
  const tz = isIndia ? 'Asia/Kolkata' : 'America/New_York';
  const [openMin, closeMin] = isIndia ? [9 * 60 + 15, 15 * 60 + 30] : [9 * 60 + 30, 16 * 60];
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    const mins = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
    const weekday = !['Sat', 'Sun'].includes(get('weekday'));
    const open = weekday && mins >= openMin && mins < closeMin;
    return { open, label: open ? 'MARKET OPEN' : 'MARKET CLOSED' };
  } catch (e) {
    return { open: true, label: 'MARKET OPEN' };
  }
}

function MarketStatusChip({ market }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const st = getMarketStatus(market);
  const c = st.open ? colors.up : colors.textDim;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: c }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: c, boxShadow: st.open ? `0 0 6px ${c}` : 'none' }} />
      {st.label}
    </span>
  );
}

function TickerTape({ market, quotes }) {
  const items = market.watchlist.filter((sym) => quotes[sym]);
  if (!items.length) return null;
  const row = items.map((sym) => {
    const q = quotes[sym];
    const up = q.dp >= 0;
    return (
      <span key={sym} style={{ ...s.mono, fontSize: 12, marginRight: 22, whiteSpace: 'nowrap' }}>
        <span style={{ color: colors.navy, fontWeight: 600 }}>{sym.replace(/\.NS$/, '').replace(/^BINANCE:/, '')}</span>{' '}
        <span style={{ color: colors.textDim }}>{fmtMoney(q.c, market.currencySymbol)}</span>{' '}
        <span style={{ color: up ? colors.up : colors.down }}>
          {up ? '▲' : '▼'} {fmtPct(q.dp)}
        </span>
      </span>
    );
  });
  return (
    <div style={{ overflow: 'hidden', borderTop: `1px solid ${colors.border}`, borderBottom: `1px solid ${colors.border}`, background: colors.card, padding: '7px 0', margin: '0 -16px 14px' }}>
      <div style={{ display: 'inline-block', whiteSpace: 'nowrap', animation: `cfTicker ${Math.max(20, items.length * 5)}s linear infinite` }}>
        {row}
        {row}
      </div>
    </div>
  );
}

function RangeBar({ label, low, high, price, cs }) {
  const pct = high > low ? Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100)) : 50;
  return (
    <div style={{ ...s.statTile, marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, color: colors.textDim, textTransform: 'uppercase', fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div style={{ position: 'relative', height: 4, borderRadius: 2, background: `linear-gradient(90deg, ${colors.down}, ${colors.amber}, ${colors.up})` }}>
        <div style={{ position: 'absolute', left: `${pct}%`, top: -4, width: 3, height: 12, marginLeft: -1.5, borderRadius: 2, background: colors.navy }} />
      </div>
      <div style={{ ...s.mono, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: colors.textDim, marginTop: 8 }}>
        <span>{fmtMoney(low, cs)}</span>
        <span>{fmtMoney(high, cs)}</span>
      </div>
    </div>
  );
}

// Simulated Level-2 depth derived from the live price (display only — orders still fill at the quote).
function MarketDepth({ symbol, price, cs }) {
  const book = useMemo(() => {
    let seed = 0;
    for (let i = 0; i < symbol.length; i++) seed = (seed * 31 + symbol.charCodeAt(i)) >>> 0;
    seed = (seed + Math.floor(price * 100)) >>> 0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const tick = price * 0.0002;
    const mk = (dir) => Array.from({ length: 5 }, (_, i) => ({ px: price + dir * tick * (i + 1), qty: Math.round(20 + rnd() * 480) }));
    return { bids: mk(-1), asks: mk(1) };
  }, [symbol, price]);
  const max = Math.max(...book.bids.concat(book.asks).map((l) => l.qty));
  const side = (levels, tone) =>
    levels.map((l, i) => (
      <div key={i} style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '4px 8px', ...s.mono, fontSize: 12 }}>
        <div style={{ position: 'absolute', top: 0, bottom: 0, [tone === 'up' ? 'left' : 'right']: 0, width: `${(l.qty / max) * 100}%`, background: tone === 'up' ? colors.upSoft : colors.downSoft }} />
        <span style={{ position: 'relative', color: tone === 'up' ? colors.up : colors.down }}>{fmtMoney(l.px, cs)}</span>
        <span style={{ position: 'relative', color: colors.textDim }}>{l.qty}</span>
      </div>
    ));
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...s.sectionTitle, marginBottom: 8 }}>Market Depth</div>
      <div style={{ ...s.statTile, padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', ...s.mono, fontSize: 10.5, color: colors.textDim, padding: '6px 8px', borderBottom: `1px solid ${colors.border}`, textTransform: 'uppercase' }}>
          <div style={{ flex: 1 }}>Bid · Qty</div>
          <div style={{ flex: 1, textAlign: 'right' }}>Ask · Qty</div>
        </div>
        <div style={{ display: 'flex' }}>
          <div style={{ flex: 1, borderRight: `1px solid ${colors.border}` }}>{side(book.bids, 'up')}</div>
          <div style={{ flex: 1 }}>{side(book.asks, 'down')}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WATCHLIST (Home)
// ---------------------------------------------------------------------------

function WatchlistScreen({ market, quotes, errors, onOpenStock }) {
  const cs = market.currencySymbol;
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const doSearch =
    market.provider === 'simulated' ? searchSymbolsSimulated : market.provider === 'crypto' ? searchSymbolsCrypto : searchSymbols;

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const results = await doSearch(searchQuery.trim());
        if (!cancelled) setSearchResults(results.slice(0, 8));
      } catch (e) {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchQuery, market.provider]);

  return (
    <div>
      <TickerTape market={market} quotes={quotes} />
      <input
        style={s.input}
        placeholder="Search stocks, e.g. AAPL"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />

      {searchQuery.trim() ? (
        <div>
          {searching && <div style={{ color: colors.textDim, fontSize: 13, padding: '8px 4px' }}>Searching...</div>}
          {searchResults.map((r) => (
            <div key={r.symbol} style={s.stockRow} onClick={() => { onOpenStock(r.symbol); setSearchQuery(''); setSearchResults([]); }}>
              <div style={s.avatarChip(r.symbol)}>{initials(r.symbol)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: colors.navy }}>{r.symbol}</div>
                <div style={{ fontSize: 11.5, color: colors.textDim }}>{r.description}</div>
              </div>
              <div style={{ color: colors.accent, fontWeight: 700 }}>+</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={s.sectionTitle}>Your Watchlist</div>
          {market.provider === 'simulated' && (
            <div style={{ fontSize: 11.5, color: colors.textDim, marginBottom: 10, marginTop: -6 }}>
              India prices are simulated for practice — no free real-time NSE data source was available.
            </div>
          )}
          {market.watchlist.map((sym) => {
            const q = quotes[sym];
            const err = errors && errors[sym];
            const tone = q ? (q.dp >= 0 ? 'up' : 'down') : null;
            return (
              <div key={sym} style={s.stockRow} onClick={() => onOpenStock(sym)}>
                <div style={s.avatarChip(sym)}>{initials(sym)}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: colors.navy }}>{sym}</div>
                  <div style={{ ...s.mono, fontSize: 12, color: err ? colors.amber : colors.textDim }}>
                    {q ? fmtMoney(q.c, cs) : err ? 'Unavailable — try again shortly' : 'Loading…'}
                  </div>
                </div>
                {tone && <span style={{ ...s.pill(tone), ...s.mono }}>{fmtPct(q.dp)}</span>}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PORTFOLIO
// ---------------------------------------------------------------------------

const ALLOCATION_COLORS = ['#00d09c', '#5367ff', '#ffb020', '#eb5b3c', '#8a6dff', '#00b8d9', '#ff8fa3', '#7cb342'];

function PortfolioScreen({ market, cash, holdings, orders, quotes, onGoToWatchlist }) {
  const cs = market.currencySymbol;
  const positions = Object.entries(holdings).filter(([, h]) => h.qty > 0);
  const filledOrders = orders.filter((o) => o.status === 'FILLED');

  let totalMktValue = 0;
  let totalCost = 0;

  const rows = positions.map(([symbol, h], i) => {
    const q = quotes[symbol];
    const price = q ? q.c : null;
    const mktValue = price ? price * h.qty : 0;
    const cost = h.avgCost * h.qty;
    totalMktValue += mktValue;
    totalCost += cost;
    const pnl = price ? mktValue - cost : null;
    const pnlPct = price && cost > 0 ? (pnl / cost) * 100 : null;
    return { symbol, qty: h.qty, avgCost: h.avgCost, price, mktValue, pnl, pnlPct, color: ALLOCATION_COLORS[i % ALLOCATION_COLORS.length] };
  });

  const totalPnl = totalMktValue - totalCost;
  const netWorth = cash + totalMktValue;
  const dayPnl = Object.entries(holdings).reduce((sum, [sym, h]) => {
    const q = quotes[sym];
    return q && h.qty > 0 ? sum + q.d * h.qty : sum;
  }, 0);

  return (
    <div>
      <div style={s.netWorthCard}>
        <div style={s.netWorthLabel}>Total Portfolio Value</div>
        <div style={s.netWorthValue}>{fmtMoney(netWorth, cs)}</div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>Today's P&amp;L</div>
            <div style={{ ...s.mono, fontSize: 13.5, fontWeight: 600, color: dayPnl >= 0 ? colors.up : colors.down }}>{fmtMoney(dayPnl, cs)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>Overall P&amp;L</div>
            <div style={{ ...s.mono, fontSize: 13.5, fontWeight: 600, color: totalPnl >= 0 ? colors.up : colors.down }}>{fmtMoney(totalPnl, cs)}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 6 }}>
        <MiniStat label="Margin Available" value={fmtMoney(cash, cs)} />
        <MiniStat label="Holdings Value" value={fmtMoney(totalMktValue, cs)} />
      </div>

      {rows.length > 0 && (
        <>
          <div style={s.sectionTitle}>Allocation</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 8 }}>
            <DonutChart
              slices={rows.map((r) => ({ value: r.mktValue, color: r.color }))}
              size={116}
              centerLabel={totalMktValue >= 1000 ? `${cs}${(totalMktValue / 1000).toFixed(1)}k` : `${cs}${Math.round(totalMktValue)}`}
              centerSub="Total"
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((r) => (
                <div key={r.symbol} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: r.color, flexShrink: 0 }} />
                  <span style={{ color: colors.navy, fontWeight: 600 }}>{r.symbol}</span>
                  <span style={{ ...s.mono, color: colors.textDim, marginLeft: 'auto' }}>
                    {totalMktValue > 0 ? `${((r.mktValue / totalMktValue) * 100).toFixed(0)}%` : '0%'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={s.sectionTitle}>Holdings</div>
      {rows.length === 0 ? (
        <EmptyState
          icon="◔"
          title="No positions yet"
          subtitle="Buy your first demo position from the Watchlist to see it here."
          actionLabel="Go to Watchlist"
          onAction={onGoToWatchlist}
        />
      ) : (
        rows.map((r) => (
          <div key={r.symbol} style={s.holdingCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <div style={s.avatarChip(r.symbol)}>{initials(r.symbol)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: colors.navy }}>{r.symbol}</div>
                <div style={{ fontSize: 11.5, color: colors.textDim }}>
                  {r.qty} shares · avg {fmtMoney(r.avgCost, cs)}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: colors.navy }}>{r.price ? fmtMoney(r.mktValue, cs) : '…'}</div>
                {r.pnl !== null && <span style={s.pill(r.pnl >= 0 ? 'up' : 'down')}>{fmtMoney(r.pnl, cs)}</span>}
              </div>
            </div>
          </div>
        ))
      )}

      <div style={s.sectionTitle}>Trade History</div>
      {filledOrders.length === 0 ? (
        <EmptyState icon="📈" title="No trades filled yet" subtitle="Every buy and sell you complete will be logged here." />
      ) : (
        [...filledOrders].reverse().map((o) => (
          <div key={o.id} style={{ ...s.stockRow, cursor: 'default' }}>
            <div style={s.avatarChip(o.symbol)}>{initials(o.symbol)}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: colors.navy }}>
                {o.side} {o.symbol} · {o.qty} sh
              </div>
              <div style={{ fontSize: 11.5, color: colors.textDim }}>
                {orderTypeLabel(o.orderType)} @ {fmtMoney(o.filledPrice, cs)} · {new Date(o.filledAt).toLocaleTimeString()}
              </div>
            </div>
            <span style={s.pill(o.side === 'BUY' ? 'up' : 'down')}>{o.side}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ORDERS
// ---------------------------------------------------------------------------

function orderTypeLabel(orderType) {
  return orderType === 'MARKET' ? 'Market' : orderType === 'STOP' ? 'Stop' : 'Limit';
}

function OrdersScreen({ market, orders, onCancel, onGoToWatchlist }) {
  const cs = market.currencySymbol;
  const open = orders.filter((o) => o.status === 'PENDING');
  const history = orders.filter((o) => o.status !== 'PENDING');

  return (
    <div>
      <div style={s.sectionTitle}>Open Orders</div>
      {open.length === 0 ? (
        <EmptyState
          icon="⇅"
          title="No open orders"
          subtitle="Limit and stop orders you place will wait here until they fill."
          actionLabel="Go to Watchlist"
          onAction={onGoToWatchlist}
        />
      ) : (
        open.map((o) => (
          <div key={o.id} style={s.holdingCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={s.avatarChip(o.symbol)}>{initials(o.symbol)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: colors.navy }}>
                  {o.side} {o.symbol}
                </div>
                <div style={{ fontSize: 11.5, color: colors.textDim }}>
                  {o.qty} sh @ {fmtMoney(o.limitPrice, cs)} {orderTypeLabel(o.orderType).toLowerCase()} · placed{' '}
                  {new Date(o.createdAt).toLocaleTimeString()}
                </div>
              </div>
              <button style={s.btnGhost} onClick={() => onCancel(o.id)}>
                Cancel
              </button>
            </div>
          </div>
        ))
      )}

      <div style={s.sectionTitle}>Order History</div>
      {history.length === 0 ? (
        <EmptyState icon="📜" title="No order history yet" subtitle="Filled and cancelled orders will show up here." />
      ) : (
        [...history].reverse().map((o) => (
          <div key={o.id} style={{ ...s.stockRow, cursor: 'default' }}>
            <div style={s.avatarChip(o.symbol)}>{initials(o.symbol)}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, color: colors.navy }}>
                {o.side} {o.symbol} · {o.qty} sh
              </div>
              <div style={{ fontSize: 11.5, color: colors.textDim }}>
                {orderTypeLabel(o.orderType)} @ {fmtMoney(o.filledPrice ?? o.limitPrice, cs)}
              </div>
            </div>
            <span style={s.pill(o.status === 'FILLED' ? 'up' : 'amber')}>{o.status}</span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEARN
// ---------------------------------------------------------------------------

function LearnScreen({ progress, onComplete }) {
  const [openLesson, setOpenLesson] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [result, setResult] = useState(null);

  const lesson = LESSONS.find((l) => l.id === openLesson);
  const completedCount = Object.values(progress).filter(Boolean).length;

  const submit = () => {
    if (selectedOption === null) return;
    const correct = selectedOption === lesson.quiz.answer;
    setResult(correct ? 'correct' : 'incorrect');
    if (correct) onComplete(lesson.id);
  };

  if (lesson) {
    return (
      <div>
        <button
          style={{ ...s.btnGhost, marginBottom: 16 }}
          onClick={() => {
            setOpenLesson(null);
            setSelectedOption(null);
            setResult(null);
          }}
        >
          ← Back to lessons
        </button>
        <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 12, color: colors.navy }}>{lesson.title}</div>
        <p style={{ lineHeight: 1.6, color: colors.text, marginBottom: 20, fontSize: 14 }}>{lesson.body}</p>
        <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 14 }}>{lesson.quiz.q}</div>
        {lesson.quiz.options.map((opt, i) => (
          <div
            key={i}
            onClick={() => setSelectedOption(i)}
            style={{
              padding: '12px 14px',
              borderRadius: 12,
              border: `1.5px solid ${selectedOption === i ? colors.accent : colors.border}`,
              marginBottom: 8,
              cursor: 'pointer',
              background: selectedOption === i ? colors.accentSoft : colors.card,
              color: colors.text,
              fontSize: 13.5,
            }}
          >
            {opt}
          </div>
        ))}
        <button style={{ ...s.btn, marginTop: 8 }} onClick={submit}>
          Submit Answer
        </button>
        {result && (
          <div style={{ marginTop: 12, color: result === 'correct' ? colors.up : colors.down, fontWeight: 700, fontSize: 13.5 }}>
            {result === 'correct' ? '✅ Correct! Lesson complete.' : '❌ Not quite — review and try again.'}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16, color: colors.textDim, fontSize: 13.5 }}>
        Progress: {completedCount} / {LESSONS.length} lessons completed
      </div>
      {LESSONS.map((l) => (
        <div
          key={l.id}
          style={{ ...s.holdingCard, cursor: 'pointer' }}
          onClick={() => {
            setOpenLesson(l.id);
            setSelectedOption(null);
            setResult(null);
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 14, color: colors.navy }}>
            {progress[l.id] ? '✅ ' : '📘 '}
            {l.title}
          </div>
          <div style={{ fontSize: 12.5, color: colors.textDim }}>{l.body.slice(0, 80)}...</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MAIN TRADING APP
// ---------------------------------------------------------------------------

function TradingApp({ userName, marketId, initialPortfolio, onPersist, onSwitchMarket }) {
  const market = MARKETS[marketId];
  const [nav, setNav] = useState('watchlist');
  const [cash, setCash] = useState(initialPortfolio ? initialPortfolio.cash : market.startingCash);
  const [holdings, setHoldings] = useState(initialPortfolio ? initialPortfolio.holdings : {});
  const [orders, setOrders] = useState(initialPortfolio ? initialPortfolio.orders : []);
  const [openStock, setOpenStock] = useState(null);
  const [orderPad, setOrderPad] = useState(null); // { side }
  const [progress, setProgress] = useState(initialPortfolio ? initialPortfolio.progress : {});

  // Persist this market's portfolio (cash, holdings, orders, lesson
  // progress) to localStorage on every change, so refreshing the page
  // resumes right where you left off instead of resetting to the starting
  // balance. Each market keeps its own saved portfolio.
  useEffect(() => {
    onPersist(marketId, { cash, holdings, orders, progress });
  }, [cash, holdings, orders, progress, marketId, onPersist]);

  // Include the currently-open stock even when it's a search result outside
  // the fixed watchlist — otherwise its quote/chart never fetches and its
  // stock page is stuck on "Loading…" forever.
  const trackedSymbols = openStock && !market.watchlist.includes(openStock) ? [...market.watchlist, openStock] : market.watchlist;
  const { quotes, errors } = useQuotes(trackedSymbols, market.provider);
  const candles = useCandles(openStock, quotes);

  const applyFill = useCallback((symbol, side, qty, price) => {
    setHoldings((prev) => {
      const existing = prev[symbol] || { qty: 0, avgCost: 0 };
      if (side === 'BUY') {
        const newQty = existing.qty + qty;
        const newAvgCost = (existing.avgCost * existing.qty + price * qty) / newQty;
        return { ...prev, [symbol]: { qty: newQty, avgCost: newAvgCost } };
      }
      const newQty = existing.qty - qty;
      return { ...prev, [symbol]: { qty: newQty, avgCost: newQty > 0 ? existing.avgCost : 0 } };
    });
    setCash((prev) => (side === 'BUY' ? prev - price * qty : prev + price * qty));
  }, []);

  useEffect(() => {
    setOrders((prevOrders) => {
      let changed = false;
      const next = prevOrders.map((o) => {
        if (o.status !== 'PENDING') return o;
        const q = quotes[o.symbol];
        if (!q || !q.c) return o;
        // LIMIT waits for a favorable move (BUY: price falls to target);
        // STOP waits for the opposite — a breakout (BUY) or a protective
        // stop-loss trigger (SELL) — hence the flipped condition below.
        const crossed =
          o.orderType === 'STOP'
            ? o.side === 'BUY'
              ? q.c >= o.limitPrice
              : q.c <= o.limitPrice
            : o.side === 'BUY'
            ? q.c <= o.limitPrice
            : q.c >= o.limitPrice;
        if (!crossed) return o;
        changed = true;
        applyFill(o.symbol, o.side, o.qty, o.limitPrice);
        return { ...o, status: 'FILLED', filledPrice: o.limitPrice, filledAt: Date.now() };
      });
      return changed ? next : prevOrders;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotes]);

  const handleOrderSubmit = useCallback(
    ({ symbol, side, orderType, qty, limitPrice, marketPrice }) => {
      const id = genId();
      if (orderType === 'MARKET') {
        applyFill(symbol, side, qty, marketPrice);
        setOrders((prev) => [
          ...prev,
          { id, symbol, side, orderType, qty, limitPrice: null, status: 'FILLED', filledPrice: marketPrice, createdAt: Date.now(), filledAt: Date.now() },
        ]);
        return { message: `Market order filled: ${side === 'BUY' ? 'bought' : 'sold'} ${qty} ${symbol} @ ${fmtMoney(marketPrice, market.currencySymbol)}.` };
      }
      setOrders((prev) => [
        ...prev,
        { id, symbol, side, orderType, qty, limitPrice, status: 'PENDING', filledPrice: null, createdAt: Date.now(), filledAt: null },
      ]);
      const typeLabel = orderType === 'STOP' ? 'Stop' : 'Limit';
      return {
        message: `${typeLabel} order placed: ${side} ${qty} ${symbol} at ${fmtMoney(limitPrice, market.currencySymbol)}. It will fill automatically as a market order once the price crosses your ${typeLabel.toLowerCase()}.`,
      };
    },
    [applyFill, market.currencySymbol]
  );

  const cancelOrder = useCallback((id) => {
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status: 'CANCELLED', filledAt: Date.now() } : o)));
  }, []);

  const openOrdersCount = orders.filter((o) => o.status === 'PENDING').length;
  const quote = openStock ? quotes[openStock] : null;
  const position = openStock ? holdings[openStock] : null;

  return (
    <div style={s.shell}>
      <TopBar userName={userName} market={market} onSwitchMarket={onSwitchMarket} />
      <div style={s.scrollArea}>
        {nav === 'watchlist' && (
          <WatchlistScreen market={market} quotes={quotes} errors={errors} onOpenStock={setOpenStock} />
        )}
        {nav === 'portfolio' && (
          <PortfolioScreen market={market} cash={cash} holdings={holdings} orders={orders} quotes={quotes} onGoToWatchlist={() => setNav('watchlist')} />
        )}
        {nav === 'orders' && <OrdersScreen market={market} orders={orders} onCancel={cancelOrder} onGoToWatchlist={() => setNav('watchlist')} />}
        {nav === 'learn' && <LearnScreen progress={progress} onComplete={(id) => setProgress((p) => ({ ...p, [id]: true }))} />}
      </div>
      <BottomNav nav={nav} setNav={setNav} openOrdersCount={openOrdersCount} />

      {openStock && (
        <StockPage
          market={market}
          symbol={openStock}
          quote={quote}
          err={errors[openStock]}
          position={position}
          candles={candles}
          onBack={() => setOpenStock(null)}
          onOpenOrderPad={(side) => setOrderPad({ side })}
        />
      )}

      {orderPad && (
        <OrderPad
          market={market}
          symbol={openStock}
          side={orderPad.side}
          quote={quote}
          position={position}
          cash={cash}
          onClose={() => setOrderPad(null)}
          onSubmit={handleOrderSubmit}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROOT APP
// ---------------------------------------------------------------------------

export default function App() {
  // Session shape: { userName, marketId, portfolios: { [marketId]: {cash,holdings,orders,progress} } }
  // Loaded once from localStorage so a page refresh resumes exactly where
  // you left off — the app only ever starts fresh at the login screen if
  // there's genuinely nothing saved yet, or after "Log out".
  const [session, setSession] = useState(() => loadSession() || { userName: '', marketId: null, portfolios: {} });
  const [stage, setStage] = useState(() => {
    if (session.userName && session.marketId) return 'app';
    if (session.userName) return 'market-select';
    return 'login';
  });

  const updateSession = useCallback((patch) => {
    setSession((prev) => {
      const next = { ...prev, ...patch };
      saveSession(next);
      return next;
    });
  }, []);

  const persistPortfolio = useCallback((forMarketId, portfolio) => {
    setSession((prev) => {
      const next = { ...prev, portfolios: { ...prev.portfolios, [forMarketId]: portfolio } };
      saveSession(next);
      return next;
    });
  }, []);

  const handleLogout = useCallback(() => {
    clearSession();
    setSession({ userName: '', marketId: null, portfolios: {} });
    setStage('login');
  }, []);

  let content;
  if (stage === 'login') {
    content = (
      <LoginScreen
        onLogin={(name) => {
          updateSession({ userName: name });
          setStage('market-select');
        }}
      />
    );
  } else if (stage === 'market-select') {
    content = (
      <MarketSelectScreen
        userName={session.userName}
        portfolios={session.portfolios}
        onSelect={(id) => {
          updateSession({ marketId: id });
          setStage('app');
        }}
        onLogout={handleLogout}
      />
    );
  } else {
    content = (
      <TradingApp
        key={session.marketId}
        userName={session.userName}
        marketId={session.marketId}
        initialPortfolio={session.portfolios[session.marketId]}
        onPersist={persistPortfolio}
        onSwitchMarket={() => setStage('market-select')}
      />
    );
  }

  return (
    <div style={s.page}>
      <style>{`
        @keyframes cfSlideUp { from { transform: translateY(18px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes cfTicker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes cfSlideInRight { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
        }
      `}</style>
      {content}
    </div>
  );
}
