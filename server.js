// server.js
// Enhanced UI layout: side ad slots, responsive grid, subscribe form, theme toggle.
// Includes a simple /subscribe endpoint that stores emails in data/subscribers.csv
// NOTE: Replace ad placeholders with your AdSense code after your domain is approved.

import express from 'express';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Istanbul';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// parse forms for /subscribe
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Utils ----
function todayYMD(tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // YYYY-MM-DD
}

// Dummy predictions (replace with your sources or API)
function getPredictions() {
  const date = todayYMD();
  return [
    { league: 'Premier League', kickoff: `${date} 17:00`, home: 'Arsenal', away: 'Chelsea', prediction: '1', confidence: '68%' },
    { league: 'La Liga', kickoff: `${date} 19:30`, home: 'Barcelona', away: 'Sevilla', prediction: '1', confidence: '74%' },
    { league: 'Serie A', kickoff: `${date} 21:45`, home: 'Inter', away: 'Juventus', prediction: 'X', confidence: '45%' }
  ];
}

// ---- API ----
app.get('/api/today', (req, res) => {
  res.json({ date: todayYMD(), rows: getPredictions() });
});

// ---- Frontend ----
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily Football Predictions</title>
  <meta name="description" content="Today’s football match predictions with kickoff times, leagues, and confidence scores." />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Ccircle cx='128' cy='128' r='120' fill='%230ea5e9'/%3E%3Cpath d='M128 56l22 18-8 26h-28l-8-26 22-18zm-48 28 22 12-4 26-24 10-18-18 24-30zm96 0 24 30-18 18-24-10-4-26 22-12zM80 172l18-18 26 4 10 24-18 18-36-28zm96 0-36 28-18-18 10-24 26-4 18 18z' fill='white'/%3E%3C/svg%3E" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    (function(){
      const ls = localStorage.getItem('theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const dark = ls ? ls === 'dark' : prefersDark;
      if (dark) document.documentElement.classList.add('dark');
    })();
  </script>
  <style>
    thead.sticky th{ position: sticky; top:0; z-index: 10; box-shadow: 0 1px 0 rgba(0,0,0,.05); }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 dark:bg-slate-900 dark:text-slate-100">
  <div class="max-w-7xl mx-auto p-4">

    <header class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight">Daily Football Predictions</h1>
        <p class="text-sm text-slate-600 dark:text-slate-400">Informational only — do your own research.</p>
      </div>
      <div class="flex items-center gap-2">
        <a href="#subscribe" class="rounded-xl px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">Subscribe</a>
        <button id="themeBtn" class="rounded-xl px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800">Toggle Theme</button>
      </div>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- Left ad column -->
      <aside class="lg:col-span-2 space-y-4">
        <div class="bg-white dark:bg-slate-800 rounded-2xl shadow p-4 min-h-40 flex items-center justify-center text-slate-500 dark:text-slate-400">
          <div class="text-center">
            <div class="text-xs uppercase tracking-wide">Ad Space</div>
            <div class="text-[11px]">300×250 / 160×600</div>
          </div>
        </div>
        <div class="bg-white dark:bg-slate-800 rounded-2xl shadow p-4 min-h-40 flex items-center justify-center text-slate-500 dark:text-slate-400">
          <div class="text-center">
            <div class="text-xs uppercase tracking-wide">Ad Space</</div>
            <div class="text-[11px]">Square/Card</div>
          </div>
        </div>
      </aside>

      <!-- Main column -->
      <main class="lg:col-span-8">
        <section class="mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label class="block text-sm font-medium">Date</label>
            <input id="date" type="date" class="mt-1 w-full border rounded-xl px-3 py-2 bg-white dark:bg-slate-800 dark:border-slate-700" />
          </div>
          <div class="md:col-span-2">
            <label class="block text-sm font-medium">Search</label>
            <input id="q" placeholder="Team, league, 1/X/2..." class="mt-1 w-full border rounded-xl px-3 py-2 bg-white dark:bg-slate-800 dark:border-slate-700" />
          </div>
          <div class="flex items-end justify-start gap-2">
            <button id="exportCsv" class="inline-flex items-center border rounded-xl px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 border-slate-300 dark:border-slate-700">Export CSV</button>
            <select id="filterPick" class="border rounded-xl px-3 py-2 bg-white dark:bg-slate-800 dark:border-slate-700">
              <option value="">All Picks</option>
              <option value="1">Home Win (1)</option>
              <option value="X">Draw (X)</option>
              <option value="2">Away Win (2)</option>
            </select>
          </div>
        </section>

        <div class="overflow-x-auto bg-white dark:bg-slate-800 rounded-2xl shadow">
          <table class="min-w-full text-sm" id="tbl">
            <thead class="bg-slate-100 dark:bg-slate-700 sticky">
              <tr>
                <th class="text-left p-3">Kickoff</th>
                <th class="text-left p-3">League</th>
                <th class="text-left p-3">Home</th>
                <th class="text-left p-3">Away</th>
                <th class="text-left p-3">Prediction</th>
                <th class="text-left p-3">Confidence</th>
              </tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
        </div>

        <div class="mt-4 bg-white dark:bg-slate-800 rounded-2xl shadow p-4 min-h-32 flex items-center justify-center text-slate-500 dark:text-slate-400">
          <div class="text-center">
            <div class="text-xs uppercase tracking-wide">Ad Space (Responsive)</div>
            <div class="text-[11px]">728×90 / 468×60</div>
          </div>
        </div>

        <section id="subscribe" class="mt-6">
          <div class="bg-gradient-to-br from-sky-500 to-blue-600 text-white rounded-2xl shadow p-6">
            <h2 class="text-xl font-semibold mb-1">Get daily predictions in your inbox</h2>
            <p class="text-sm opacity-90 mb-4">Free, 1 email per day. Unsubscribe anytime.</p>
            <form id="subForm" class="flex flex-col sm:flex-row gap-3" method="post" action="/subscribe">
              <input type="email" name="email" required placeholder="you@example.com" class="flex-1 rounded-xl px-4 py-2 text-slate-900" />
              <input type="text" name="company" class="hidden" tabindex="-1" autocomplete="off" />
              <button class="rounded-xl px-4 py-2 bg-white text-blue-700 font-semibold hover:bg-slate-100" type="submit">Subscribe</button>
            </form>
            <p id="subMsg" class="mt-2 text-sm"></p>
          </div>
        </section>
      </main>

      <!-- Right column -->
      <aside class="lg:col-span-2 space-y-4">
        <div class="bg-white dark:bg-slate-800 rounded-2xl shadow p-4">
          <h3 class="font-semibold mb-2">Today’s Tips</h3>
          <ul id="tips" class="text-sm space-y-1 text-slate-600 dark:text-slate-300">
            <li>Use filters to find 1/X/2 quickly.</li>
            <li>Export CSV for your own tracking.</li>
            <li>Times shown in your selected timezone.</li>
          </ul>
        </div>
        <div class="bg-white dark:bg-slate-800 rounded-2xl shadow p-4 min-h-40 flex items-center justify-center text-slate-500 dark:text-slate-400">
          <div class="text-center">
            <div class="text-xs uppercase tracking-wide">Ad Space</div>
            <div class="text-[11px]">300×250</div>
          </div>
        </div>
      </aside>
    </div>

    <footer class="mt-8 text-xs text-slate-500 dark:text-slate-400 text-center">
      <p>Respect providers’ terms. Consider attribution even if optional.</p>
    </footer>
  </div>

  <script>
    const rowsEl = document.getElementById('rows');
    const dateEl = document.getElementById('date');
    const qEl = document.getElementById('q');
    const pickEl = document.getElementById('filterPick');
    const exportBtn = document.getElementById('exportCsv');
    const themeBtn = document.getElementById('themeBtn');
    const subForm = document.getElementById('subForm');
    const subMsg = document.getElementById('subMsg');

    themeBtn.addEventListener('click', () => {
      const html = document.documentElement;
      const dark = html.classList.toggle('dark');
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    });

    const today = new Date().toISOString().slice(0,10);
    dateEl.value = today;

    let allRows = [];

    async function load() {
      const d = dateEl.value || today;
      const res = await fetch('/api/today?date=' + d);
      const json = await res.json();
      allRows = json.rows || [];
      render();
    }

    function norm(s) { return (s||'').toString().toLowerCase(); }

    function confidenceBar(valStr){
      const v = parseFloat(String(valStr||'').replace('%','')) || 0;
      return "<div class='w-28 h-2 rounded bg-slate-200 dark:bg-slate-600'><div class='h-2 rounded bg-sky-500' style='width:" + Math.min(100,Math.max(0,v)) + "%'></div></div><span class='ml-2 text-xs text-slate-500 dark:text-slate-400'>" + (valStr||'') + "</span>";
    }

    function pickPill(p){
      const map = { '1':'bg-emerald-600', 'X':'bg-amber-600', '2':'bg-rose-600' };
      const cls = map[p] || 'bg-slate-500';
      return "<span class='inline-flex items-center justify-center min-w-8 px-2 py-1 text-xs font-semibold text-white rounded-full " + cls + "'>" + (p||'') + "</span>";
    }

    function render(){
      const q = norm(qEl.value);
      const pf = (pickEl.value||'').toUpperCase();
      const filtered = allRows.filter(r => {
        if (pf && String(r.prediction||'').toUpperCase() !== pf) return false;
        const hay = [r.league, r.kickoff, r.home, r.away, r.prediction, r.confidence].map(norm).join(' ');
        return hay.includes(q);
      });

      rowsEl.innerHTML = filtered.map(r => (
        "<tr class='border-b last:border-0 border-slate-100 dark:border-slate-700'>" +
          "<td class='p-3 whitespace-nowrap'>" + (r.kickoff || '') + "</td>" +
          "<td class='p-3'><span class='inline-block px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 text-xs'>" + (r.league || '') + "</span></td>" +
          "<td class='p-3 font-medium'>" + (r.home || '') + "</td>" +
          "<td class='p-3'>" + (r.away || '') + "</td>" +
          "<td class='p-3'>" + pickPill(r.prediction) + "</td>" +
          "<td class='p-3'><div class='flex items-center'>" + confidenceBar(r.confidence) + "</div></td>" +
        "</tr>"
      )).join('');
    }

    function toCsv(data) {
      const headers = ['kickoff','league','home','away','prediction','confidence'];
      const lines = [headers.join(',')];
      for (const r of data) {
        const row = headers.map(h => '"' + ((r[h]||'').toString().replaceAll('"','""')) + '"').join(',');
        lines.push(row);
      }
      return lines.join('\n');
    }

    exportBtn.addEventListener('click', async () => {
      const d = dateEl.value || today;
      const res = await fetch('/api/today?date=' + d);
      const json = await res.json();
      const csv = toCsv(json.rows || []);
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = "predictions-" + d + ".csv";
      a.click();
    });

    dateEl.addEventListener('change', load);
    qEl.addEventListener('input', render);
    pickEl.addEventListener('change', render);
    load();

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

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

// ---- Subscribe endpoint ----
app.post('/subscribe', (req, res) => {
  if (req.body && req.body.company) return res.json({ ok: true, message: 'Thanks!' });
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
  console.log(`Server running on http://localhost:${PORT}`);
});
