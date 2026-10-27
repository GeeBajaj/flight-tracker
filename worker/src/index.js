// Flight Tracker proxy: forwards the two AeroDataBox lookups the app uses and adds
// the API key server-side, so visitors of the static site don't need their own key.
//
// Guardrails, since the key's quota is shared by everyone who uses the site:
//   - only the app's two endpoints, with validated parameters, are forwarded
//   - browsers are only allowed from ALLOWED_ORIGINS (CORS)
//   - per-IP rate limit (RATE_LIMITER binding)
//   - responses are cached at the edge, so repeat lookups don't spend quota

const UPSTREAM = 'https://aerodatabox.p.rapidapi.com';
const NUMBER = '[A-Z0-9]{2,3}\\d{1,4}[A-Z]?';
const DATE = '\\d{4}-\\d{2}-\\d{2}';
const ROUTES = [
  {
    // Operating dates for a flight number
    pattern: new RegExp(`^/flights/number/(${NUMBER})/dates/(${DATE})/(${DATE})$`),
    query: '',
    ttl: 6 * 60 * 60,
  },
  {
    // One flight on one local departure date
    pattern: new RegExp(`^/flights/number/(${NUMBER})/(${DATE})$`),
    query: '?withAircraftImage=false&withLocation=true&dateLocalRole=Departure',
    ttl: 60,
  },
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = origin && allowed.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
      : null;

    if (origin && !cors) return json({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors || {} });
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, cors);

    const { pathname } = new URL(request.url);
    const route = ROUTES.find((r) => r.pattern.test(pathname));
    if (!route) return json({ error: 'Not found.' }, 404, cors);

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many requests. Try again in a minute.' }, 429, cors);
    }
    if (!env.AERODATABOX_KEY) return json({ error: 'Proxy is missing its API key.' }, 500, cors);

    const upstream = await fetch(`${UPSTREAM}${pathname}${route.query}`, {
      headers: { 'X-RapidAPI-Key': env.AERODATABOX_KEY, 'X-RapidAPI-Host': new URL(UPSTREAM).host },
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': route.ttl, '404': route.ttl, '400-599': 0 } },
    });

    // Never pass on upstream auth failures as-is: they'd look like a problem with the visitor's key.
    if (upstream.status === 401 || upstream.status === 403) {
      return json({ error: 'The proxy could not authenticate with the flight data provider.' }, 502, cors);
    }
    return new Response(upstream.status === 204 ? null : upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': `public, max-age=${route.ttl}`,
      },
    });
  },
};

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extra, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
