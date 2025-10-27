// server.js
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

app.get('/healthz', (_, res) => res.json({ ok: true }));

function todayYMD() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}
function demoPredictions() {
  const d = todayYMD();
  return [
    { league: 'Premier League', kickoff: `${d} 17:00`, home: 'Arsenal', away: 'Chelsea', prediction: '1', confidence: '68%' },
    { league: 'La Liga', kickoff: `${d} 19:30`, home: 'Barcelona', away: 'Sevilla', prediction: '1', confidence: '74%' },
    { league: 'Serie A', kickoff: `${d} 21:45`, home: 'Inter', away: 'Juventus', prediction: 'X', confidence: '45%' }
  ];
}
app.get('/api/today', (_, res) => res.json({ date: todayYMD(), rows: demoPredictions() }));

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily Football Predictions</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style> thead.sticky th{ position: sticky; top:0; z-index: 10; box-shadow: 0 1px 0 rgba(0,0,0,.05); } </style>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-7xl mx-auto p-4">
    <header class="mb-6 flex items-center justify-between">
      <h1 class="text-3xl font-extrabold tracking-tight">Daily Football Predictions</h1>
      <a href="#subscribe" class="rounded-xl px-3 py-2 text-sm border hover:bg-slate-100">Subscribe</a>
    </header>

    <section class="mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
      <div><label class="block text-sm font-medium">Date</label><input id="date" type="date" class="mt-1 w-full border rounded-xl px-3 py-2" /></div>
      <div class="md:col-span-2"><label class="block text-sm font-medium">Search</label><input id="q" placeholder="Team, league, 1/X/2..." class="mt-1 w-full border rounded-xl px-3 py-2" /></div>
      <div class="flex items-end gap-2"><button id="exportCsv" class="border rounded-xl px-3 py-2">Export CSV</button><select id="filterPick" class="border rounded-xl px-3 py-2"><option value="">All Picks</option><option value="1">Home Win (1)</option><option value="X">Draw (X)</option><option value="2">Away Win (2)</option></select></div>
    </section>

    <div class="overflow-x-auto bg-white rounded-2xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-slate-100 sticky"><tr><th class="text-left p-3">Kickoff</th><th class="text-left p-3">League</th><th class="text-left p-3">Home</th><th class="text-left p-3">Away</th><th class="text-left p-3">Prediction</th><th class="text-left p-3">Confidence</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>

    <section id="subscribe" class="mt-6 bg-sky-600 text-white rounded-2xl shadow p-6">
      <h2 class="text-xl font-semibold mb-2">Get daily predictions in your inbox</h2>
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
    const dateEl = document.getElementById('date');
    const qEl = document.getElementById('q');
    const pickEl = document.getElementById('filterPick');
    const exportBtn = document.getElementById('exportCsv');
    const subForm = document.getElementById('subForm');
    const subMsg = document.getElementById('subMsg');

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
    function norm(s){ return (s||'').toString().toLowerCase(); }
    function render(){
      const q = norm(qEl.value);
      const pf = (pickEl.value||'').toUpperCase();
      const filtered = allRows.filter(r => {
        if (pf && String(r.prediction||'').toUpperCase() !== pf) return false;
        const hay = [r.league, r.kickoff, r.home, r.away, r.prediction, r.confidence].map(norm).join(' ');
        return hay.includes(q);
      });
      rowsEl.innerHTML = filtered.map(r => \`<tr class="border-b last:border-0"><td class="p-3 whitespace-nowrap">\${r.kickoff||''}</td><td class="p-3">\${r.league||''}</td><td class="p-3 font-medium">\${r.home||''}</td><td class="p-3">\${r.away||''}</td><td class="p-3">\${r.prediction||''}</td><td class="p-3">\${r.confidence||''}</td></tr>\`).join('');
    }
    function toCsv(data){ const headers=['kickoff','league','home','away','prediction','confidence']; const lines=[headers.join(',')]; for(const r of data){ const row=headers.map(h=>'"'+((r[h]||'').toString().replaceAll('"','""'))+'"').join(','); lines.push(row);} return lines.join('\n'); }
    exportBtn.addEventListener('click', async () => { const d=dateEl.value||today; const res=await fetch('/api/today?date='+d); const json=await res.json(); const csv=toCsv(json.rows||[]); const blob=new Blob([csv], {type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=\`predictions-\${d}.csv\`; a.click(); });
    dateEl.addEventListener('change', load);
    qEl.addEventListener('input', render);
    pickEl.addEventListener('change', render);
    subForm.addEventListener('submit', async (e)=>{ e.preventDefault(); const fd=new FormData(subForm); const resp=await fetch('/subscribe',{method:'POST',body:fd}); try{ const r=await resp.json(); subMsg.textContent=r.message||'Subscribed!'; }catch{ subMsg.textContent='Subscribed!'; } });
    load();
  </script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

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
  console.log(`✅ Server listening on ${PORT}`);
});
