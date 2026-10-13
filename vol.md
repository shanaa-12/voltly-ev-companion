# Voltly EV Companion

Plan EV routes with turn-by-turn directions and see charging stations near your
start, along the route and near your destination.

Static site: plain HTML, CSS and JavaScript. No build step, no API key needed.

## Files
- index.html, style.css, script.js: the app
- manifest.json, icon.svg, sw.js: lets it be installed like an app (PWA)
- vercel.json: security headers for Vercel

## Run locally
    npx serve .
Open the printed address. (Opening index.html directly also works, but the
service worker only runs over http/https.)

## Deploy: GitHub then Vercel
1. Create a GitHub repo and push these files to the repo root.
2. Go to vercel.com, choose Add New, then Project, and import the repo.
3. Framework preset: Other. Leave build command and output directory empty.
4. Deploy.

## Data sources (all free, no keys)
- Map tiles: OpenStreetMap (dark look added with CSS)
- Place search: Nominatim, with Photon as a backup
- Routing: OSRM public demo server
- Chargers: OpenStreetMap via the Overpass API, or Open Charge Map if you add a key

These public services are fine for a prototype. For a commercial product in
real vehicles, move to a paid provider (see below), because the public servers
have fair-use limits and no uptime guarantee.

## Using your own map API key
- Tiles: set CONFIG.MAPTILER_KEY in script.js, and restrict the key to your
  Vercel domain in the MapTiler dashboard. Keys in front-end code are visible
  to anyone, so always use domain restrictions.
- Routing: change CONFIG.OSRM_URL to your own OSRM server, or replace
  fetchRoute() with Mapbox, OpenRouteService or Google Directions.
- Chargers: set CONFIG.OCM_API_KEY in script.js (free key from
  openchargemap.org/site/develop/api). Open Charge Map usually has better
  coverage than OpenStreetMap. Restrict or rotate the key if you publish it.

## Notes
- Battery use is an estimate from your saved full-range value, the driving
  style you pick and the route distance. It is not a live vehicle reading.
- Charger availability (free or busy) is not shown, because OpenStreetMap does
  not carry live status.

## Weekly analysis
Trips and charges are saved in the browser (localStorage). Trips come from
Trip planner, using "Mark trip as travelled". Charges come from "Log a charge"
on Overview. In a real vehicle you would feed these from the car's own data.
