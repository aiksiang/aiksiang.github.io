// Fetches the Klang Valley stations from Malaysia's DOE (APIMS) ArcGIS layer and
// writes data/latest.json + data/history.json for the static page.
//
// Why this exists: the DOE endpoint only sends
// `Access-Control-Allow-Origin: https://eqmp.doe.gov.my`, so a browser on
// github.io cannot read it. Singapore's API allows any origin and is fetched
// directly by the page, so it is not handled here.
//
// Run with Node 20+ (built-in fetch). No dependencies.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const LAYER =
  'https://eqms.doe.gov.my/api3/publicmapproxy/PUBLIC_DISPLAY/CAQM_MCAQM_Current_Reading/MapServer/0/query';

// Kuala Lumpur proper has two DOE stations; Putrajaya is the federal territory
// next door and is shown separately on the page, not counted in the KL headline.
const STATIONS = ['CA15W', 'CA16W', 'CA17W'];

// `outFields=*` on this proxy returns only a short default field set (no
// pollutant data). Naming fields explicitly returns them.
const FIELDS = [
  'STATION_ID', 'STATION_LOCATION', 'PLACE', 'STATE_NAME', 'DATETIME', 'API', 'CLASS',
  'PARAM_SELECTED', 'STATION_STATUS',
  'SI_PM25', 'SI_PM10', 'SI_O3', 'SI_NO2', 'SI_SO2', 'SI_CO',
  'PM25_CONC', 'PM10_CONC', 'PM25_24H_AVG', 'PM10_24H_AVG',
];

const HISTORY_DAYS = 7;
// Where to write the JSON files, relative to the repo root.
const DATA_DIR = process.env.HAZE_DATA_DIR || 'data';
const MYT_OFFSET_MS = 8 * 3600 * 1000;

// DOE's DATETIME is Malaysia wall-clock time encoded as if it were UTC
// (a reading fetched at 06:52Z carried 14:00 "Z"). Convert to a real instant.
function toIso(doeMs) {
  const real = new Date(doeMs - MYT_OFFSET_MS);
  const local = new Date(doeMs); // its UTC fields are the MYT wall clock
  const p = (n) => String(n).padStart(2, '0');
  return {
    epoch: real.getTime(),
    iso: `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:00+08:00`,
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

async function fetchStations() {
  const where = `STATION_ID IN (${STATIONS.map((s) => `'${s}'`).join(',')})`;
  const url = `${LAYER}?${new URLSearchParams({
    where,
    outFields: FIELDS.join(','),
    returnGeometry: 'false',
    f: 'json',
  })}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`ArcGIS error: ${JSON.stringify(body.error)}`);
      if (!Array.isArray(body.features) || body.features.length === 0) throw new Error('no features');
      return body.features.map((f) => f.attributes);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function shape(a) {
  const t = toIso(a.DATETIME);
  return {
    id: a.STATION_ID,
    name: (a.STATION_LOCATION || '').split(',')[0].trim(),
    place: a.PLACE?.trim() || null,
    state: a.STATE_NAME,
    time: t.iso,
    epoch: t.epoch,
    api: num(a.API),
    cls: a.CLASS || null,
    dominant: a.PARAM_SELECTED || null,
    status: a.STATION_STATUS ?? null,
    subIndex: {
      pm25: num(a.SI_PM25), pm10: num(a.SI_PM10), o3: num(a.SI_O3),
      no2: num(a.SI_NO2), so2: num(a.SI_SO2), co: num(a.SI_CO),
    },
    // µg/m³. PM*_CONC is the latest 1-hour value; *_24H_AVG is the rolling 24-hour mean.
    pm25_1h: num(a.PM25_CONC),
    pm25_24h: num(a.PM25_24H_AVG),
    pm10_1h: num(a.PM10_CONC),
    pm10_24h: num(a.PM10_24H_AVG),
  };
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

const stations = (await fetchStations()).map(shape);
const fetchedAt = new Date().toISOString();

await mkdir(DATA_DIR, { recursive: true });

const latest = {
  source: 'Department of Environment Malaysia (APIMS), eqms.doe.gov.my',
  fetchedAt,
  stations,
};

// History: one row per station per reading hour, newest last, trimmed to 7 days.
const history = await readJson(`${DATA_DIR}/history.json`, { rows: [] });
const seen = new Set(history.rows.map((r) => `${r.id}@${r.epoch}`));
for (const s of stations) {
  const key = `${s.id}@${s.epoch}`;
  if (seen.has(key) || s.api == null) continue;
  history.rows.push({ id: s.id, epoch: s.epoch, time: s.time, api: s.api, pm25_1h: s.pm25_1h, pm25_24h: s.pm25_24h });
}
const cutoff = Date.now() - HISTORY_DAYS * 86400 * 1000;
history.rows = history.rows.filter((r) => r.epoch >= cutoff).sort((a, b) => a.epoch - b.epoch);
history.updatedAt = fetchedAt;

await writeFile(`${DATA_DIR}/latest.json`, JSON.stringify(latest, null, 1) + '\n');
await writeFile(`${DATA_DIR}/history.json`, JSON.stringify(history) + '\n');

console.log(stations.map((s) => `${s.id} ${s.name} API ${s.api} (${s.cls}) PM2.5 ${s.pm25_1h} @ ${s.time}`).join('\n'));
