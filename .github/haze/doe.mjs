// Shared DOE Malaysia (APIMS) logic, used by both scripts/fetch-kl.mjs (GitHub
// Actions) and worker/index.mjs (Cloudflare Worker). Runtime-neutral: only uses
// fetch, URLSearchParams and AbortSignal, which both Node 20+ and Workers have.

export const SOURCE = 'Department of Environment Malaysia (APIMS), eqms.doe.gov.my';

const LAYER =
  'https://eqms.doe.gov.my/api3/publicmapproxy/PUBLIC_DISPLAY/CAQM_MCAQM_Current_Reading/MapServer/0/query';

// Kuala Lumpur proper has two DOE stations; Putrajaya is the federal territory
// next door and is shown separately on the page, not counted in the KL headline.
export const STATIONS = ['CA15W', 'CA16W', 'CA17W'];

// `outFields=*` on this proxy returns only a short default field set (no
// pollutant data). Naming fields explicitly returns them.
const FIELDS = [
  'STATION_ID', 'STATION_LOCATION', 'PLACE', 'STATE_NAME', 'DATETIME', 'API', 'CLASS',
  'PARAM_SELECTED', 'STATION_STATUS',
  'SI_PM25', 'SI_PM10', 'SI_O3', 'SI_NO2', 'SI_SO2', 'SI_CO',
  'PM25_CONC', 'PM10_CONC', 'PM25_24H_AVG', 'PM10_24H_AVG',
];

export const HISTORY_DAYS = 7;
const MYT_OFFSET_MS = 8 * 3600 * 1000;

export const QUERY_URL = `${LAYER}?${new URLSearchParams({
  where: `STATION_ID IN (${STATIONS.map((s) => `'${s}'`).join(',')})`,
  outFields: FIELDS.join(','),
  returnGeometry: 'false',
  f: 'json',
})}`;

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

export function shape(a) {
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

// Fetches and shapes the stations. Retries `attempts` times on errors (DOE
// intermittently answers HTTP 500).
export async function fetchStations({ attempts = 3, timeoutMs = 30000, backoffMs = 5000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(QUERY_URL, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`DOE HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`ArcGIS error: ${JSON.stringify(body.error)}`);
      if (!Array.isArray(body.features) || body.features.length === 0) throw new Error('no features');
      return body.features.map((f) => shape(f.attributes));
    } catch (e) {
      lastErr = e;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function latestPayload(stations, fetchedAt = new Date().toISOString()) {
  return { source: SOURCE, fetchedAt, stations };
}

// History: one row per station per reading hour, oldest first, trimmed to HISTORY_DAYS.
// Returns { history, added } where `added` counts new rows.
export function mergeHistory(history, stations, now = Date.now()) {
  const rows = Array.isArray(history?.rows) ? [...history.rows] : [];
  const seen = new Set(rows.map((r) => `${r.id}@${r.epoch}`));
  let added = 0;
  for (const s of stations) {
    if (s.api == null || seen.has(`${s.id}@${s.epoch}`)) continue;
    rows.push({ id: s.id, epoch: s.epoch, time: s.time, api: s.api, pm25_1h: s.pm25_1h, pm25_24h: s.pm25_24h });
    added++;
  }
  const cutoff = now - HISTORY_DAYS * 86400 * 1000;
  return {
    history: { rows: rows.filter((r) => r.epoch >= cutoff).sort((a, b) => a.epoch - b.epoch), updatedAt: new Date(now).toISOString() },
    added,
  };
}
