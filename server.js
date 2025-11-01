// server.js — AI Picks v2: 1X/2 + Goals (O2.5/U2.5, BTTS, Home O1.5) with probabilities
// Fetch fixtures from Football-Data.org; predict locally (no external prediction API).
// Render-ready (0.0.0.0:$PORT), Istanbul timezone filtering, midnight refresh.
import express from 'express';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TZ = process.env.TZ || 'Europe/Istanbul';
const API_KEY = process.env.FOOTBALL_DATA_KEY || '';
const START_HOUR = parseInt(process.env.START_HOUR || '11', 10);
const END_HOUR = 24;
const FALLBACK_DEMO = process.env.FALLBACK_DEMO === '1';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

// ---- time helpers
function fmtYMD(d, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}
function todayYMD(tz = TZ) { return fmtYMD(new Date(), tz); }
function localParts(iso, tz = TZ) {
  const dt = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dt);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute };
}
function toLocalLabel(iso, tz = TZ) {
  const { y, m, d, hh, mm } = localParts(iso, tz);
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}`;
}
function normTeam(s=''){ return s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }

// ---- seed strengths (Elo-like). Unlisted default to 1500.
const SEED_ELO = {
  'real madrid':1850,'barcelona':1820,'manchester city':1880,'liverpool':1820,'arsenal':1800,
  'chelsea':1750,'manchester united':1760,'bayern munich':1900,'inter':1820,'juventus':1800,
  'milan':1780,'psg':1850,'atletico madrid':1800,'napoli':1780,'roma':1740,'tottenham':1760,
  'galatasaray':1700,'fenerbahce':1680,'besiktas':1650,'trabzonspor':1620
};

// ---- league baseline goals per match (heuristic)
function leagueBaseGpm(league=''){
  const k = (league||'').toLowerCase();
  if (k.includes('super lig') || k.includes('süper lig')) return 2.7;
  if (k.includes('premier')) return 2.9;
  if (k.includes('la liga')) return 2.6;
  if (k.includes('bundesliga')) return 3.1;
  if (k.includes('serie a')) return 2.5;
  if (k.includes('ligue 1')) return 2.7;
  if (k.includes('eredivisie')) return 3.0;
  if (k.includes('primeira')) return 2.5;
  return 2.65; // default global
}

// ---- Poisson helpers
function fac(n){ let r=1; for(let i=2;i<=n;i++) r*=i; return r; }
function poisPmf(lam, k){ return Math.exp(-lam) * Math.pow(lam, k) / fac(k); }
function poisCdf(lam, k){ // P(X<=k)
  let s=0; for(let i=0;i<=k;i++) s += poisPmf(lam,i); return s;
}

// ---- probability grid for 1X2 via truncated Poisson convolution
function probs1X2(lh, la, cap=10){
  let pH=0, pD=0, pA=0;
  for(let i=0;i<=cap;i++){
    const ph = poisPmf(lh, i);
    for(let j=0;j<=cap;j++){
      const pa = poisPmf(la, j);
      if (i>j) pH += ph*pa;
      else if (i===j) pD += ph*pa;
      else pA += ph*pa;
    }
  }
  // small tail correction (mass above cap) is ignored, acceptable for cap=10..12
  const s = pH+pD+pA || 1;
  return { pH: pH/s, pD: pD/s, pA: pA/s };
}

// ---- expected goals model (simple, calibrated)
function expectedGoals(home, away, leagueName=''){
  const baseG = leagueBaseGpm(leagueName); // total expected goals
  const HOME_ADV_ELO = 60; // reduced so 1 is not over-picked
  const SCALE = 700;       // higher scale -> softer influence from Elo diff
  const rh = SEED_ELO[normTeam(home)] ?? 1500;
  const ra = SEED_ELO[normTeam(away)] ?? 1500;
  const diff = (rh + HOME_ADV_ELO) - ra; // home edge

  // Split base goals into home/away shares biased by strength difference
  // logistic split in [0.35, 0.65]
  const split = 0.5 + 0.15 * Math.tanh(diff / SCALE);
  const lambdaHome = Math.max(0.2, baseG * split);
  const lambdaAway = Math.max(0.2, baseG * (1 - split));
  return { lambdaHome, lambdaAway, baseG, rh, ra, diff };
}

// ---- build best market
function bestMarket(home, away, league){
  const { lambdaHome: lh, lambdaAway: la } = expectedGoals(home, away, league);
  const cap = 12;

  // 1X2
  const { pH, pD, pA } = probs1X2(lh, la, cap);
  const oneXtwo = [
    { market: '1X2', label: '1', prob: pH },
    { market: '1X2', label: 'X', prob: pD },
    { market: '1X2', label: '2', prob: pA },
  ];

  // Totals (Over/Under 2.5) using total lambda
  const lt = lh + la;
  const pUnder25 = poisCdf(lt, 2);
  const pOver25 = 1 - pUnder25;

  const totals = [
    { market: 'Over/Under 2.5', label: 'Over 2.5', prob: pOver25 },
    { market: 'Over/Under 2.5', label: 'Under 2.5', prob: pUnder25 }
  ];

  // BTTS
  const pH0 = Math.exp(-lh);
  const pA0 = Math.exp(-la);
  const pBTTSno = pH0 + pA0 - pH0*pA0;
  const pBTTSyes = 1 - pBTTSno;
  const btts = [
    { market: 'BTTS', label: 'Yes', prob: pBTTSyes },
    { market: 'BTTS', label: 'No',  prob: pBTTSno  },
  ];

  // Home Over 1.5
  const pHomeOver15 = 1 - poisCdf(lh, 1);
  const home15 = [{ market: 'Home over 1.5', label: 'Home Over 1.5', prob: pHomeOver15 }];

  // Choose
  const GOALS_PREF = 0.62; // prefer goals bet if >= 62%
  const all = [...oneXtwo, ...totals, ...btts, ...home15];
  const best = all.reduce((a,b)=> (b.prob>a.prob?b:a));

  // If a goals market is confident enough, prefer it over 1X2
  const bestGoals = [...totals, ...btts, ...home15].reduce((a,b)=> (b.prob>a.prob?b:a));
  const best1x2 = oneXtwo.reduce((a,b)=> (b.prob>a.prob?b:a));
  if (bestGoals.prob >= GOALS_PREF && bestGoals.prob >= best1x2.prob - 0.03) {
    return bestGoals;
  }
  return best;
}

// ---- fetch fixtures
async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function getTodayFixturesFiltered() {
  const date = todayYMD();
  if (!API_KEY) return { date, rows: [], reason: 'missing_api_key' };

  const now = new Date();
  const startUtc = now.toISOString().split('T')[0];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const endUtc = end.toISOString().split('T')[0];
  const url = `https://api.football-data.org/v4/matches?dateFrom=${startUtc}&dateTo=${endUtc}&status=SCHEDULED,IN_PLAY,PAUSED,FINISHED`;
  const headers = { 'X-Auth-Token': API_KEY, 'accept': 'application/json' };

  const json = await fetchJson(url, headers);
  const arr = Array.isArray(json?.matches) ? json.matches : [];

  let rows = arr.map(f => {
    const league = `${f.competition?.area?.name || ''} ${f.competition?.name || ''}`.trim();
    const home = f.homeTeam?.name || '';
    const away = f.awayTeam?.name || '';
    const pick = bestMarket(home, away, league);
    return {
      league,
      kickoffIso: f.utcDate,
      kickoff: toLocalLabel(f.utcDate),
      hourLocal: localParts(f.utcDate).hh,
      home, away,
      prediction: `${pick.market}: ${pick.label} (${Math.round(pick.prob*100)}%)`
    };
  }).filter(r => r.hourLocal >= START_HOUR && r.hourLocal < END_HOUR)
    .sort((a,b) => (a.kickoff || '').localeCompare(b.kickoff || ''));

  if (!rows.length && FALLBACK_DEMO) {
    const d = `${date} 19:00`;
    const p = bestMarket('Alpha FC','Beta United','Demo League');
    rows = [{ league:'Demo League', kickoff:d, home:'Alpha FC', away:'Beta United', prediction:`${p.market}: ${p.label} (${Math.round(p.prob*100)}%)` }];
  }
  return { date, rows, totalFromApi: arr.length, apiUrl: url };
}

