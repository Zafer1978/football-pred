// server.js
// Next-day predictions only. No date/search/CSV. Subscribe + AdSense placeholders.
// Real data via API_FOOTBALL_KEY or PREDICTIONS_FEED. Fallback to demo rows.

import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Istanbul';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Utils ----
function ymd(date, tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(date); // YYYY-MM-DD
}
function nextDayYMD(tz = TZ) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24*60*60*1000);
  return ymd(tomorrow, tz);
}
function toLocalISO(utcISOString, tz = TZ) {
  try {
    const dt = new Date(utcISOString);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(dt);
    const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const [d,m,y] = [o.day,o.month,o.year];
    return `${y}-${m}-${d} ${o.hour}:${o.minute}`;
  } catch { return utcISOString; }
}

// ---- Sources (optional) ----
async function sourceApiFootball(dateYMD) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return [];

  const base = 'https://v3.football.api-sports.io';
  // Try both header styles (direct API-Sports and RapidAPI):
  const headersList = [
    { 'x-apisports-key': apiKey },
    { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'v3.football.api-sports.io' }
  ];

  for (const headers of headersList) {
    try {
      const fxRes = await fetch(`${base}/fixtures?date=${dateYMD}`, { headers });
      if (!fxRes.ok) continue;
      const fxJson = await fxRes.json();
      const fixtures = fxJson?.response || [];

      const out = [];
      for (const f of fixtures) {
        const fixtureId = f.fixture?.id;
        const league = `${f.league?.country || ''} ${f.league?.name || ''}`.trim();
        const kickoff = toLocalISO(f.fixture?.date);
        const home = f.teams?.home?.name || 'Home';
        const away = f.teams?.away?.name || 'Away';

        let prediction = 'N/A', confidence;
        if (fixtureId) {
          try {
            const pRes = await fetch(`${base}/predictions?fixture=${fixtureId}`, { headers });
            if (pRes.ok) {
              const pJson = await pRes.json();
              const pred = pJson?.response?.[0];
              if (pred?.predictions?.winner?.name) {
                const w = pred.predictions.winner.name;
                if (/home/i.test(w)) prediction = '1';
                else if (/away/i.test(w)) prediction = '2';
                else if (/draw/i.test(w)) prediction = 'X';
                else prediction = w;
              }
              if (pred?.predictions?.percent) {
                const { home: ph, draw: pd, away: pa } = pred.predictions.percent;
                const nums = [ph, pd, pa].map(x => parseFloat(String(x).replace('%','')) || 0);
                const max = Math.max(...nums);
                confidence = `${max}%`;
              }
            }
          } catch {}
        }
        out.push({ league, kickoff, home, away, prediction, confidence, source: 'API-Football' });
      }
      return out;
    } catch {}
  }
  return [];
}

async function sourceCustomJson(dateYMD) {
  const url = process.env.PREDICTIONS_FEED; // e.g. https://yourdomain.com/predictions/YYYY-MM-DD.json
  if (!url) return [];
  try {
    const res = await fetch(url.replace('YYYY-MM-DD', dateYMD));
    if (!res.ok) throw new Error('feed not ok');
    const arr = await res.json();
    return (Array.isArray(arr) ? arr : []).map(x => ({
      league: x.league || '',
      kickoff: x.kickoff || '',
      home: x.home || '',
      away: x.away || '',
      prediction: x.prediction || 'N/A',
      confidence: x.confidence || undefined,
      source: x.source || 'Custom feed'
    }));
  } catch { return []; }
}

async function sourceDemo(dateYMD) {
  return [
    { league: 'Demo League', kickoff: `${dateYMD} 19:00`, home: 'Alpha FC', away: 'Beta United', prediction: '1', confidence: '58%', source: 'Demo' },
    { league: 'Demo League', kickoff: `${dateYMD} 21:30`, home: 'Gamma City', away: 'Delta Town', prediction: 'X', confidence: '41%', source: 'Demo' }
  ];
}

async function getNextDayPredictions() {
  const d = nextDayYMD();
  const fromApi = await sourceApiFootball(d);
  const fromFeed = await sourceCustomJson(d);
  let rows = [...fromApi, ...fromFeed];
  if (!rows.length) rows = await sourceDemo(d);
  rows.sort((a,b) => (a.kickoff||'').localeCompare(b.kickoff||'') || (a.league||'').localeCompare(b.league||'') || (a.home||'').localeCompare(b.home||''));
  return { date: d, rows };
}

// ---- API ----
app.get('/api/nextday', async (_req, res) => {
  const data = await getNextDayPredictions();
  res.json(data);
});

