// AeroDataBox (via RapidAPI) client: https://rapidapi.com/aedbx-aedbx/api/aerodatabox
// Called straight from the browser (RapidAPI allows CORS), so the site can be hosted
// as static files. The API key is supplied by the user and kept in their browser.

const ADB_HOST = 'aerodatabox.p.rapidapi.com';
const ADB_MIN_GAP_MS = 1100; // keep under the free tier's per-second limit

// Requests run one at a time with a small gap, so tracking many dates at once
// doesn't trip the rate limit.
let adbQueue = Promise.resolve();
let adbLastAt = 0;

function adbRequest(path, key) {
  const run = async () => {
    const wait = adbLastAt + ADB_MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    adbLastAt = Date.now();
    return fetch(`https://${ADB_HOST}${path}`, { headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': ADB_HOST } });
  };
  const p = adbQueue.then(run, run);
  adbQueue = p.catch(() => {});
  return p;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function adbCheck(r, notFound) {
  if (r.status === 204 || r.status === 404) throw httpError(404, notFound);
  if (r.status === 401 || r.status === 403) throw httpError(401, 'AeroDataBox rejected the API key. Check it in Settings.');
  if (r.status === 429) throw httpError(429, 'AeroDataBox rate limit reached. Try again shortly.');
  if (!r.ok) throw httpError(502, `AeroDataBox error (${r.status}).`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Local departure dates (YYYY-MM-DD) on which a flight number operates.
async function fetchFlightDates(number, from, to, key) {
  const r = await adbRequest(`/flights/number/${encodeURIComponent(number)}/dates/${from}/${to}`, key);
  const list = await adbCheck(r, `No upcoming dates found for ${number}.`);
  const dates = (Array.isArray(list) ? list : [])
    .map((d) => (typeof d === 'string' ? d : d?.date || d?.localDate || '').slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) throw httpError(404, `No upcoming dates found for ${number}.`);
  return [...new Set(dates)].sort();
}

// Returns an array of normalized legs:
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
async function fetchFlight(number, date, key) {
  const r = await adbRequest(
    `/flights/number/${encodeURIComponent(number)}/${date}?withAircraftImage=false&withLocation=true&dateLocalRole=Departure`,
    key,
  );
  const list = await adbCheck(r, `No flight ${number} found departing on ${date}.`);
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
    return {
      id: `${f.number}-${departure.iata || departure.icao}-${departure.scheduled || i}`,
      number: (f.number || number).replace(/\s+/g, ''),
      airline: { name: f.airline?.name || null, iata: f.airline?.iata || null },
      status: adbStatus[f.status] || 'unknown',
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
