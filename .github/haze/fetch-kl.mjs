// Fetches the Klang Valley stations from Malaysia's DOE (APIMS) ArcGIS layer and
// writes data/latest.json + data/history.json for the static page.
//
// Why this exists: the DOE endpoint only sends
// `Access-Control-Allow-Origin: https://eqmp.doe.gov.my`, so a browser on
// github.io cannot read it. The page reads KL live from the Cloudflare Worker
// (worker/) when it's deployed; these files are the fallback.
//
// Run with Node 20+ (built-in fetch). No dependencies.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fetchStations, latestPayload, mergeHistory } from './doe.mjs';

// Where to write the JSON files, relative to the repo root.
const DATA_DIR = process.env.HAZE_DATA_DIR || 'data';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

const stations = await fetchStations();
const latest = latestPayload(stations);
const { history } = mergeHistory(await readJson(`${DATA_DIR}/history.json`, { rows: [] }), stations);

await mkdir(DATA_DIR, { recursive: true });
await writeFile(`${DATA_DIR}/latest.json`, JSON.stringify(latest, null, 1) + '\n');
await writeFile(`${DATA_DIR}/history.json`, JSON.stringify(history) + '\n');

console.log(stations.map((s) => `${s.id} ${s.name} API ${s.api} (${s.cls}) PM2.5 ${s.pm25_1h} @ ${s.time}`).join('\n'));