// ---- Frontend (no date/search/CSV) ----
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Predictions for <span id="dateLabel">tomorrow</span></title>
  <meta name="description" content="Broadcast of next-day football match predictions." />
  <script src="https://cdn.tailwindcss.com"></script>

  <!-- Google AdSense (paste real code when approved) -->
  <!--
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=YOUR-ADSENSE-CLIENT" crossorigin="anonymous"></script>
  -->

  <style> thead.sticky th{ position: sticky; top:0; z-index: 10; box-shadow: 0 1px 0 rgba(0,0,0,.05); } </style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-7xl mx-auto p-4">

    <header class="mb-6 flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight">Predictions for <span id="dateLabel2">tomorrow</span></h1>
        <p class="text-sm text-slate-600">Informational only.</p>
      </div>
      <a href="#subscribe" class="rounded-xl px-3 py-2 text-sm border hover:bg-slate-100">Subscribe</a>
    </header>

    <!-- Top ad slot -->
    <div class="mb-4 bg-white rounded-2xl shadow p-4 min-h-24 flex items-center justify-center text-slate-500">
      <!-- AdSense: paste your <ins class="adsbygoogle"> block here with push() -->
      <span class="text-xs uppercase tracking-wide">Ad Space (Responsive)</span>
    </div>

    <div class="overflow-x-auto bg-white rounded-2xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-slate-100 sticky"><tr>
          <th class="text-left p-3">Kickoff</th>
          <th class="text-left p-3">League</th>
          <th class="text-left p-3">Home</th>
          <th class="text-left p-3">Away</th>
          <th class="text-left p-3">Pick (1/X/2)</th>
          <th class="text-left p-3">Confidence</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <!-- Inline ad slot -->
    <div class="mt-4 bg-white rounded-2xl shadow p-4 min-h-24 flex items-center justify-center text-slate-500">
      <!-- AdSense block can go here -->
      <span class="text-xs uppercase tracking-wide">Ad Space</span>
    </div>

    <section id="subscribe" class="mt-6 bg-sky-600 text-white rounded-2xl shadow p-6">
      <h2 class="text-xl font-semibold mb-2">Get daily predictions by email</h2>
      <form id="subForm" class="flex flex-col sm:flex-row gap-3" method="post" action="/subscribe">
        <input type="email" name="email" required placeholder="you@example.com" class="flex-1 rounded-xl px-4 py-2 text-slate-900" />
        <input type="text" name="company" class="hidden" tabindex="-1" autocomplete="off" />
        <button class="rounded-xl px-4 py-2 bg-white text-blue-700 font-semibold hover:bg-slate-100" type="submit">Subscribe</button>
      </form>
      <p id="subMsg" class="mt-2 text-sm"></p>
    </section>

    <footer class="mt-8 text-xs text-slate-500 text-center"><p>Respect providers’ terms.</p></footer>
  </div>

  <script>
    const rowsEl = document.getElementById('rows');
    const subForm = document.getElementById('subForm');
    const subMsg = document.getElementById('subMsg');

    async function load() {
      const res = await fetch('/api/nextday');
      const data = await res.json();
      const rows = data.rows || [];

      // set headings to real YYYY-MM-DD
      const d = data.date || 'tomorrow';
      const d1 = document.getElementById('dateLabel');
      const d2 = document.getElementById('dateLabel2');
      if (d1) d1.textContent = d;
      if (d2) d2.textContent = d;

      rowsEl.innerHTML = rows.map(r => \`
        <tr class="border-b last:border-0">
          <td class="p-3 whitespace-nowrap">\${r.kickoff||''}</td>
          <td class="p-3">\${r.league||''}</td>
          <td class="p-3 font-medium">\${r.home||''}</td>
          <td class="p-3">\${r.away||''}</td>
          <td class="p-3">\${r.prediction||''}</td>
          <td class="p-3">\${r.confidence||''}</td>
        </tr>\`
      ).join('');
    }
    load();
    // optional 5-minute refresh:
    setInterval(load, 5 * 60 * 1000);

    subForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(subForm);
      const resp = await fetch('/subscribe', { method: 'POST', body: fd });
      try { const r = await resp.json(); subMsg.textContent = r.message || 'Subscribed!'; }
      catch { subMsg.textContent = 'Subscribed!'; }
    });
  </script>
</body>
</html>`;

// ---- Routes ----
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.post('/subscribe', (req, res) => {
  if (req.body && req.body.company) return res.json({ ok: true, message: 'Thanks!' }); // honeypot
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok:false, message:'Invalid email' });
  try {
    const file = path.join(DATA_DIR, 'subscribers.csv');
    if (!fs.existsSync(file)) fs.writeFileSync(file, 'email,ts\n');
    fs.appendFileSync(file, `${email},${new Date().toISOString()}\n`);
  } catch (e) {
    return res.status(500).json({ ok:false, message:'Could not save subscription' });
  }
  res.json({ ok:true, message:'Check your inbox to confirm (simulated).' });
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on ${PORT}`);
});
