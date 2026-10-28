# Flight Tracker

Track live flights by flight number. Enter just the flight number to see where it goes, when it usually leaves and a calendar of every date it flies, or give a specific date. You can track as many flights (and dates) as you like, and each one refreshes on its own.

**Live at [geebajaj.github.io/flight-tracker](https://geebajaj.github.io/flight-tracker/)**, no sign-up or API key needed.

It's a static site with no build step. Flight data comes from [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) through a small [proxy](#optional-shared-key-proxy) that holds the API key. If you host your own copy without a proxy, each visitor enters their own free key instead.

## Features

- **Flight number only:** type `UA1` to see its next departure (route, scheduled times in local time, duration, aircraft) and a calendar of every date it operates, from a year back to a year ahead. Days it doesn't fly are greyed out and struck through. Pick one date, several, or a whole month.
- **Specific date:** add a date to track one departure straight away.
- **Route map:** a great-circle route between the airports with the part already flown highlighted, plus the plane's live position (or an estimate from the timetable when no live position is available).
- **Share links:** copy a link to one flight or to your whole list. Opening it adds those flights for whoever clicks it.
- **Live details:** status, departure and arrival times in **each airport's own time zone**, delays (scheduled times are crossed out when they change), terminal, gate, baggage belt, aircraft, and a progress bar. Altitude and ground speed appear while the flight is airborne.
- **Multi-leg flights:** if a flight number covers several legs on the same day, every leg is shown.
- **Smart refresh:** every 2 min in the air, every 3 min in the 3 hours before departure, and less often further out. Updates stop once a flight has arrived or been cancelled, which saves your API quota.
- **Saved state:** your tracked flights and their latest data are kept in your browser, so a reload shows everything instantly and only refetches what is due. Open tabs stay in sync.
- **Export / import:** save your flights to a JSON file to back them up or move them to another browser or device.

## Getting started

Enter a flight number (for example `BA117`) and click **Look up**, or also fill in a date and click **Track flight**.

### Without a proxy

If `proxyUrl` in `public/config.js` is empty, the app asks each visitor for their own key:

1. Subscribe to [AeroDataBox on RapidAPI](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) (the Basic plan is free) and copy your `X-RapidAPI-Key`.
2. Open **Backup & settings** at the bottom of the page, paste the key and click **Save key**.

The key is stored only in that browser's `localStorage` and is sent only to AeroDataBox. It is never committed to this repo and is left out of exported files and share links. When a proxy is configured, the key field is hidden and every request goes through the proxy.

## Run locally

Needs Node 18 or later. There are no dependencies.

```sh
git clone https://github.com/GeeBajaj/flight-tracker.git
cd flight-tracker
npm start
```

Then open http://localhost:3000. `server.js` only serves the files in `public/`, the same way GitHub Pages does. Any other static file server works too.

## Optional: shared key proxy

`worker/` is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) (free plan is enough) that adds your AeroDataBox key on the server, so visitors don't need their own. It only forwards the two lookups the app makes, only answers browsers from origins you allow, rate-limits each visitor to 30 requests a minute, and caches responses at the edge to save quota. Everyone who uses it shares your key's quota.

Needs Node 22 or later.

```sh
cd worker
npm install
npx wrangler login
npx wrangler secret put AERODATABOX_KEY   # paste your RapidAPI key when asked
npx wrangler deploy                       # prints https://flight-tracker-proxy.<you>.workers.dev
```

Then:

1. Put your site's origin (for example `https://<user>.github.io`) in `ALLOWED_ORIGINS` in `worker/wrangler.jsonc`, and redeploy if you changed it.
2. Set `proxyUrl` in `public/config.js` to the URL that `wrangler deploy` printed.

For local testing, put `AERODATABOX_KEY=...` in `worker/.dev.vars` (git-ignored) and run `npm run dev`.

## Deploy to GitHub Pages

The included workflow (`.github/workflows/pages.yml`) publishes the `public/` folder on every push to `main`.

1. In your repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`, or run the workflow manually from the **Actions** tab.

## Project layout

```
public/
  index.html      page markup
  styles.css      styles (light and dark)
  config.js       site settings (proxy URL)
  app.js          tracking, refresh scheduling, lookup, saved state, share links
  calendar.js     month calendar of a flight's operating dates
  map.js          route map (Leaflet + OpenStreetMap, loaded on first use)
  aerodatabox.js  API client: rate-limited requests, normalized flight data
worker/           optional Cloudflare Worker that holds the API key
server.js         tiny static server for local development
```

## Notes and limits

- Data comes from AeroDataBox. Coverage and accuracy depend on the airline and airport, and some smaller carriers may be missing or late to update.
- The free plan has a monthly request quota and a per-second limit. The app spaces out its requests and caches results, but tracking many flights at once uses quota faster.
- Flight dates are the local departure date at the origin airport.
- The calendar shows the airline's published schedule, which usually runs about a year ahead. Days outside the range shown are faded rather than struck through.
- Map tiles come from OpenStreetMap, which is fine for personal and light use. A busy deployment should switch to a commercial tile provider.
