// Flight tracker server: serves the static site and proxies flight lookups to a
// real-time data provider so the API key never reaches the browser.
// Requires Node 18+ (global fetch). No dependencies.

const http = require('http');
const fs = require('fs');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_TTL_MS = (Number(process.env.CACHE_SECONDS) || 60) * 1000;

const PROVIDERS = {
  aerodatabox: { key: process.env.AERODATABOX_KEY, fetch: fetchAeroDataBox },
  flightaware: { key: process.env.FLIGHTAWARE_KEY, fetch: fetchFlightAware },
};

// Explicit PROVIDER wins; otherwise use whichever key is configured.
const providerName =
  process.env.PROVIDER ||
  (process.env.FLIGHTAWARE_KEY ? 'flightaware' : process.env.AERODATABOX_KEY ? 'aerodatabox' : null);
const provider = PROVIDERS[providerName];

const cache = new Map(); // "NUMBER|DATE" -> { at, data }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/flight') return handleFlight(url, res);
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { provider: providerName, configured: Boolean(provider && provider.key) });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  serveStatic(url.pathname, res);
});

async function handleFlight(url, res) {
  if (!provider || !provider.key) {
    return sendJson(res, 503, {
      error: 'No flight data provider configured. Add AERODATABOX_KEY or FLIGHTAWARE_KEY to .env and restart.',
    });
  }

  const number = normalizeFlightNumber(url.searchParams.get('number') || '');
  const date = url.searchParams.get('date') || '';
  if (!/^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(number)) {
    return sendJson(res, 400, { error: 'Invalid flight number. Use airline code + number, e.g. UA123 or BA2490.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return sendJson(res, 400, { error: 'Invalid date. Use YYYY-MM-DD.' });
  }

  const cacheKey = `${number}|${date}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return sendJson(res, 200, hit.data);

  try {
    const legs = await provider.fetch(number, date, provider.key);
    const data = { number, date, provider: providerName, fetchedAt: new Date().toISOString(), legs };
    cache.set(cacheKey, { at: Date.now(), data });
    sendJson(res, 200, data);
  } catch (err) {
    const status = err.status || 502;
    sendJson(res, status, { error: err.message || 'Upstream provider error' });
  }
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': (types[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(buf);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Providers. Each returns an array of normalized legs:
// {
//   id, number, airline: {name, iata}, status, statusText, isCodeshare,
//   aircraft: {model, reg}, distanceKm, lastUpdated,
//   departure: {iata, icao, name, city, tz, terminal, gate, scheduled, estimated, actual},
//   arrival:   {... same, baggage},
//   position:  {lat, lon, altFt, speedKt, heading, at} | null
// }
// All times are ISO-8601 UTC strings (or null). `tz` is the airport's IANA zone.
// status is one of: scheduled, boarding, departed, enroute, landed, arrived,
//                   delayed, cancelled, diverted, unknown
// ---------------------------------------------------------------------------

// AeroDataBox (via RapidAPI): https://rapidapi.com/aedbx-aedbx/api/aerodatabox
async function fetchAeroDataBox(number, date, key) {
  const host = 'aerodatabox.p.rapidapi.com';
  const url =
    `https://${host}/flights/number/${encodeURIComponent(number)}/${date}` +
    '?withAircraftImage=false&withLocation=true&dateLocalRole=Departure';
  const r = await fetch(url, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host } });

  if (r.status === 204 || r.status === 404) throw httpError(404, `No flight ${number} found departing on ${date}.`);
  if (r.status === 401 || r.status === 403) throw httpError(502, 'AeroDataBox rejected the API key.');
  if (r.status === 429) throw httpError(429, 'AeroDataBox rate limit reached. Try again shortly.');
  if (!r.ok) throw httpError(502, `AeroDataBox error (${r.status}).`);

  const text = await r.text();
  const list = text ? JSON.parse(text) : [];
  if (!Array.isArray(list) || list.length === 0) throw httpError(404, `No flight ${number} found departing on ${date}.`);

  const adbTime = (t) => (t && t.utc ? new Date(t.utc.replace(' ', 'T')).toISOString() : null);
  const adbStatus = {
    Expected: 'scheduled', Unknown: 'unknown', CheckIn: 'scheduled', Boarding: 'boarding', GateClosed: 'boarding',
    Departed: 'departed', EnRoute: 'enroute', Approaching: 'enroute', Delayed: 'delayed', Arrived: 'arrived',
    Canceled: 'cancelled', CanceledUncertain: 'cancelled', Diverted: 'diverted',
  };
  // Once a flight has departed (or arrived), AeroDataBox's revised time becomes the actual
  // gate time and runwayTime the actual takeoff/landing time.
  const endpoint = (e = {}, isArrival, happened) => {
    const a = e.airport || {};
    const revised = adbTime(e.revisedTime);
    return {
      iata: a.iata || null,
      icao: a.icao || null,
      name: a.name || a.shortName || null,
      city: a.municipalityName || null,
      tz: a.timeZone || null,
      terminal: e.terminal || null,
      gate: e.gate || null,
      ...(isArrival ? { baggage: e.baggageBelt || null } : {}),
      scheduled: adbTime(e.scheduledTime),
      estimated: revised || adbTime(e.predictedTime),
      actual: happened ? revised || adbTime(e.runwayTime) : null,
    };
  };
  const departedStates = new Set(['Departed', 'EnRoute', 'Approaching', 'Arrived', 'Diverted']);

  return list.map((f, i) => {
    const loc = f.location;
    const departure = endpoint(f.departure, false, departedStates.has(f.status));
    const arrival = endpoint(f.arrival, true, f.status === 'Arrived');
    const status = adbStatus[f.status] || 'unknown';
    return {
      id: `${f.number}-${departure.iata || departure.icao}-${departure.scheduled || i}`,
      number: (f.number || number).replace(/\s+/g, ''),
      airline: { name: f.airline?.name || null, iata: f.airline?.iata || null },
      status,
      statusText: f.status || 'Unknown',
      isCodeshare: f.codeshareStatus === 'IsCodeshared',
      aircraft: { model: f.aircraft?.model || null, reg: f.aircraft?.reg || null },
      distanceKm: f.greatCircleDistance?.km ? Math.round(f.greatCircleDistance.km) : null,
      lastUpdated: f.lastUpdatedUtc ? new Date(f.lastUpdatedUtc.replace(' ', 'T')).toISOString() : null,
      departure,
      arrival,
      position:
        loc && typeof loc.lat === 'number'
          ? {
              lat: loc.lat,
              lon: loc.lon,
              altFt: loc.pressureAltitude?.feet ?? loc.altitude?.feet ?? null,
              speedKt: loc.groundSpeed?.kt ?? null,
              heading: loc.trueTrack?.deg ?? null,
              at: loc.reportedAtUtc ? new Date(loc.reportedAtUtc.replace(' ', 'T')).toISOString() : null,
            }
          : null,
    };
  });
}