// ---- cache & schedule
let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  try {
    const res = await getTodayFixturesFiltered();
    CACHE = { ...res, savedAt: new Date().toISOString() };
  } catch (e) {
    CACHE = { date: todayYMD(), rows: [], savedAt: new Date().toISOString(), error: String(e.message || e) };
  }
}
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

// ---- routes
app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});

app.get('/diag', async (_req, res) => {
  const fresh = await getTodayFixturesFiltered();
  res.json({
    tz: TZ, startHour: START_HOUR, url: fresh.apiUrl,
    totalFromApi: fresh.totalFromApi, cacheRows: CACHE.rows?.length || 0,
    cacheDate: CACHE.date, savedAt: CACHE.savedAt
  });
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Today's Matches — AI Picks v2</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>thead.sticky th{position:sticky;top:0;z-index:10} th,td{vertical-align:middle}</style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-6xl mx-auto p-4 space-y-3">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Matches Today (11:00–24:00 TRT) — AI Picks v2</h1>
      <a href="/diag" class="text-xs underline opacity-70 hover:opacity-100">Diagnostics</a>
    </header>
    <div class="overflow-x-auto bg-white rounded-2xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-slate-100 sticky"><tr>
          <th class="text-left p-3">Kickoff</th>
          <th class="text-left p-3">League</th>
          <th class="text-left p-3">Home</th>
          <th class="text-left p-3">Away</th>
          <th class="text-left p-3">Prediction</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p class="text-[12px] text-slate-500">Predictions are heuristic and for entertainment only. Use at your own risk.</p>
  </div>
  <script>
    async function load(){
      const res = await fetch("/api/today");
      const data = await res.json();
      const rows = data.rows || [];
      document.getElementById("rows").innerHTML = rows.map(r => (
        "<tr class='border-b last:border-0'>" +
          "<td class='p-3 whitespace-nowrap'>" + (r.kickoff||"") + "</td>" +
          "<td class='p-3'>" + (r.league||"") + "</td>" +
          "<td class='p-3 font-medium'>" + (r.home||"") + "</td>" +
          "<td class='p-3'>" + (r.away||"") + "</td>" +
          "<td class='p-3'>" + (r.prediction||"") + "</td>" +
        "</tr>"
      )).join("");
    }
    load();
    setInterval(load, 5*60*1000);
  </script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.listen(PORT, HOST, () => {
  console.log(`✅ Server listening on ${HOST}:${PORT}`);
  warmCache();
});
