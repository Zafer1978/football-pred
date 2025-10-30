// server.js — fixed HTML title apostrophe issue
import express from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Istanbul';
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function todayYMD(tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

app.get('/api/today', (req, res) => {
  const d = todayYMD();
  res.json({ date: d, rows: [{ league: 'Premier League', kickoff: '19:00', home: 'Arsenal', away: 'Chelsea', prediction: '1', confidence: '68%' }] });
});

const INDEX_HTML =
  '<!doctype html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '  <meta charset="utf-8" />\n' +
  '  <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
  '  <title>Today&#39;s Football Predictions</title>\n' +
  '  <script src="https://cdn.tailwindcss.com"></script>\n' +
  '</head>\n' +
  '<body class="bg-slate-50 text-slate-900">\n' +
  '  <div class="max-w-7xl mx-auto p-4">\n' +
  '    <h1 class="text-3xl font-bold">Today&#39;s Football Predictions</h1>\n' +
  '    <table class="min-w-full text-sm mt-4"><thead><tr><th>Kickoff</th><th>League</th><th>Home</th><th>Away</th><th>Prediction</th><th>Confidence</th></tr></thead><tbody id="rows"></tbody></table>\n' +
  '    <script>\n' +
  '    async function load(){\n' +
  '      const res=await fetch("/api/today");\n' +
  '      const data=await res.json();\n' +
  '      document.getElementById("rows").innerHTML=data.rows.map(r=>`<tr><td>${r.kickoff}</td><td>${r.league}</td><td>${r.home}</td><td>${r.away}</td><td>${r.prediction}</td><td>${r.confidence}</td></tr>`).join("");\n' +
  '    }\n' +
  '    load();\n' +
  '    </script>\n' +
  '  </div>\n' +
  '</body>\n' +
  '</html>';

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(INDEX_HTML);
});

app.listen(PORT, () => console.log('✅ Server running on', PORT));
