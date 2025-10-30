// server.js
import express from 'express';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ || 'Europe/Istanbul';
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function todayYMD(tz = TZ) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

// Dummy match data (replace later with API)
function getPredictions() {
  const date = todayYMD();
  return [
    { league: 'Premier League', kickoff: `${date} 17:00`, home: 'Arsenal', away: 'Chelsea', prediction: '1', confidence: '68%' },
    { league: 'La Liga', kickoff: `${date} 19:30`, home: 'Barcelona', away: 'Sevilla', prediction: '1', confidence: '74%' },
    { league: 'Serie A', kickoff: `${date} 21:45`, home: 'Inter', away: 'Juventus', prediction: 'X', confidence: '45%' }
  ];
}

// API route
app.get('/api/today', (req, res) => {
  res.json({ date: todayYMD(), rows: getPredictions() });
});

// Frontend HTML
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily Football Predictions</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 text-gray-900">
  <div class="max-w-5xl mx-auto p-4">
    <header class="mb-6 text-center">
      <h1 class="text-2xl font-bold mb-2">Daily Football Predictions</h1>
      <p class="text-sm text-gray-600">Informational only — no betting advice.</p>
    </header>

    <div class="overflow-x-auto bg-white rounded-xl shadow">
      <table class="min-w-full text-sm" id="tbl">
        <thead class="bg-gray-100">
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

    <footer class="mt-6 text-xs text-gray-500 text-center">
      <p>Built for demo purposes. © 2025</p>
    </footer>
  </div>

  <script>
    async function loadPredictions() {
      const res = await fetch('/api/today');
      const data = await res.json();
      const rows = data.rows || [];
      const tbody = document.getElementById('rows');
      tbody.innerHTML = rows.map(r => \`
        <tr class="border-b last:border-0">
          <td class="p-3">\${r.kickoff}</td>
          <td class="p-3">\${r.league}</td>
          <td class="p-3 font-semibold">\${r.home}</td>
          <td class="p-3">\${r.away}</td>
          <td class="p-3">\${r.prediction}</td>
          <td class="p-3">\${r.confidence}</td>
        </tr>\`
      ).join('');
    }
    loadPredictions();
  </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(INDEX_HTML);
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
