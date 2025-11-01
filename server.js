// server.js — Show only matches between 11:00–24:00 (GMT+3 / Europe/Istanbul) and refresh cache at midnight (fixed title apostrophe)
import express from 'express';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Istanbul';
const API_KEY = process.env.API_FOOTBALL_KEY || '';
const START_HOUR = parseInt(process.env.START_HOUR || '11', 10);
const END_HOUR = 24;

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
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status; err.body = txt; throw err;
  }
  try { return JSON.parse(txt); } catch { return { raw: txt }; }
}

async function getTodayFixturesFiltered() {
  const date = todayYMD();
  if (!API_KEY) return { date, rows: [], reason: 'missing_api_key' };

  const base = 'https://v3.football.api-sports.io/fixtures';
  const url = `${base}?date=${date}&timezone=${encodeURIComponent(TZ)}`;
  const headers = { 'x-apisports-key': API_KEY, 'accept': 'application/json' };

  const json = await fetchJson(url, headers);
  const arr = Array.isArray(json?.response) ? json.response : [];

  const rows = arr.map(f => ({
    league: `${f.league?.country || ''} ${f.league?.name || ''}`.trim(),
    kickoffIso: f.fixture?.date,
    kickoff: toLocalLabel(f.fixture?.date),
    hourLocal: localParts(f.fixture?.date).hh,
    home: f.teams?.home?.name || '',
    away: f.teams?.away?.name || '',
    prediction: '',
    confidence: ''
  })).filter(r => r.hourLocal >= START_HOUR && r.hourLocal < END_HOUR)
    .sort((a,b) => (a.kickoff || '').localeCompare(b.kickoff || ''));

  return { date, rows };
}

let CACHE = { date: null, rows: [], savedAt: null };
async function warmCache() {
  const res = await getTodayFixturesFiltered().catch(e => ({ date: todayYMD(), rows: [], reason: 'fetch_error', error: String(e.message || e), status: e.status, bodyHead: (e.body || '').slice(0,200) }));
  CACHE = { ...res, savedAt: new Date().toISOString() };
  return CACHE;
}
await warmCache();
cron.schedule('1 0 * * *', async () => { await warmCache(); }, { timezone: TZ });

app.get('/api/today', async (_req, res) => {
  const nowDate = todayYMD();
  if (CACHE.date !== nowDate) await warmCache();
  res.json(CACHE);
});

app.get('/diag', async (_req, res) => {
  const date = todayYMD();
  const base = 'https://v3.football.api-sports.io/fixtures';
  const url = `${base}?date=${date}&timezone=${encodeURIComponent(TZ)}`;
  const headers = { 'x-apisports-key': API_KEY || '', 'accept': 'application/json' };
  try {
    const r = await fetch(url, { headers });
    const status = r.status;
    const body = await r.text();
    let count = 0;
    try { const j = JSON.parse(body); count = Array.isArray(j?.response) ? j.response.length : 0; } catch {}
    res.json({ date, tz: TZ, startHour: START_HOUR, url, status, totalFromApi: count, cacheRows: CACHE.rows?.length || 0, cacheDate: CACHE.date, bodyHead: body.slice(0, 300) });
  } catch (e) {
    res.json({ date, tz: TZ, startHour: START_HOUR, url, error: String(e.message || e) });
  }
});

const INDEX_HTML =
'<!doctype html>\n'+
'<html lang="en">\n'+
'<head>\n'+
'  <meta charset="utf-8" />\n'+
'  <meta name="viewport" content="width=device-width, initial-scale=1" />\n'+
'  <title>Today&#39;s Matches (11:00–24:00 TRT)</title>\n'+
'  <script src="https://cdn.tailwindcss.com"></script>\n'+
'  <style>thead.sticky th{position:sticky;top:0;z-index:10} th,td{vertical-align:middle}</style>\n'+
'</head>\n'+
'<body class="bg-slate-50 text-slate-900">\n'+
'  <div class="max-w-6xl mx-auto p-4">\n'+
'    <header class="mb-4 flex items-center justify-between">\n'+
'      <h1 class="text-2xl font-bold">Matches Today (from 11:00 TRT)</h1>\n'+
'      <a href="/diag" class="text-sm underline">Diagnostics</a>\n'+
'    </header>\n'+
'    <div class="overflow-x-auto bg-white rounded-2xl shadow">\n'+
'      <table class="min-w-full text-sm" id="tbl">\n'+
'        <thead class="bg-slate-100 sticky"><tr>\n'+
'          <th class="text-left p-3">Kickoff</th>\n'+
'          <th class="text-left p-3">League</th>\n'+
'          <th class="text-left p-3">Home</th>\n'+
'          <th class="text-left p-3">Away</th>\n'+
'        </tr></thead>\n'+
'        <tbody id="rows"></tbody>\n'+
'      </table>\n'+
'    </div>\n'+
'  </div>\n'+
'  <script>\n'+
'    async function load(){\n'+
'      const res = await fetch("/api/today");\n'+
'      const data = await res.json();\n'+
'      const rows = data.rows || [];\n'+
'      document.getElementById("rows").innerHTML = rows.map(r => (\n'+
'        "<tr class=\\\"border-b last:border-0\\\">"+\n'+
'          "<td class=\\\"p-3 whitespace-nowrap\\\">"+ (r.kickoff||"") +"</td>"+\n'+
'          "<td class=\\\"p-3\\\">"+ (r.league||"") +"</td>"+\n'+
'          "<td class=\\\"p-3 font-medium\\\">"+ (r.home||"") +"</td>"+\n'+
'          "<td class=\\\"p-3\\\">"+ (r.away||"") +"</td>"+\n'+
'        "</tr>"\n'+
'      )).join("");\n'+
'    }\n'+
'    load();\n'+
'    setInterval(load, 5*60*1000);\n'+
'  </script>\n'+
'</body>\n'+
'</html>';

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.listen(PORT, () => console.log('✅ Server listening on', PORT));