// FlightAware AeroAPI v4: https://www.flightaware.com/aeroapi/portal/documentation
async function fetchFlightAware(number, date, key) {
  // Query a window around the date (UTC) then filter by local departure date at the origin.
  const day = new Date(`${date}T00:00:00Z`);
  const start = new Date(day.getTime() - 86400000).toISOString().slice(0, 19) + 'Z';
  const end = new Date(day.getTime() + 2 * 86400000).toISOString().slice(0, 19) + 'Z';
  const url =
    `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(number)}` +
    `?ident_type=designator&start=${start}&end=${end}&max_pages=2`;
  const r = await fetch(url, { headers: { 'x-apikey': key, Accept: 'application/json' } });

  if (r.status === 404) throw httpError(404, `No flight ${number} found departing on ${date}.`);
  if (r.status === 401 || r.status === 403) throw httpError(502, 'FlightAware rejected the API key.');
  if (r.status === 429) throw httpError(429, 'FlightAware rate limit reached. Try again shortly.');
  if (r.status === 400) {
    throw httpError(400, 'FlightAware only covers roughly the last 10 days through the next 2 days.');
  }
  if (!r.ok) throw httpError(502, `FlightAware error (${r.status}).`);

  const body = await r.json();
  const flights = (body.flights || []).filter((f) => {
    const sched = f.scheduled_out || f.scheduled_off;
    return sched && localDate(sched, f.origin?.timezone) === date;
  });
  if (flights.length === 0) throw httpError(404, `No flight ${number} found departing on ${date}.`);

  flights.sort((a, b) => Date.parse(a.scheduled_out || a.scheduled_off) - Date.parse(b.scheduled_out || b.scheduled_off));

  return flights.map((f) => {
    const endpoint = (a = {}, which) => ({
      iata: a.code_iata || null,
      icao: a.code_icao || a.code || null,
      name: a.name || null,
      city: a.city || null,
      tz: a.timezone || null,
      terminal: (which === 'out' ? f.terminal_origin : f.terminal_destination) || null,
      gate: (which === 'out' ? f.gate_origin : f.gate_destination) || null,
      ...(which === 'in' ? { baggage: f.baggage_claim || null } : {}),
      scheduled: which === 'out' ? f.scheduled_out || f.scheduled_off : f.scheduled_in || f.scheduled_on,
      estimated: which === 'out' ? f.estimated_out || f.estimated_off : f.estimated_in || f.estimated_on,
      actual: which === 'out' ? f.actual_out || f.actual_off : f.actual_in || f.actual_on,
    });
    const departure = endpoint(f.origin, 'out');
    const arrival = endpoint(f.destination, 'in');

    let status = 'scheduled';
    if (f.cancelled) status = 'cancelled';
    else if (f.diverted) status = 'diverted';
    else if (f.actual_in) status = 'arrived';
    else if (f.actual_on) status = 'landed';
    else if (f.actual_off) status = 'enroute';
    else if (f.actual_out) status = 'departed';
    else if ((f.departure_delay || 0) >= 15 * 60) status = 'delayed';

    return {
      id: f.fa_flight_id,
      number: f.ident_iata || f.ident || number,
      airline: { name: f.operator || null, iata: f.operator_iata || null },
      status,
      statusText: f.status || status,
      isCodeshare: false,
      aircraft: { model: f.aircraft_type || null, reg: f.registration || null },
      distanceKm: f.route_distance ? Math.round(f.route_distance * 1.609344) : null,
      lastUpdated: null,
      departure,
      arrival,
      progress: typeof f.progress_percent === 'number' ? f.progress_percent : null,
      position: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeFlightNumber(s) {
  return s.toUpperCase().replace(/[\s-]+/g, '');
}

function localDate(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

server.listen(PORT, () => {
  console.log(`Flight tracker running at http://localhost:${PORT}`);
  console.log(provider && provider.key ? `Data provider: ${providerName}` : 'WARNING: no API key configured (see .env.example)');
});
