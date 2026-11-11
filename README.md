# Watchman

A live picture of the planet's traffic, drawn like a printed chart on warm paper: every aircraft a volunteer receiver can hear, ships reporting over AIS, earthquakes as they happen, disasters with an alert level, and the space station overhead.

![The globe at night over the Americas, aircraft coloured by altitude](docs/globe.jpg)

Nothing is simulated, and nothing is guessed. Every number on screen comes from a named source, says how old it is, and is left out when it can't be checked.

![A selected flight: photo, verified route with progress and ETA, telemetry](docs/flight.jpg)

## What's in it

**The map.** A MapLibre globe that turns flat as you zoom in, styled on OpenFreeMap tiles as a paper chart: washed-out shaded relief, quiet borders, grey type. Traffic is the only colour on the page.

- **Aircraft**, drawn as top-down silhouettes by type (airliner, wide-body, business jet, light aircraft, helicopter, fast jet, glider, drone), pointing along their track and coloured by altitude from amber near the ground to deep blue above 40,000 ft.
- **Ships**, teal when under way and pale when moored or at anchor.
- **Earthquakes** (USGS) as rings sized by magnitude, fading with age; fresh ones pulse.
- **Disasters** (GDACS): cyclones, floods, volcanoes, droughts and wildfires with orange or red alerts.
- **The ISS** with its ground track 45 minutes back and ahead.
- **Day and night**: the terminator plus civil, nautical and astronomical twilight, in 3° bands.
- **Weather now** (`C`): the weather measured at about 5,000 stations worldwide in the last three hours (every METAR, from NOAA's Aviation Weather Center). A dot coloured by air temperature, a ring where it is raining, snowing, storming or foggy, an arrow showing where the surface wind is blowing, and the numbers in words when you zoom in. Click a station for its last report, decoded: conditions, wind, visibility, cloud, temperature, humidity and pressure.
- **Satellite clouds** (`V`): the newest infrared picture from the ring of geostationary satellites (EUMETSAT's mosaic of Meteosat, GOES and Himawari, every three hours, its time stated), redrawn so clear sky is transparent and cloud is shading, deeper where the tops are colder and higher.
- **Aviation hazards** (`Z`): every SIGMET in force worldwide, the warnings meteorological offices issue for weather dangerous to all aircraft (thunderstorms, severe turbulence and icing, volcanic ash, tropical cyclones, mountain waves), with the levels they cover and how long they last. Each has a sheet listing the aircraft flying through it now; an aircraft's own sheet says when it is inside one at its altitude, and the Log lists every aircraft that is.
- **Weather radar** (`R`, RainViewer) with its time, and a loop of the last two hours. **Airports** (3,300 with scheduled service) and **callsign labels**.

**What the aircraft itself says.** Many airliners broadcast far more than position, and Watchman shows it: the altitude and heading set on the autopilot and whether it is climbing to it, the autopilot modes engaged (LNAV, VNAV, approach, TCAS), indicated and true airspeed and Mach, bank angle and turn rate, the altimeter setting, outside air temperature against the standard atmosphere, the wind it is flying through split into headwind and crosswind, and how accurate its position is.

**Winds aloft** (`W`). Thousands of aircraft report the wind they measure; drawn together they show the jet streams live, with arrows that point downwind and grow and darken with speed. The Index has a jet stream poster with the strongest wind being measured anywhere.

**Airport weather.** Click an airport for its latest METAR from NOAA's Aviation Weather Center, decoded: flight category, wind, visibility, cloud, temperature, dew point and pressure, alongside arrivals and departures on the map.

**Ships, in depth.** Registry particulars (year built, gross tonnage, deadweight, registry and home port, nearest town) and the last day of track from Open Waters, plus photos and class from Wikidata.

**The details sheet.** Click anything. For an aircraft: a photo of the actual airframe with the photographer's credit, its type, operator and registration, the country of registration from its ICAO address, the route with a progress bar, distance flown and to go and an arrival estimate, altitude (pressure and GNSS), vertical rate, ground speed, track, squawk, how its position was obtained (ADS-B, MLAT or TIS-B), report age, and an altitude and speed profile of its flight so far. For a ship: type, flag, destination and ETA, size, draught, rate of turn, and a photo and particulars from Wikidata when it has an IMO entry. Airports show live arrivals, departures and whether it is day or night there; earthquakes show depth, felt reports, tsunami flag and PAGER alert. Under a verified route, the destination's weather right now. When a track drops out of the feed the sheet says so and keeps counting the age of its last report.

**The Index** (`I`). The picture right now, as posters: aircraft aloft by altitude band, the highest and fastest aircraft, emergency squawks, the strongest earthquake of the week, the past day's quakes on a world map, where the sun is rising and setting, the ISS, ships under way, the busiest approach, military traffic, disaster alerts. They hang on cloth in WebGL, ripple, and bend as you scroll or drag through them. Click one to fly there.

![The Index: live data printed as posters on cloth](docs/index.jpg)

**News** (`H`). Headlines from fifteen open RSS feeds about flying (Aviation Week, Simple Flying, AeroTime, AirLive, Aviation24), shipping (gCaptain, Splash247, The Maritime Executive, MarineLink, The Loadstar, Hellenic Shipping News) and the world (BBC, Al Jazeera, The Guardian, DW), filterable by topic or by what is on screen. A story is pinned to the map by the first city or country its headline names (a city beats a country, airline names like "Air Canada" don't count, everyday words like "Nice" are skipped); stories it can't place are listed but not pinned. Click a pin for every story there plus what is flying nearby right now. The details sheets pick up stories too: an aircraft's sheet shows headlines naming its airline or registration, a ship's its name or destination port, an airport's its city. Crashes, collisions and sinkings in aviation and shipping news raise an alert.

**Near me** (`O`). Everything within 25, 60 or 150 km of you (or of the map centre), nearest first, with where to look: compass direction and the angle above the horizon, allowing for the Earth's curve. Your location is rounded to about a kilometre and never leaves the device.

**Spacecraft and launches** (`S`). The space stations, the crew and cargo ships docked to them and about 160 satellites bright enough to see, from CelesTrak's orbital elements, propagated in the browser with SGP4 every second. Select one for its ground track, altitude, speed, period, inclination, perigee and apogee, and whether it is sunlit. Upcoming launches worldwide (Launch Library 2) sit on their pads with a countdown; crewed launches are red.

**Log** (`K`). The unusual things in the sky right now: emergencies, spacecraft, the next launches, drones (ADS-B category UAV, or a drone type such as Reaper, Global Hawk or Triton) and military aircraft by type. First sightings of each are written to a log kept on this device. Tanks and other ground vehicles carry no public transponder, so no open source can show them.

**Search** (`/` or Ctrl K) finds aircraft by callsign, registration, ICAO address, squawk or type; ships by name, MMSI, IMO or destination, anywhere in the world (not only those on screen); airports by code, name or city; earthquakes by place; spacecraft by name or NORAD number; launches; and news headlines.

**Alerts** appear when an aircraft squawks 7500, 7600 or 7700 (once a second report confirms it) or a magnitude 5.5+ earthquake strikes.

**Watch** an aircraft or ship from its sheet: a note (and a system notification when the tab is in the background, if you allow it) when it comes into range, takes off, lands, squawks an emergency, gets under way or stops. The Log lists what you are watching. The list stays on your device.

**Replay** (`P`, or Replay at the bottom): the last few hours from snapshots the server takes every minute, scrubbed with a slider or played at 30, 60 or 240 times real speed, positions blended between snapshots.

**Links** carry what is on screen: the view, the selection and any layers you changed, for example `/#@51.4700,-0.4500,8.50/a:4ca7b4/layers:+weather`. Older links like `/#a:a5954e` (aircraft) or `/#s:230123456` (ship) still work, a ship link opens a ship anywhere in the world, and a link to something no longer tracked says so.

## Accuracy

This is where most of the work went.

- **Tracks never jump backwards.** The aggregator merges every feed by ICAO address or MMSI and only moves a track when a report's position time is newer than the one it holds, so a slow worldwide poll can't drag a plane back to where it was a minute ago.
- **Dead reckoning along great circles**, at reported ground speed and track, for as long as the feed's report interval justifies: 45 s for a local receiver feed that reports every few seconds, a little more than the polling interval for the worldwide feed. When the next report lands, the gap is closed over a second instead of snapping. Tracks fade once overdue and the details sheet says how far ahead of its last report a symbol is drawn.
- **Routes are verified before they are shown.** Route databases map a callsign to the route it usually flies and are often wrong. The aircraft has to be inside a corridor around the great circle between the two airports (widening with route length, since long flights ride or dodge jet streams) and not heading away from the destination. If it isn't, the sheet says which route was on file and why it was rejected.
- **More aircraft, free.** Besides area and type queries, the server asks adsb.lol and airplanes.live for their worldwide LADD and privacy-address lists (mostly business jets other networks hide) and for large military drone types by name. Point `READSB_URLS` at your own receiver's `aircraft.json` and everything your antenna hears appears every two seconds.
- **More ships, free.** Open Waters is swept at 75 requests a minute (its limit is 120), busy seas every two minutes, and the map shows up to 15,000 ships in view. `AIS_TCP_FEEDS` adds any raw NMEA AIS stream, such as your own AIS-catcher.
- **Real types for every aircraft.** OpenSky doesn't send aircraft types, so the server loads the tar1090 airframe database (620,000 entries: registration, type, model, operator, military flag) and fills them in.
- **Headlines are checked.** The Index only names the highest or fastest aircraft when its type is known and its numbers are plausible (barometric and GNSS altitude agree, no multilaterated speed).
- **Bad data is filtered**: ground vehicles and tower beacons, positions older than a minute, garbled jumps faster than Mach 3, AIS "not available" values (speed 102.3, course 360, heading 511, rate of turn −128).
- **Solar position** uses the NOAA algorithm and agrees with an independent implementation to 0.01°. The ISS's sunlight takes its altitude into account (it sees the sun about 20° past the ground terminator).
- **Coverage is stated honestly.** Volunteer receivers cover Europe and North America densely and oceans, much of Africa and Central Asia thinly. The About page lists every source with its live status.

`npm test` covers the geodesy, solar position, feed parsing, merging, emergency confirmation and route verification.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ahroonsanthosh/coolshi)

Watchman needs a small always-on Node server (most of its sources don't allow direct browser requests), so it can't run on static hosting like GitHub Pages. The button above deploys `render.yaml` to Render's free tier; any container host works with the `Dockerfile`. On Render's free plan the service sleeps after 15 minutes without visitors and takes about a minute to wake.

## Running it

Requires Node.js 22.18 or newer (the server is TypeScript run directly by Node).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The aggregator runs on port 8080 and Vite proxies `/api` to it.

For production, one process on one port:

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:8080. On first start the server downloads the aircraft database (8 MB) into `.cache/` and refreshes it weekly.

### Configuration

Everything is optional; copy `.env.example` to `.env`.

| Setting | What it does |
| --- | --- |
| `OPENSKY` | Off unless `on`. OpenSky's terms ask for a written agreement before its API feeds any live service, even a free one; switch it on once you have one. |
| `ADSBONE` | Off unless `on`. ADSB One's terms allow personal use only and forbid redisplaying its data, and its API was archived in 2026. |
| `ADSBLOL_PER_DAY` | Requests a day to adsb.lol (default 450; it allows 500 per address without a key). |
| `REPLAY_HOURS` | Hours of snapshots kept for replay (default 2, about 25 MB an hour at a busy time). |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | A free OpenSky account raises the daily allowance from 400 to 4,000 credits. A worldwide poll costs 4, so anonymous access gives about four hours of world view a day at the default 150 s interval; an account keeps it live most of the day at 45 s. Polling only runs while someone is watching. |
| `OPENSKY_POLL_S` | Seconds between worldwide polls. |
| `AISSTREAM_API_KEY` | Worldwide ships from AISStream (free key at aisstream.io). Without it, ships come from Fintraffic's open feed for the Baltic. |
| `PORT` | Port for the aggregator and the built site (default 8080). |
| `TRUST_PROXY_HOPS` | How many proxies in front of the server add to X-Forwarded-For (default 1, as on Render). Per-address limits use the address the nearest one saw, and only when the connection comes from a private address; 0 ignores the header. |

### Free coverage, no keys

Without any keys, Watchman combines:

- **A worldwide sweep** across the volunteer ADS-B networks (adsb.fi, airplanes.live, and adsb.lol within its 500 requests a day): 608 circles of 250 nm, spaced so every scheduled airport and the airspace between them is inside one, busiest airspace every two minutes and the rest every five when the networks have room (longer when they don't), each network kept under its published rate limit. It carries the whole picture; OpenSky, when switched on, adds a worldwide snapshot on top (the status line says `Live · regional` when it is on but out of credits).
- **Estimated positions beyond receiver range**, the way commercial trackers fill the oceans. When an airliner at cruise falls silent and its filed route is confirmed by its position and heading (within 30° of the destination), it is carried along the great circle to its destination at its last ground speed until about 20 minutes out, when receivers there should hear it again. Estimates are drawn as faded ghosts, labelled everywhere, kept out of every live count and headline, and replaced by the first real report.
- **Worldwide by aircraft type.** airplanes.live (and adsb.lol, adsb.one) answer "every aircraft of this type, anywhere" in one request, so the server asks for the 60 most common types (ranked from live traffic) every few minutes. In testing that added about 15–20% more aircraft than the circle sweep alone.
- **Military aircraft** from every network's military list each cycle (each hears different traffic), worldwide queries for military types (tankers, transports, patrol, AWACS, helicopters), and flagged by the airframe database, by types only air forces fly, and by the ICAO address blocks states reserve for military use. Military aircraft that answer radar with Mode S but broadcast no position are shown too, as rings at the rough area of the receivers hearing them, clearly marked approximate (they can be off by a hundred kilometres or more), with fast jets and bombers (F-16, F-15, F/A-18, F-35, F-22, B-1, B-2, B-52, Eurofighter, Rafale, Gripen, Hawk, M-346) searched for by type worldwide. Press `M` to show only military. Only aircraft that transmit something can be shown; most combat sorties don't.
- **Your view**, refreshed every five seconds from the same networks, plus worldwide military aircraft and emergency squawks.
- **Ships worldwide** from Open Waters AIS, an open network that merges government feeds, AISHub, aisstream.io and volunteer receivers and needs no key: the server sweeps the world's seas in 10° boxes (busy ones every 3 minutes, empty ones hourly) within its anonymous limits, and polls whatever you are looking at every 20 seconds. Plus Fintraffic (Baltic) and Kystverket (Norway) directly. Around 40,000 ships within two minutes of starting; the browser receives only those in view (up to 12,000). An optional free token (`OPENWATERS_TOKEN`) raises the limits.

An AISStream key (`AISSTREAM_API_KEY`) adds a second worldwide ship stream. Some networks refuse requests from cloud servers; a refused feed backs off for an hour and the About page shows it, so check there after deploying.

## How it works

```
OpenSky (world, every 150 s) ─┐
adsb.fi / adsb.lol (your view │
  every 5 s, military,        ├─► server/store.ts ─► /api/air  (deltas) ─┐
  emergency squawks) ─────────┤    merge by address,  /api/sea           ├─► browser: dead reckoning,
Fintraffic AIS, AISStream ────┤    newest position    /api/world         │   MapLibre globe, panels,
USGS, GDACS, ISS, METARs ─────┘    wins, history      /api/history/...  ─┘   three.js Index
tar1090 aircraft database ────────► types, registrations
```

- `server/` the aggregator: feeds, the merged store, HTTP. Each browser reports what it is looking at, and the ADS-B networks are asked about those areas, paced to their published limits (adsb.fi one request a second; adsb.lol more gently).
- `shared/` geodesy, solar position and the wire format, used by both sides.
- `src/` the client: `map/` (style, icons, layers, render loop), `ui/` (sheet, search, layers, about), `gallery/` (posters and the cloth renderer), `lib/` (aircraft and AIS tables, enrichment, formatting).

Photos (Planespotters), airframes and routes (adsbdb), ship particulars (Wikidata) and radar (RainViewer) are fetched by the browser on demand.

## Keys

| Key | Action |
| --- | --- |
| `/`, Ctrl K | Search |
| `I` | Index |
| `L` | Layers and filters |
| `M` | Military aircraft only |
| `W` | Winds aloft |
| `C` | Weather now, measured at stations |
| `V` | Satellite clouds |
| `Z` | Aviation hazards (SIGMETs) |
| `P` | Replay |
| `F` | Follow the selected track |
| `G` | Back to the whole globe |
| `R` / `N` / `A` / `E` / `T` | Radar / day and night / airports / earthquakes / trail |
| `Esc` | Close, or clear the selection |


## Data and credits

Each source's terms were checked in November 2026. Most volunteer and open feeds are for non-commercial use: Watchman is free, with no ads or accounts, and anyone running a public copy should read the terms of the sources they switch on. In short: adsb.fi asks for a credit and link and one request a second; adsb.lol data is ODbL 1.0; RainViewer's free API is for personal, educational and small community use, with a credit and link; EUMETSAT imagery is CC BY 4.0 and wants "Contains modified EUMETSAT data"; NOAA's data is public domain (no endorsement implied); Planespotters photos must show the photographer and link to the photo page, loaded by the browser, never proxied; adsbdb's route data may not be republished, so routes are looked up by the browser and not stored; Open Waters is free for personal use, and the sources it relays keep their own attribution. airplanes.live's terms page could not be read from a server; it describes its API as non-commercial, one request a second.

Open Waters AIS (openwaters.io); AISHub; BarentsWatch (NLOD); OpenSky Network (when switched on); adsb.fi (adsb.fi); © adsb.lol contributors, ODbL 1.0; airplanes.live; adsb.one (when switched on); Fintraffic Digitraffic (CC BY 4.0); Kystverket, Norwegian Coastal Administration (NLOD); AISStream; USGS; GDACS (European Commission, UN); NOAA Aviation Weather Center (METARs and SIGMETs); contains modified EUMETSAT data (geostationary infrared, CC BY 4.0), with NOAA GOES and JMA Himawari imagery; wheretheiss.at; weather data by RainViewer (rainviewer.com); The Space Devs (Launch Library 2); CelesTrak; Planespotters.net (photos credited to their photographers); adsbdb; Wikidata and Wikimedia Commons; tar1090-db (Mictronics, wiedehopf); OurAirports (public domain); ICAO Annex 10 address blocks; ITU maritime identification digits; OpenFreeMap, OpenMapTiles and © OpenStreetMap contributors; Natural Earth.
