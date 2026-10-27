# Flight Tracker

Track live flights by flight number. Enter just the flight number to choose from its upcoming departure dates, or give a specific date. You can track as many flights (and dates) as you like, and each one refreshes on its own.

It runs entirely in your browser: no backend, no account, no build step. You bring your own free [AeroDataBox](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) API key.

## Features

- **Flight number only:** type `UA1` and pick any, all, or one of its next 10 operating dates.
- **Specific date:** add a date to track one departure straight away.
- **Live details:** status, departure and arrival times in **each airport's own time zone**, delays (scheduled times are crossed out when they change), terminal, gate, baggage belt, aircraft, and a progress bar. Altitude and ground speed appear while the flight is airborne.
- **Multi-leg flights:** if a flight number covers several legs on the same day, every leg is shown.
- **Smart refresh:** every 2 min in the air, every 3 min in the 3 hours before departure, and less often further out. Updates stop once a flight has arrived or been cancelled, which saves your API quota.
- **Saved state:** your tracked flights and their latest data are kept in your browser, so a reload shows everything instantly and only refetches what is due. Open tabs stay in sync.
- **Export / import:** save your flights to a JSON file to back them up or move them to another browser or device.

## Getting started

1. Get a free API key: subscribe to [AeroDataBox on RapidAPI](https://rapidapi.com/aedbx-aedbx/api/aerodatabox) (the Basic plan is free) and copy your `X-RapidAPI-Key`.
2. Open the app, expand **Settings**, paste the key and click **Save key**.
3. Enter a flight number (for example `BA117`) and click **Find dates**, or also fill in a date and click **Track flight**.

### Your API key

The key is stored only in your browser's `localStorage` and is sent only to AeroDataBox. It is never committed to this repo and is left out of exported files. Anyone using a deployed copy of this site needs their own key.

## Run locally

Needs Node 18 or later. There are no dependencies.

```sh
git clone https://github.com/GeeBajaj/flight-tracker.git
cd flight-tracker
npm start
```

Then open http://localhost:3000. `server.js` only serves the files in `public/`, the same way GitHub Pages does. Any other static file server works too.

## Deploy to GitHub Pages

The included workflow (`.github/workflows/pages.yml`) publishes the `public/` folder on every push to `main`.

1. In your repo, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`, or run the workflow manually from the **Actions** tab.

## Project layout

```
public/
  index.html      page markup
  styles.css      styles (light and dark)
  app.js          tracking, refresh scheduling, date picker, saved state
  aerodatabox.js  API client: rate-limited requests, normalized flight data
server.js         tiny static server for local development
```

## Notes and limits

- Data comes from AeroDataBox. Coverage and accuracy depend on the airline and airport, and some smaller carriers may be missing or late to update.
- The free plan has a monthly request quota and a per-second limit. The app spaces out its requests and caches results, but tracking many flights at once uses quota faster.
- Flight dates are the local departure date at the origin airport.
