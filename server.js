// server.js — Football-Data.org fixtures + local AI (1/X/2) predictions
// Render-ready: binds 0.0.0.0:$PORT, daily refresh, time-window filter, Tailwind UI.
import express from 'express';
import dotenv from 'dotenv';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const TZ = process.env.TZ || 'Europe/Istanbul';
const API_KEY = process.env.FOOTBALL_DATA_KEY || '';
const START_HOUR = parseInt(process.env.START_HOUR || '11', 10);
const END_HOUR = 24;
const FALLBACK_DEMO = process.env.FALLBACK_DEMO === '1';

// Optional local ratings file (if present). Not required.
const DATA_DIR = path.join(process.cwd(), 'data');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');

// ---------- Time helpers ----------
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

// ---------- Ratings + AI predictor ----------
function normTeam(s = '') { return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

// Built-in seed strengths for popular clubs.
// Teams not listed default to 1500 Elo.
const SEED_ELO = {
  'real madrid':1850,'barcelona':1820,'manchester city':1880,'liverpool':1820,'arsenal':1800,
  'chelsea':1750,'manchester united':1760,'bayern munich':1900,'inter':1820,'juventus':1800,
  'milan':1780,'psg':1850,'atletico madrid':1800,'napoli':1780,'roma':1740,'tottenham':1760,
  'galatasaray':1700,'fenerbahce':1680,'besiktas':1650,'trabzonspor':1620
};

// If ratings.json exists, merge/override seeds.
function loadRatings() {
  const elo = { ...SEED_ELO };
  try {
    if (fs.existsSync(RATINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf-8'));
      const teams = raw?.teams || {};
      for (const [name, obj] of Object.entries(teams)) {
        const key = normTeam(name);
        const val = typeof obj === 'number' ? obj : obj?.elo;
        if (typeof val === 'number') elo[key] = val;
      }
      console.log(`[AI] Loaded ratings from data/ratings.json (${Object.keys(teams).length} teams)`);
    } else {
      console.log('[AI] Using built-in seed ratings');
    }
  } catch (e) {
    console.log('[AI] Failed to load ratings.json, using seeds. Error:', e?.message || e);
  }
  return elo;
}
let RATINGS = loadRatings();

function predict1X2(home, away) {
  const base = 1500, HOME_ADV = 80;
  const rh = RATINGS[normTeam(home)] ?? base;
  const ra = RATINGS[normTeam(away)] ?? base;
  const diff = (rh + HOME_ADV) - ra;
  const pHome = 1/(1+Math.pow(10,-diff/400));
  const pAway = 1 - pHome;
  const pDraw = 0.25 * Math.exp(-Math.abs(diff)/600);
  const sum = pHome + pAway + pDraw;
  const ph = pHome/sum, pa = pAway/sum, pd = pDraw/sum;
  if (pd >= ph && pd >= pa) return 'X';
  if (pa > ph) return '2';
  return '1';
}

// ---------- API fetch ----------
async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function getTodayFixturesFiltered() {
  const date = todayYMD();
  if (!API_KEY) return { date, rows: [], reason: 'missing_api_key' };

  // Query a precise 1-day UTC window to represent "today"
  const now = new Date();
  const startUtc = now.toISOString().split('T')[0];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const endUtc = end.toISOString().split('T')[0];
  const url = `https://api.football-data.org/v4/matches?dateFrom=${startUtc}&dateTo=${endUtc}&status=SCHEDULED,IN_PLAY,PAUSED,FINISHED`;
  const headers = { 'X-Auth-Token': API_KEY, 'accept': 'application/json' };

  const json = await fetchJson(url, headers);
  const arr = Array.isArray(json?.matches) ? json.matches : [];

  let rows = arr.map(f => {
    const home = f.homeTeam?.name || '';
    const away = f.awayTeam?.name || '';
    const prediction = predict1X2(home, away);
    return {
      league: `${f.competition?.area?.name || ''} ${f.competition?.name || ''}`.trim(),
      kickoffIso: f.utcDate,
      kickoff: toLocalLabel(f.utcDate),
      hourLocal: localParts(f.utcDate).hh,
      home, away,
      prediction
    };
  }).filter(r => r.hourLocal >= START_HOUR && r.hourLocal < END_HOUR)
    .sort((a,b) => (a.kickoff || '').localeCompare(b.kickoff || ''));

  if (!rows.length && FALLBACK_DEMO) {
    rows = [
      { league: 'Demo League', kickoff: `${date} 15:00`, home: 'Alpha FC', away: 'Beta United', prediction: '1' },
      { league: 'Demo League', kickoff: `${date} 18:30`, home: 'Gamma City', away: 'Delta Town', prediction: 'X' }
    ];
  }
  return { date, rows, totalFromApi: arr.length, apiUrl: url };
}

// ---------- Cache & schedule ----------
let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  try {
    const res = await getTodayFixturesFiltered();
    CACHE = { ...res, savedAt: new Date().toISOString() };
  } catch (e) {
    CACHE = { date: todayYMD(), rows: [], savedAt: new Date().toISOString(), error: String(e.message || e) };
  }
}
// nightly refresh at 00:01 in Istanbul
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

// ---------- Routes ----------
app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});

app.get('/diag', async (_req, res) => {
  // Fetch fresh once to reveal URL/total in diagnostics (non-cached)
  const fresh = await getTodayFixturesFiltered();
  res.json({
    tz: TZ,
    startHour: START_HOUR,
    url: fresh.apiUrl,
    totalFromApi: fresh.totalFromApi,
    cacheRows: CACHE.rows?.length || 0,
    cacheDate: CACHE.date,
    savedAt: CACHE.savedAt
  });
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Today's Matches — AI Picks</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>thead.sticky th{position:sticky;top:0;z-index:10} th,td{vertical-align:middle}</style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-6xl mx-auto p-4 space-y-3">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Matches Today (11:00–24:00 TRT) — AI Picks</h1>
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
