// server.js — Football-Data.org with dateFrom/dateTo, Render-ready
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

function fmtYMD(d, tz = TZ) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}
function todayYMD(tz = TZ) { return fmtYMD(new Date(), tz); }

function localParts(iso, tz = TZ) {
  const dt = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(dt);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute };
}
function toLocalLabel(iso, tz = TZ) {
  const { y, m, d, hh, mm } = localParts(iso, tz);
  const pad = n => String(n).padStart(2, '0');
  return `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}`;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function getTodayFixturesFiltered() {
  const date = todayYMD();
  if (!API_KEY) return { date, rows: [], reason: 'missing_api_key' };

  // dateFrom/dateTo for today's UTC window
  const now = new Date();
  const startUtc = now.toISOString().split('T')[0];
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const endUtc = end.toISOString().split('T')[0];
  const url = `https://api.football-data.org/v4/matches?dateFrom=${startUtc}&dateTo=${endUtc}&status=SCHEDULED,IN_PLAY,PAUSED,FINISHED`;
  const headers = { 'X-Auth-Token': API_KEY, 'accept': 'application/json' };

  const json = await fetchJson(url, headers);
  const arr = Array.isArray(json?.matches) ? json.matches : [];

  let rows = arr.map(f => ({
    league: `${f.competition?.area?.name || ''} ${f.competition?.name || ''}`.trim(),
    kickoffIso: f.utcDate,
    kickoff: toLocalLabel(f.utcDate),
    hourLocal: localParts(f.utcDate).hh,
    home: f.homeTeam?.name || '',
    away: f.awayTeam?.name || '',
  })).filter(r => r.hourLocal >= START_HOUR && r.hourLocal < END_HOUR)
    .sort((a,b) => (a.kickoff || '').localeCompare(b.kickoff || ''));

  if (!rows.length && FALLBACK_DEMO) {
    rows = [
      { league: 'Demo League', kickoff: `${date} 15:00`, home: 'Alpha FC', away: 'Beta United' },
      { league: 'Demo League', kickoff: `${date} 18:30`, home: 'Gamma City', away: 'Delta Town' }
    ];
  }
  return { date, rows, totalFromApi: arr.length, apiUrl: url };
}

// In-memory cache
let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  try {
    const res = await getTodayFixturesFiltered();
    CACHE = { ...res, savedAt: new Date().toISOString() };
  } catch (e) {
    CACHE = { date: todayYMD(), rows: [], savedAt: new Date().toISOString(), error: String(e.message || e) };
  }
}

// Schedule nightly refresh 00:01
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});

app.get('/diag', async (_req, res) => {
  try {
    const { apiUrl } = await getTodayFixturesFiltered();
    res.json({ tz: TZ, startHour: START_HOUR, url: apiUrl, cacheRows: CACHE.rows?.length || 0, cacheDate: CACHE.date, savedAt: CACHE.savedAt });
  } catch (e) {
    res.json({ error: String(e.message || e) });
  }
});

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Today's Matches (Football-Data.org)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>thead.sticky th{position:sticky;top:0;z-index:10} th,td{vertical-align:middle}</style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-6xl mx-auto p-4 space-y-3">
    <header class="flex items-center justify-between">
      <h1 class="text-2xl font-bold">Matches Today (11:00–24:00 TRT)</h1>
      <a href="/diag" class="text-xs underline opacity-70 hover:opacity-100">Diagnostics</a>
    </header>
    <div class="overflow-x-auto bg-white rounded-2xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-slate-100 sticky"><tr>
          <th class="text-left p-3">Kickoff</th>
          <th class="text-left p-3">League</th>
          <th class="text-left p-3">Home</th>
          <th class="text-left p-3">Away</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
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
