# Flight Tracker

Enter a flight number and its local departure date to track it live. Add as many flights as you like: each one is fetched, refreshed and shown on its own, with no link to the others.

## Setup

1. Get an API key from one of these (accurate tracking needs a live data source):
   - **AeroDataBox** (free tier available): subscribe at https://rapidapi.com/aedbx-aedbx/api/aerodatabox and copy your RapidAPI key.
   - **FlightAware AeroAPI** (paid, the most precise gate and runway times): https://www.flightaware.com/aeroapi/
2. `cp .env.example .env` and paste the key in.
3. `npm start` (Node 18+, no dependencies), then open http://localhost:3000

## How it works

- `server.js` serves the page and calls the provider for you, so your API key stays on the server. Each flight is cached for 60s to save quota.
- Shows departure and arrival times in **each airport's own time zone**. Scheduled times are crossed out when they change, and delays are worked out from actual or estimated times.
- Also shows status, terminal, gate, baggage belt, aircraft, and progress. With AeroDataBox you also get live altitude and speed.
- If one flight number covers several legs on the same day (e.g. a multi-stop flight), every leg is shown.
- Refresh speed depends on the flight: every 2 min in the air, every 3 min in the 3 hours before departure, less often further out. Updates stop once the flight has arrived or been cancelled.
- Your tracked flights are saved in your browser, so they come back when you reload the page.

## Limits

- FlightAware only covers about the last 10 days through the next 2 days. AeroDataBox covers a wider range of dates.
- The data is only as accurate as the provider. Both get their times from airlines, airports, and ADS-B (live aircraft position broadcasts).
