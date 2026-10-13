"use strict";

/* =========================================================
   VOLTLY EV COMPANION
   Maps:          Leaflet + OpenStreetMap tiles (or MapTiler if a key is set)
   Geocoding:     OpenStreetMap Nominatim, with Photon as a backup
   Routing:       OSRM (turn-by-turn directions)
   Charger data:  Open Charge Map (if a key is set) and OpenStreetMap Overpass
   Storage:       Browser localStorage
========================================================= */

/* ---------- CONFIG ---------- */

const CONFIG = {
  // Optional. Paste a MapTiler key for a premium dark basemap.
  // Restrict the key to your Vercel domain in the MapTiler dashboard.
  // Leave empty to use free OpenStreetMap tiles (no key needed).
  MAPTILER_KEY: "",

  // Optional but recommended. Free key from https://openchargemap.org/site/develop/api
  // Open Charge Map usually has better charger coverage than OpenStreetMap,
  // especially in India. If empty, OpenStreetMap data is used.
  OCM_API_KEY: "17116bd0-921b-47d9-b10b-02434049ad26",

  // Battery percentage you want to keep as a safety buffer when suggesting
  // charging stops. Set to 0 to turn the buffer off.
  RESERVE_PERCENT: 10,

  // Routing server. The public OSRM demo is fine for testing and small apps.
  // For heavy or commercial use, host your own OSRM or switch to a paid router.
  OSRM_URL: "https://router.project-osrm.org/route/v1/driving",

  // Chargers within this distance of the start or destination are always shown.
  ENDPOINT_RADIUS_M: 5000
};

const STORAGE_KEY = "voltly_ev_profile_v1";

const DEFAULT_PROFILE = {
  name: "My electric vehicle",
  battery: 49,
  fullRange: 300,
  connector: "Unknown"
};

const DEFAULT_LOCATION = {
  lat: 13.0827,
  lon: 80.2707,
  label: "Chennai, India"
};

const PAGE_INFO = {
  home: {
    eyebrow: "YOUR ELECTRIC JOURNEY",
    title: 'Good to see you<span class="lime-text">.</span>',
    subtitle: "Everything you need for the road ahead."
  },
  trips: {
    eyebrow: "JOURNEY STUDIO",
    title: 'Trip planner<span class="lime-text">.</span>',
    subtitle: "Plan your route around your available battery."
  },
  stations: {
    eyebrow: "CHARGING NETWORK",
    title: 'Find your next charge<span class="lime-text">.</span>',
    subtitle: "Search locations and navigate to charging stations."
  },
  vehicle: {
    eyebrow: "YOUR ELECTRIC GARAGE",
    title: 'My vehicle<span class="lime-text">.</span>',
    subtitle: "Manage your battery and vehicle settings."
  }
};

// OpenStreetMap socket tags that match each connector in Vehicle settings.
const CONNECTOR_TAGS = {
  "CCS2": ["socket:type2_combo", "socket:ccs"],
  "Type 2": ["socket:type2"],
  "CHAdeMO": ["socket:chademo"]
};

const CURRENT_LOCATION_LABEL = "Your current location";

let profile = loadProfile();
let homeMap = null;
let stationMap = null;
let tripMap = null;
let homeMarkers = null;
let stationMarkers = null;
let tripRouteLayer = null;
let tripMarkerLayer = null;
const tripMarkerById = new Map();

let selectedStationId = null;
let lastStationResults = [];
let lastSearchLocation = null;
let toastTimeout = null;
let stationRequestController = null;

let tripController = null;
let originOverride = null; // { lat, lon } when "Use GPS" was used
let lastPlan = null;
let activeTripTab = "all";

/* ---------- STORAGE ---------- */

function loadProfile() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return { ...DEFAULT_PROFILE };

    const parsed = JSON.parse(saved);

    return {
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_PROFILE.name,
      battery: clampNumber(parsed.battery, 0, 100, DEFAULT_PROFILE.battery),
      fullRange: clampNumber(parsed.fullRange, 1, 2000, DEFAULT_PROFILE.fullRange),
      connector: typeof parsed.connector === "string" ? parsed.connector : DEFAULT_PROFILE.connector
    };
  } catch (error) {
    console.warn("Could not load saved vehicle settings.", error);
    return { ...DEFAULT_PROFILE };
  }
}

function saveProfile() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch (error) {
    console.warn("Could not save vehicle settings.", error);
    showToast("Could not save settings in this browser.");
    return false;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/* ---------- SMALL HELPERS ---------- */

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = String(value);
}

function showToast(message) {
  const toast = byId("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 3600);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character]);
}

function formatKm(value) {
  if (!Number.isFinite(value)) return "—";
  return `${Math.max(0, Math.round(value)).toLocaleString()} km`;
}

function formatDistanceKm(km) {
  if (!Number.isFinite(km)) return "—";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return `${hours} h ${minutes} min`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openExternal(url) {
  window.open(url, "_blank", "noopener,noreferrer");
}

function googleMapsDirections(destination, origin = null) {
  const params = new URLSearchParams({ api: "1", destination });
  if (origin) params.set("origin", origin);
  params.set("travelmode", "driving");
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function googleMapsRoute({ origin, destination, waypoint }) {
  const params = new URLSearchParams({ api: "1", origin, destination, travelmode: "driving" });
  if (waypoint) params.set("waypoints", waypoint);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function coordinatesForMaps(lat, lon) {
  return `${lat},${lon}`;
}

/* ---------- NAVIGATION ---------- */

function showPage(pageName) {
  if (!PAGE_INFO[pageName]) pageName = "home";

  document.querySelectorAll(".page").forEach(page => {
    page.classList.toggle("active", page.id === `page-${pageName}`);
  });

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.page === pageName);
  });

  const pageInfo = PAGE_INFO[pageName];
  byId("pageEyebrow").textContent = pageInfo.eyebrow;
  byId("pageTitle").innerHTML = pageInfo.title;
  byId("pageSubtitle").textContent = pageInfo.subtitle;

  if (pageName === "home") {
    syncProfileUI();
    renderWeekly();
    setTimeout(() => homeMap && homeMap.invalidateSize(), 100);
  }

  if (pageName === "stations") {
    setTimeout(() => stationMap && stationMap.invalidateSize(), 100);
  }

  if (pageName === "trips") {
    syncProfileUI();
    setTimeout(() => {
      if (!tripMap) return;
      tripMap.invalidateSize();
      if (lastPlan) fitTripBounds();
    }, 100);
  }

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setupNavigation() {
  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", event => {
      const pageName = button.dataset.page;
      if (!pageName) return;

      event.preventDefault();
      showPage(pageName);
    });
  });
}

/* ---------- PROFILE AND BATTERY SYNC ---------- */

function syncProfileUI() {
  const battery = clampNumber(profile.battery, 0, 100, 49);
  const fullRange = clampNumber(profile.fullRange, 1, 2000, 300);
  const remainingRange = fullRange * battery / 100;

  setText("homeBattery", battery);
  setText("homeRange", `${formatKm(remainingRange)} estimated range`);
  setText("homeVehicleName", profile.name || DEFAULT_PROFILE.name);
  setText("homeVehicleStatus", battery === 0 ? "Needs charging" : "Ready to go");

  byId("homeBatteryBar").style.width = `${battery}%`;

  setText("tripBatteryDisplay", battery);
  byId("tripBatteryBar").style.width = `${battery}%`;

  setText("vehicleBatteryBig", battery);
  setText("vehicleRangeBig", `Estimated range: ${formatKm(remainingRange)}`);
  byId("vehicleBatteryBar").style.width = `${battery}%`;

  setText("vehicleBatteryLabel", battery);
  byId("vehicleBattery").value = battery;
  byId("vehicleName").value = profile.name;
  byId("vehicleRange").value = fullRange;
  byId("vehiclePlug").value = profile.connector;

  const gradient = battery <= 15
    ? "linear-gradient(90deg, #ff777e, #ffb16b)"
    : "linear-gradient(90deg, #24d3c1, #b8ff50)";
  byId("homeBatteryBar").style.background = gradient;
  byId("tripBatteryBar").style.background = gradient;
}

function setupVehicleForm() {
  const batterySlider = byId("vehicleBattery");

  batterySlider.addEventListener("input", () => {
    setText("vehicleBatteryLabel", batterySlider.value);
    setText("vehicleBatteryBig", batterySlider.value);

    const previewRange = Number(byId("vehicleRange").value) * Number(batterySlider.value) / 100;
    setText("vehicleRangeBig", `Estimated range: ${formatKm(previewRange)}`);
    byId("vehicleBatteryBar").style.width = `${batterySlider.value}%`;
  });

  byId("vehicleRange").addEventListener("input", () => {
    const range = clampNumber(byId("vehicleRange").value, 1, 2000, profile.fullRange);
    const battery = Number(batterySlider.value);
    setText("vehicleRangeBig", `Estimated range: ${formatKm(range * battery / 100)}`);
  });

  byId("vehicleForm").addEventListener("submit", event => {
    event.preventDefault();

    const name = byId("vehicleName").value.trim();
    const range = Number(byId("vehicleRange").value);

    if (!Number.isFinite(range) || range < 1 || range > 2000) {
      showToast("Enter a full-charge range between 1 and 2000 km.");
      return;
    }

    profile = {
      name: name || DEFAULT_PROFILE.name,
      battery: clampNumber(batterySlider.value, 0, 100, profile.battery),
      fullRange: range,
      connector: byId("vehiclePlug").value
    };

    saveProfile();
    syncProfileUI();

    // Re-run the battery maths for the current trip with the new vehicle values.
    if (lastPlan) refreshPlanForProfile();

    setText("vehicleSaveStatus", "✓ Vehicle settings saved successfully.");
    showToast("Vehicle settings saved. Battery is synced across Voltly.");
  });
}

/* ---------- MAP SETUP ---------- */

function addTileLayer(map) {
  if (CONFIG.MAPTILER_KEY) {
    L.tileLayer(
      `https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key=${encodeURIComponent(CONFIG.MAPTILER_KEY)}`,
      {
        maxZoom: 20,
        attribution: '&copy; <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">MapTiler</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
      }
    ).addTo(map);
    return;
  }

  // Free OpenStreetMap tiles. The "map-tiles-dark" class (see style.css)
  // gives them the dark Voltly look without needing an API key.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    className: "map-tiles-dark",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
  }).addTo(map);
}

function createMap(elementId, startingPoint, zoom = 11) {
  const element = byId(elementId);
  if (!element || typeof L === "undefined") {
    console.error("Map element or Leaflet library is missing:", elementId);
    return null;
  }

  const map = L.map(elementId, { zoomControl: true, preferCanvas: true })
    .setView([startingPoint.lat, startingPoint.lon], zoom);

  addTileLayer(map);
  return map;
}

function createStationIcon(variant = "default") {
  const recommended = variant === "recommended";
  const size = recommended ? 36 : 29;
  const background = recommended ? "#24d3c1" : "#b8ff50";
  const border = recommended ? "#c5fff7" : "#e5ffbb";
  const glow = recommended ? "#24d3c188" : "#b8ff5066";

  return L.divIcon({
    className: "voltly-map-icon",
    html: `<div style="
      display:grid;place-items:center;
      width:${size}px;height:${size}px;
      background:${background};color:#10200b;
      border:2px solid ${border};border-radius:50%;
      font-size:${recommended ? 22 : 18}px;font-weight:800;
      box-shadow:0 0 ${recommended ? 20 : 15}px ${glow};
    ">ϟ</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

function createPinIcon(letter) {
  return L.divIcon({
    className: "voltly-map-icon",
    html: `<div style="
      display:grid;place-items:center;
      width:34px;height:34px;
      background:#f4f7fb;color:#08111c;
      border:3px solid #b8ff50;border-radius:50% 50% 50% 8px;
      transform:rotate(-45deg);
      box-shadow:0 4px 16px #0008;
    "><span style="transform:rotate(45deg);font-weight:800;font-size:14px">${letter}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34],
    popupAnchor: [0, -32]
  });
}

function createPlaceIcon() {
  return L.divIcon({
    className: "voltly-map-icon",
    html: `<div style="
      width:16px;height:16px;border-radius:50%;
      background:#f4f7fb;border:4px solid #24d3c1;
      box-shadow:0 0 12px #24d3c199;
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
    popupAnchor: [0, -10]
  });
}

function initMaps() {
  if (typeof L === "undefined") {
    console.error("Leaflet did not load. Check your internet connection.");
    showToast("Map library could not load. Check your connection and reload.");
    return;
  }

  homeMap = createMap("homeMap", DEFAULT_LOCATION, 11);
  stationMap = createMap("stationMap", DEFAULT_LOCATION, 10);
  tripMap = createMap("tripMap", DEFAULT_LOCATION, 10);

  if (homeMap) {
    homeMarkers = L.layerGroup().addTo(homeMap);
    L.marker([DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon])
      .addTo(homeMap)
      .bindPopup("<strong>Chennai</strong><br>Default map location");
  }

  if (stationMap) stationMarkers = L.layerGroup().addTo(stationMap);
  if (homeMap) placesLayer = L.layerGroup().addTo(homeMap);

  if (tripMap) {
    tripRouteLayer = L.layerGroup().addTo(tripMap);
    tripMarkerLayer = L.layerGroup().addTo(tripMap);
  }

  const locateButton = byId("homeLocateButton");
  if (locateButton) {
    locateButton.addEventListener("click", () => {
      locateUser()
        .then(location => homeMap?.setView([location.lat, location.lon], 14))
        .catch(error => showToast(error.message));
    });
  }
}

/* ---------- USER LOCATION ---------- */

function locateUser() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Your browser does not support location access."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      position => {
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          label: CURRENT_LOCATION_LABEL
        });
      },
      error => {
        let message = "Could not get your location.";

        if (error.code === 1) {
          message = "Location permission was denied. Allow location access in your browser.";
        } else if (error.code === 2) {
          message = "Your location is unavailable. Try searching for a city instead.";
        } else if (error.code === 3) {
          message = "Location request timed out. Please try again.";
        }

        reject(new Error(message));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });
}

/* ---------- GEOCODING ---------- */

async function searchNominatim(query, signal) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    method: "GET",
    signal,
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) throw new Error(`Nominatim returned HTTP ${response.status}.`);

  const results = await response.json();
  if (!Array.isArray(results) || results.length === 0) return null;

  return {
    lat: Number(results[0].lat),
    lon: Number(results[0].lon),
    label: results[0].display_name || query
  };
}

// Backup geocoder, used when Nominatim is unreachable or blocked.
async function searchPhoton(query, signal) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) throw new Error(`Photon returned HTTP ${response.status}.`);

  const data = await response.json();
  const feature = data.features?.[0];
  if (!feature?.geometry?.coordinates) return null;

  const [lon, lat] = feature.geometry.coordinates;
  const props = feature.properties || {};
  const label = [props.name, props.district || props.city, props.state, props.country]
    .filter(Boolean)
    .join(", ");

  return { lat: Number(lat), lon: Number(lon), label: label || query };
}

async function geocodeLocation(query, signal) {
  let notFound = false;

  for (const search of [searchNominatim, searchPhoton]) {
    try {
      const result = await search(query, signal);

      if (result && Number.isFinite(result.lat) && Number.isFinite(result.lon)) return result;
      notFound = true;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      console.warn("Location search failed:", error);
    }
  }

  if (notFound) {
    throw new Error(`"${query}" was not found. Try a nearby city or a more specific address.`);
  }

  throw new Error(
    "Could not reach the location search services. Check your internet connection, VPN or ad blocker, then try again."
  );
}

/* ---------- OVERPASS: CHARGING STATIONS ---------- */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];

/*
  clauses: array of Overpass "around" filters, e.g.
    "(around:5000,13.08,80.27)"
    "(around:5000,lat1,lon1,lat2,lon2,...)"   <- polyline = along a route
*/

async function runOverpass(clauses, signal) {
  const parts = clauses.flatMap(clause => [
    `node["amenity"="charging_station"]${clause};`,
    `way["amenity"="charging_station"]${clause};`,
    `relation["amenity"="charging_station"]${clause};`
  ]);

  const query = `[out:json][timeout:18];(${parts.join("")});out center tags;`;
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) {
      throw new DOMException("Search cancelled", "AbortError");
    }

    const controller = new AbortController();
    let timedOut = false;

    const abortFromParent = () => controller.abort();

    if (signal) {
      signal.addEventListener("abort", abortFromParent, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "application/json"
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(
          `Station service returned HTTP ${response.status}.`
        );
      }

      const data = await response.json();

      if (!Array.isArray(data.elements)) {
        throw new Error(
          "The charging station service returned invalid data."
        );
      }

      return data.elements;
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException("Search cancelled", "AbortError");
      }

      lastError = timedOut
        ? new Error("A charging station server timed out.")
        : error;

      console.warn(
        `Overpass endpoint failed (${endpoint}):`,
        lastError
      );
    } finally {
      clearTimeout(timer);

      if (signal) {
        signal.removeEventListener("abort", abortFromParent);
      }
    }
  }

  throw new Error(
    `${lastError?.message || "Charging station data is temporarily unavailable."} ` +
    "Your route is still available. Please try searching again later."
  );
}


function fetchOverpassStations(lat, lon, radius, signal) {
  return runOverpass([`(around:${radius},${lat},${lon})`], signal);
}

/* ---------- OPEN CHARGE MAP (optional, needs CONFIG.OCM_API_KEY) ---------- */

let lastChargerSource = "OpenStreetMap";

async function fetchOcmNear(lat, lon, radiusM, signal, maxResults = 200) {
  const url = new URL("https://api.openchargemap.io/v3/poi/");
  url.searchParams.set("output", "json");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set("distance", Math.max(1, radiusM / 1000));
  url.searchParams.set("distanceunit", "KM");
  url.searchParams.set("maxresults", maxResults);
  url.searchParams.set("compact", "false");
  url.searchParams.set("verbose", "false");
  url.searchParams.set("key", CONFIG.OCM_API_KEY);

  const response = await fetch(url.toString(), { signal, headers: { "Accept": "application/json" } });

  if (response.status === 401 || response.status === 403) {
    throw new Error("Open Charge Map rejected the API key. Check CONFIG.OCM_API_KEY in script.js.");
  }
  if (!response.ok) throw new Error(`Open Charge Map returned HTTP ${response.status}.`);

  const data = await response.json();
  return Array.isArray(data) ? data.map(normalizeOcm).filter(Boolean) : [];
}

function normalizeOcm(poi) {
  const info = poi.AddressInfo || {};
  const lat = Number(info.Latitude);
  const lon = Number(info.Longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const connections = Array.isArray(poi.Connections) ? poi.Connections : [];
  const socketKeys = new Set();
  let maxKw = 0;
  let socketCount = 0;
  let firstType = "";

  connections.forEach(connection => {
    const typeName = `${connection.ConnectionType?.FormalName || ""} ${connection.ConnectionType?.Title || ""}`.toLowerCase();
    if (!firstType) firstType = connection.ConnectionType?.Title || "";

    if (typeName.includes("chademo")) socketKeys.add("socket:chademo");
    else if (typeName.includes("ccs") && typeName.includes("type 1")) socketKeys.add("socket:ccs1");
    else if (typeName.includes("ccs")) socketKeys.add("socket:type2_combo");
    else if (typeName.includes("type 2") || typeName.includes("mennekes")) socketKeys.add("socket:type2");
    else if (typeName.includes("type 1") || typeName.includes("j1772")) socketKeys.add("socket:type1");

    maxKw = Math.max(maxKw, Number(connection.PowerKW) || 0);
    socketCount += Number(connection.Quantity) || 1;
  });

  const address = [info.AddressLine1, info.Town, info.StateOrProvince].filter(Boolean).join(", ");

  return {
    id: `ocm-${poi.ID}`,
    osmType: "ocm",
    osmId: poi.ID,
    name: info.Title || poi.OperatorInfo?.Title || "EV charging station",
    operator: poi.OperatorInfo?.Title || "Operator not listed",
    lat,
    lon,
    address: address || "Address not listed",
    socketCount,
    socketKeys: [...socketKeys],
    sockets: firstType,
    powerText: maxKw ? `${Math.round(maxKw)} kW` : "",
    access: poi.UsageType?.Title || "",
    openingHours: "",
    website: "",
    operational: poi.StatusType?.IsOperational ?? null
  };
}

/*
  Try each data source in order. Use the first one that returns stations.
  If one is unreachable, fall through to the next.
*/
async function firstUsefulResult(tasks, signal) {
  let emptyResult = null;
  let lastError = null;

  for (const task of tasks) {
    if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");

    try {
      const list = await task.run();

      if (list.length) {
        lastChargerSource = task.name;
        return list;
      }

      if (!emptyResult) {
        emptyResult = list;
        lastChargerSource = task.name;
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      console.warn(`${task.name} failed:`, error);
      lastError = error;
    }
  }

  if (emptyResult) return emptyResult;
  throw lastError || new Error("Charging station data is temporarily unavailable. Please try again.");
}

function fetchStationsNear(lat, lon, radiusM, signal) {
  const osm = {
    name: "OpenStreetMap",
    run: async () => (await fetchOverpassStations(lat, lon, radiusM, signal)).map(normalizeStation).filter(Boolean)
  };
  const ocm = {
    name: "Open Charge Map",
    run: () => fetchOcmNear(lat, lon, radiusM, signal)
  };

  return firstUsefulResult(CONFIG.OCM_API_KEY ? [ocm, osm] : [osm], signal);
}

function fetchStationsForTrip(plan, radiusMeters, endpointRadius, signal) {
  const { from, to, route } = plan;

  const osm = {
    name: "OpenStreetMap",
    run: async () => {
      const sampled = sampleForOverpass(route.dense, route.cumulative);
      const polyline = sampled.map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",");

      const raw = await runOverpass(
        [
          `(around:${endpointRadius},${from.lat},${from.lon})`,
          `(around:${endpointRadius},${to.lat},${to.lon})`,
          `(around:${radiusMeters},${polyline})`
        ],
        signal
      );

      return raw.map(normalizeStation).filter(Boolean);
    }
  };

  const ocm = {
    name: "Open Charge Map",
    run: async () => {
      const totalKm = route.cumulative[route.cumulative.length - 1] || 1;
      const radiusKm = radiusMeters / 1000;
      const count = Math.min(24, Math.max(2, Math.ceil(totalKm / (radiusKm * 1.6))));
      const spacing = totalKm / count;
      const circleKm = Math.min(40, Math.max(radiusKm * 1.5, spacing * 0.75));

      const points = [];
      for (let i = 0; i < count; i++) {
        const target = spacing * (i + 0.5);
        const index = route.cumulative.findIndex(value => value >= target);
        points.push(route.dense[index === -1 ? route.dense.length - 1 : index]);
      }

      const lists = await Promise.all([
        fetchOcmNear(from.lat, from.lon, endpointRadius, signal, 100),
        fetchOcmNear(to.lat, to.lon, endpointRadius, signal, 100),
        ...points.map(([lon, lat]) => fetchOcmNear(lat, lon, circleKm * 1000, signal, 100))
      ]);

      return lists.flat();
    }
  };

  return firstUsefulResult(CONFIG.OCM_API_KEY ? [ocm, osm] : [osm], signal);
}

function normalizeStation(element) {
  const tags = element.tags || {};
  const center = element.center || {};

  const lat = Number(element.lat ?? center.lat);
  const lon = Number(element.lon ?? center.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = tags.name || tags.operator || tags.brand || "EV charging station";
  const operator = tags.operator || tags.brand || "Operator not listed";

  const sockets =
    tags["socket:type2_combo"] ||
    tags["socket:type2"] ||
    tags["socket:ccs"] ||
    tags["socket:chademo"] ||
    tags["socket:type1"] ||
    tags["socket:tesla_supercharger"];

  const socketKeys = Object.keys(tags).filter(key => /^socket:[a-z0-9_]+$/.test(key));

  const socketCount = Object.entries(tags)
    .filter(([key, value]) => /^socket:[a-z0-9_]+$/.test(key) && Number(value) > 0)
    .reduce((total, [, value]) => total + Number(value), 0);

  const powerEntries = Object.entries(tags)
    .filter(([key, value]) => key.startsWith("socket:") && key.endsWith(":output") && value)
    .map(([, value]) => value);

  const powerText = powerEntries.length ? [...new Set(powerEntries)].join(", ") : "";

  const addressParts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"]
  ].filter(Boolean);

  const address = addressParts.join(", ") || tags.description || "Address not listed in OpenStreetMap";

  return {
    id: `${element.type}-${element.id}`,
    osmType: element.type,
    osmId: element.id,
    name,
    operator,
    lat,
    lon,
    address,
    socketCount,
    socketKeys,
    sockets: sockets ? String(sockets) : "",
    powerText,
    access: tags.access || "",
    openingHours: tags.opening_hours || "",
    website: tags.website || tags.url || ""
  };
}

function isConnectorCompatible(station) {
  const wanted = CONNECTOR_TAGS[profile.connector];
  if (!wanted || !station.socketKeys?.length) return false;
  return wanted.some(key => station.socketKeys.includes(key));
}

function stationPopupHTML(station, extra = "") {
  return `
    <div style="min-width:170px">
      <strong>${escapeHTML(station.name)}</strong><br>
      <span>${escapeHTML(station.operator)}</span><br>
      ${extra ? `<span>${extra}</span><br>` : ""}
      <a
        href="${googleMapsDirections(coordinatesForMaps(station.lat, station.lon))}"
        target="_blank"
        rel="noopener noreferrer"
      >Get directions ↗</a>
    </div>
  `;
}

/* ---------- STATIONS PAGE ---------- */

function renderStationMarkers(stations, focusMap = true) {
  if (!stationMap || !stationMarkers || !homeMap || !homeMarkers) return;

  stationMarkers.clearLayers();
  homeMarkers.clearLayers();

  const stationIcon = createStationIcon();

  stations.forEach(station => {
    const marker = L.marker([station.lat, station.lon], { icon: stationIcon, title: station.name });
    marker.bindPopup(stationPopupHTML(station));
    marker.on("click", () => selectStation(station.id, false));
    marker.addTo(stationMarkers);

    L.marker([station.lat, station.lon], { icon: stationIcon, title: station.name })
      .bindPopup(stationPopupHTML(station))
      .addTo(homeMarkers);
  });

  if (stations.length > 0 && focusMap) {
    const bounds = L.latLngBounds(stations.map(station => [station.lat, station.lon]));
    stationMap.fitBounds(bounds, { padding: [25, 25], maxZoom: 15 });
    homeMap.fitBounds(bounds, { padding: [25, 25], maxZoom: 13 });
  }
}

async function searchStations(location, radiusMeters) {
  const status = byId("stationStatus");
  const searchButton = byId("stationSearchButton");

  if (stationRequestController) stationRequestController.abort();

  stationRequestController = new AbortController();
  const controller = stationRequestController;

  searchButton.disabled = true;
  searchButton.textContent = "Searching…";
  status.classList.remove("error");
  status.textContent = "Finding the location and checking OpenStreetMap charging data…";

  try {
    let point;

    if (typeof location === "object" && Number.isFinite(location.lat) && Number.isFinite(location.lon)) {
      point = location;
    } else {
      point = await geocodeLocation(String(location), controller.signal);
    }

    lastSearchLocation = point;

    if (stationMap) stationMap.setView([point.lat, point.lon], 12);
    if (homeMap && lastStationResults.length === 0) homeMap.setView([point.lat, point.lon], 12);

    const rawStations = await fetchStationsNear(point.lat, point.lon, radiusMeters, controller.signal);

    const seen = new Set();

    const stations = rawStations
      .filter(station => {
        if (seen.has(station.id)) return false;
        seen.add(station.id);
        return true;
      })
      .map(station => ({
        ...station,
        distanceKm: haversineKm(point.lat, point.lon, station.lat, station.lon)
      }))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    lastStationResults = stations;
    selectedStationId = null;

    renderStationList(stations);
    renderStationMarkers(stations, true);

    setText("homeStationCount", stations.length);
    setText(
      "homeStationCaption",
      stations.length ? `Within approximately ${radiusMeters / 1000} km` : "No mapped chargers found nearby."
    );

    status.textContent = stations.length
      ? `Found ${stations.length} charging station(s) near ${point.label}. Source: ${lastChargerSource}.`
      : "No charging stations were found in this radius. Try a larger radius or another location.";
  } catch (error) {
    if (error.name === "AbortError") return;

    status.classList.add("error");
    status.textContent = error.message || "Station search failed. Please try again.";
    setText("stationCountLabel", "Could not load results.");
    showToast(error.message || "Could not search for charging stations.");
  } finally {
    if (stationRequestController === controller) {
      searchButton.disabled = false;
      searchButton.textContent = "Find stations ↗";
    }
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const radians = value => value * Math.PI / 180;

  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function connectorSummary(station) {
  const base = station.socketCount
    ? `${station.socketCount} connector(s) mapped`
    : station.sockets
      ? `Connector: ${station.sockets}`
      : "Connector details not listed";

  return station.powerText ? `${base} · Output: ${station.powerText}` : base;
}

function renderStationList(stations) {
  const list = byId("stationList");
  list.replaceChildren();

  setText("stationCountLabel", `${stations.length} station${stations.length === 1 ? "" : "s"} found`);

  if (!stations.length) {
    list.innerHTML = `
      <div class="empty-state small-empty">
        <div class="empty-symbol">ϟ</div>
        <h3>No stations found</h3>
        <p>Try a larger search radius or another location. Map data may be incomplete.</p>
      </div>`;
    return;
  }

  stations.forEach(station => {
    const card = document.createElement("article");
    card.className = "station-card";
    card.dataset.stationId = station.id;

    const distance = `${station.distanceKm.toFixed(1)} km away`;
    const badgeList = [];
    if (isConnectorCompatible(station)) {
      badgeList.push(`<span class="badge badge-lime">Fits your ${escapeHTML(profile.connector)}</span>`);
    }
    if (station.operational === false) {
      badgeList.push('<span class="badge badge-warn">Reported not operational</span>');
    }
    const compatible = badgeList.length ? `<div class="badge-row">${badgeList.join("")}</div>` : "";

    card.innerHTML = `
      <div class="station-card-symbol">ϟ</div>
      <div class="station-card-info">
        <h3>${escapeHTML(station.name)}</h3>
        ${compatible}
        <p>${escapeHTML(station.operator)} · ${escapeHTML(station.address)}</p>
        <div class="station-meta">${escapeHTML(distance)} · ${escapeHTML(connectorSummary(station))}</div>
        <div class="station-card-actions">
          <button type="button" data-action="show">Show on map</button>
          <a
            href="${googleMapsDirections(coordinatesForMaps(station.lat, station.lon))}"
            target="_blank"
            rel="noopener noreferrer"
          >Get directions ↗</a>
        </div>
      </div>
    `;

    card.querySelector('[data-action="show"]').addEventListener("click", () => {
      selectStation(station.id, true);
    });

    list.appendChild(card);
  });
}

function selectStation(stationId, openPopup = true) {
  const station = lastStationResults.find(item => item.id === stationId);
  if (!station || !stationMap) return;

  selectedStationId = stationId;

  document.querySelectorAll("#stationList .station-card").forEach(card => {
    card.classList.toggle("selected", card.dataset.stationId === stationId);
  });

  stationMap.setView([station.lat, station.lon], 16);

  if (openPopup && stationMarkers) {
    stationMarkers.eachLayer(marker => {
      const point = marker.getLatLng();

      if (Math.abs(point.lat - station.lat) < 0.000001 && Math.abs(point.lng - station.lon) < 0.000001) {
        marker.openPopup();
      }
    });
  }
}

function setupStationSearch() {
  byId("stationSearchForm").addEventListener("submit", event => {
    event.preventDefault();

    const location = byId("stationLocation").value.trim();
    const radius = Number(byId("stationRadius").value);

    if (!location) {
      showToast("Enter a city or address first.");
      return;
    }

    if (!Number.isFinite(radius) || radius <= 0) {
      showToast("Choose a valid search radius.");
      return;
    }

    searchStations(location, radius);
  });

  byId("stationUseLocation").addEventListener("click", async () => {
    const button = byId("stationUseLocation");
    button.disabled = true;
    button.textContent = "Locating…";

    try {
      const location = await locateUser();
      byId("stationLocation").value = CURRENT_LOCATION_LABEL;
      await searchStations(location, Number(byId("stationRadius").value));
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Use my location ◎";
    }
  });
}

/* =========================================================
   TRIP PLANNER: route, directions, chargers on the way
========================================================= */

const CONDITION_LABELS = { "0.9": "eco driving", "1": "normal driving", "1.2": "highway or AC", "1.35": "hills or heavy load" };

function setTripStatus(message, isError = false) {
  const status = byId("tripStatus");
  status.textContent = message;
  status.classList.toggle("error", isError);
}

/* --- Route geometry helpers --- */

// Insert points so that no two neighbouring points are further apart than maxKm.
function densifyRoute(coords, maxKm = 0.3) {
  const dense = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const distance = haversineKm(lat1, lon1, lat2, lon2);
    const pieces = Math.max(1, Math.ceil(distance / maxKm));

    for (let step = 0; step < pieces; step++) {
      const t = step / pieces;
      dense.push([lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t]);
    }
  }

  dense.push(coords[coords.length - 1]);
  return dense;
}

function cumulativeKm(coords) {
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative.push(
      cumulative[i - 1] + haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0])
    );
  }
  return cumulative;
}

// Nearest point on the route to (lat, lon): distance from the route and km travelled at that point.
function nearestOnRoute(lat, lon, coords, cumulative) {
  const kLat = 111.32;
  const kLon = 111.32 * Math.cos(lat * Math.PI / 180);
  const stride = Math.max(1, Math.floor(coords.length / 9000));

  let best = Infinity;
  let bestIndex = 0;

  for (let i = 0; i < coords.length; i += stride) {
    const dx = (coords[i][0] - lon) * kLon;
    const dy = (coords[i][1] - lat) * kLat;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  }

  return { distKm: Math.sqrt(best), routeKm: cumulative[bestIndex] };
}

// Evenly spaced points along the route for the Overpass polyline filter.
function sampleForOverpass(coords, cumulative, maxPoints = 110) {
  const totalKm = cumulative[cumulative.length - 1];
  const spacing = Math.max(0.8, totalKm / maxPoints);
  const points = [coords[0]];
  let nextAt = spacing;

  for (let i = 1; i < coords.length; i++) {
    if (cumulative[i] >= nextAt) {
      points.push(coords[i]);
      nextAt += spacing;
    }
  }

  const last = coords[coords.length - 1];
  if (points[points.length - 1] !== last) points.push(last);

  return points;
}

/* --- Routing --- */

async function fetchRoute(from, to, signal) {
  const url =
    `${CONFIG.OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}` +
    "?overview=full&geometries=geojson&steps=true&alternatives=false";

  let response;
  try {
    response = await fetch(url, { signal, headers: { "Accept": "application/json" } });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Could not reach the routing service. Check your connection and try again.");
  }

  if (!response.ok) {
    throw new Error(`Routing service returned HTTP ${response.status}. Please try again shortly.`);
  }

  const data = await response.json();

  if (data.code !== "Ok" || !data.routes?.length) {
    if (data.code === "NoRoute") {
      throw new Error("No drivable route was found between these two places.");
    }
    throw new Error("A route could not be calculated for these locations.");
  }

  const route = data.routes[0];
  const coords = route.geometry.coordinates;
  const dense = densifyRoute(coords);
  const cumulative = cumulativeKm(dense);

  return {
    distanceKm: route.distance / 1000,
    durationSec: route.duration,
    latlngs: coords.map(([lon, lat]) => [lat, lon]),
    dense,
    cumulative,
    steps: (route.legs || []).flatMap(leg => leg.steps || [])
  };
}

/* --- Chargers for the trip --- */

async function fetchTripStations(plan, radiusMeters, signal) {
  const { from, to, route } = plan;
  const endpointRadius = Math.max(CONFIG.ENDPOINT_RADIUS_M, radiusMeters);

  const raw = await fetchStationsForTrip(plan, radiusMeters, endpointRadius, signal);

  const seen = new Set();
  const total = route.cumulative[route.cumulative.length - 1] || 1;
  const scale = route.distanceKm / total;
  const routeSlackKm = radiusMeters / 1000 * 1.15;
  const endpointKm = endpointRadius / 1000;

  const stations = [];

  raw.forEach(station => {
    if (seen.has(station.id)) return;
    seen.add(station.id);

    const near = nearestOnRoute(station.lat, station.lon, route.dense, route.cumulative);
    const dStart = haversineKm(from.lat, from.lon, station.lat, station.lon);
    const dEnd = haversineKm(to.lat, to.lon, station.lat, station.lon);

    let group = null;
    if (dStart <= endpointKm) group = "start";
    else if (dEnd <= endpointKm) group = "end";
    else if (near.distKm <= routeSlackKm) group = "route";

    if (!group) return;

    stations.push({
      ...station,
      group,
      offRouteKm: near.distKm,
      routeKm: near.routeKm * scale,
      distFromStartKm: dStart,
      distFromEndKm: dEnd
    });
  });

  return stations;
}

/* --- Battery maths --- */

function calculateBattery(distanceKm) {
  const battery = clampNumber(profile.battery, 0, 100, 49);
  const fullRange = clampNumber(profile.fullRange, 1, 2000, 300);
  const reserve = clampNumber(CONFIG.RESERVE_PERCENT, 0, 60, 10);
  const factor = clampNumber(byId("tripConditions").value, 0.5, 2, 1);

  const kmPerPercent = fullRange / 100 / factor;
  const neededPercent = distanceKm / kmPerPercent;
  const remainingPercent = battery - neededPercent;
  const usableKm = Math.max(0, battery - reserve) * kmPerPercent;
  const remainingRange = Math.max(0, remainingPercent) * kmPerPercent;

  return { battery, fullRange, reserve, factor, kmPerPercent, neededPercent, remainingPercent, usableKm, remainingRange };
}

function chooseSuggestedStop(stations, calc, distanceKm) {
  const needsCharge = calc.remainingPercent < calc.reserve;
  if (!needsCharge || !stations.length) return null;

  // Furthest charger we can still reach, with a 5% safety margin on usable range.
  const reachable = stations.filter(station => station.routeKm <= calc.usableKm * 0.95);
  if (!reachable.length) return null;

  const ranked = reachable
    .map(station => ({ station, score: station.routeKm - station.offRouteKm * 3 + (isConnectorCompatible(station) ? 8 : 0) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0].station;
  // A charger right at the destination is not a mid-trip stop unless we truly need it there.
  if (best.group === "end" && distanceKm <= calc.usableKm) return null;

  return best;
}

/* --- Rendering --- */

function renderTripSummary() {
  const { route, calc, originText, destText, suggestedId, stations, chargerError } = lastPlan;

  byId("tripEmpty").classList.add("hidden");
  byId("tripResults").classList.remove("hidden");

  setText("tripDistance", route.distanceKm < 10 ? route.distanceKm.toFixed(1) : Math.round(route.distanceKm).toLocaleString());
  setText("tripDistanceLabel", `${originText} to ${destText}`);
  setText("tripDuration", formatDuration(route.durationSec));
  setText("tripNeeded", `${calc.neededPercent.toFixed(1)}%`);
  setText("tripStartBattery", `${calc.battery}%`);
  setText("tripEndBattery", `${Math.max(0, calc.remainingPercent).toFixed(1)}%`);
  setText("tripRemainingRange", formatKm(calc.remainingRange));

  const advice = byId("tripAdvice");
  const suggested = stations.find(station => station.id === suggestedId);
  const conditions = CONDITION_LABELS[String(calc.factor)] || "normal driving";
  const stopLine = suggested
    ? ` Suggested charging stop: ${suggested.name}, about ${formatDistanceKm(suggested.routeKm)} into the trip.`
    : "";

  if (calc.remainingPercent < 0) {
    advice.className = "trip-advice warning";
    advice.textContent =
      `This trip needs about ${calc.neededPercent.toFixed(1)}% battery (${conditions}), but you have ${calc.battery}%. You cannot complete it without charging.` +
      (suggested ? stopLine : " No mapped charger was found within your current range. Charge before you leave or choose a different route.");
  } else if (calc.remainingPercent < calc.reserve) {
    advice.className = "trip-advice warning";
    advice.textContent =
      `You would arrive with about ${calc.remainingPercent.toFixed(1)}%, below the ${calc.reserve}% safety buffer.` +
      (suggested ? stopLine : " Consider charging before you leave or along the way.");
  } else {
    advice.className = "trip-advice";
    advice.textContent =
      `You should arrive with about ${calc.remainingPercent.toFixed(1)}% (${conditions}). Keep a margin for traffic, weather and hills. This is an estimate, not a live vehicle reading.`;
  }

  if (chargerError) {
    advice.textContent += ` Charger search failed: ${chargerError}`;
  }
}

function drawTripOnMap() {
  if (!tripMap || !tripRouteLayer || !tripMarkerLayer || !lastPlan) return;

  const { route, from, to, stations, suggestedId } = lastPlan;

  tripRouteLayer.clearLayers();
  tripMarkerLayer.clearLayers();
  tripMarkerById.clear();

  L.polyline(route.latlngs, { color: "#b8ff50", weight: 12, opacity: 0.14, lineCap: "round" }).addTo(tripRouteLayer);
  L.polyline(route.latlngs, { color: "#b8ff50", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(tripRouteLayer);

  L.marker([from.lat, from.lon], { icon: createPinIcon("A"), title: "Start", zIndexOffset: 800 })
    .bindPopup(`<strong>Start</strong><br>${escapeHTML(lastPlan.originText)}`)
    .addTo(tripMarkerLayer);

  L.marker([to.lat, to.lon], { icon: createPinIcon("B"), title: "Destination", zIndexOffset: 800 })
    .bindPopup(`<strong>Destination</strong><br>${escapeHTML(lastPlan.destText)}`)
    .addTo(tripMarkerLayer);

  stations.forEach(station => {
    const suggested = station.id === suggestedId;
    const marker = L.marker([station.lat, station.lon], {
      icon: createStationIcon(suggested ? "recommended" : "default"),
      title: station.name,
      zIndexOffset: suggested ? 600 : 0
    });

    marker.bindPopup(
      stationPopupHTML(
        station,
        `${formatDistanceKm(station.routeKm)} into trip · ${formatDistanceKm(station.offRouteKm)} off route`
      )
    );
    marker.on("click", () => highlightTripStation(station.id, false));
    marker.addTo(tripMarkerLayer);
    tripMarkerById.set(station.id, marker);
  });

  fitTripBounds();
}

function fitTripBounds() {
  if (!tripMap || !lastPlan) return;
  const bounds = L.latLngBounds(lastPlan.route.latlngs);
  tripMap.fitBounds(bounds, { padding: [40, 40] });
}

function tripGroupLists() {
  const stations = lastPlan.stations;
  return {
    all: [...stations].sort((a, b) => a.routeKm - b.routeKm),
    start: stations.filter(s => s.group === "start").sort((a, b) => a.distFromStartKm - b.distFromStartKm),
    route: stations.filter(s => s.group === "route").sort((a, b) => a.routeKm - b.routeKm),
    end: stations.filter(s => s.group === "end").sort((a, b) => a.distFromEndKm - b.distFromEndKm)
  };
}

function renderTripTabs() {
  const groups = tripGroupLists();
  const tabs = [
    ["all", "All", groups.all.length],
    ["start", "Near start", groups.start.length],
    ["route", "Along route", groups.route.length],
    ["end", "Near destination", groups.end.length]
  ];

  const row = byId("tripTabs");
  row.replaceChildren();

  tabs.forEach(([key, label, count]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab${activeTripTab === key ? " active" : ""}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(activeTripTab === key));
    button.textContent = `${label} (${count})`;
    button.addEventListener("click", () => {
      activeTripTab = key;
      renderTripTabs();
      renderTripStationList();
    });
    row.appendChild(button);
  });
}

function stationBadges(station) {
  const { calc, suggestedId } = lastPlan;
  const badges = [];

  if (station.id === suggestedId) badges.push('<span class="badge badge-teal">Suggested stop</span>');
  if (isConnectorCompatible(station)) badges.push(`<span class="badge badge-lime">Fits your ${escapeHTML(profile.connector)}</span>`);
  if (station.operational === false) badges.push('<span class="badge badge-warn">Reported not operational</span>');

  if (station.routeKm <= calc.usableKm * 0.95) {
    badges.push('<span class="badge badge-muted">Reachable on current charge</span>');
  } else {
    badges.push('<span class="badge badge-warn">Beyond current range</span>');
  }

  return `<div class="badge-row">${badges.join("")}</div>`;
}

function stationPositionText(station) {
  if (station.group === "start") return `${formatDistanceKm(station.distFromStartKm)} from your start`;
  if (station.group === "end") return `${formatDistanceKm(station.distFromEndKm)} from your destination`;
  return `${formatDistanceKm(station.routeKm)} into the trip · ${formatDistanceKm(station.offRouteKm)} off route`;
}

function renderTripStationList() {
  const list = byId("tripStationList");
  list.replaceChildren();

  const stations = tripGroupLists()[activeTripTab];

  if (!stations.length) {
    list.innerHTML = `
      <div class="empty-state small-empty">
        <div class="empty-symbol">ϟ</div>
        <h3>No chargers in this group</h3>
        <p>Try a wider distance from the route. OpenStreetMap may not list every charger.</p>
      </div>`;
    return;
  }

  const { from, to, suggestedId } = lastPlan;
  const fromText = coordinatesForMaps(from.lat, from.lon);
  const toText = coordinatesForMaps(to.lat, to.lon);

  stations.forEach(station => {
    const card = document.createElement("article");
    card.className = `station-card${station.id === suggestedId ? " recommended" : ""}`;
    card.dataset.stationId = station.id;

    const stationText = coordinatesForMaps(station.lat, station.lon);
    const viaLink = station.group === "route"
      ? `<a href="${googleMapsRoute({ origin: fromText, destination: toText, waypoint: stationText })}" target="_blank" rel="noopener noreferrer">Navigate with this stop ↗</a>`
      : `<a href="${googleMapsDirections(stationText)}" target="_blank" rel="noopener noreferrer">Get directions ↗</a>`;

    card.innerHTML = `
      <div class="station-card-symbol">ϟ</div>
      <div class="station-card-info">
        <h3>${escapeHTML(station.name)}</h3>
        ${stationBadges(station)}
        <p>${escapeHTML(station.operator)} · ${escapeHTML(station.address)}</p>
        <div class="station-meta">${escapeHTML(stationPositionText(station))}<br>${escapeHTML(connectorSummary(station))}</div>
        <div class="station-card-actions">
          <button type="button" data-action="show">Show on map</button>
          ${viaLink}
        </div>
      </div>
    `;

    card.querySelector('[data-action="show"]').addEventListener("click", () => {
      highlightTripStation(station.id, true);
    });

    list.appendChild(card);
  });
}

function highlightTripStation(stationId, pan = true) {
  document.querySelectorAll("#tripStationList .station-card").forEach(card => {
    card.classList.toggle("selected", card.dataset.stationId === stationId);
  });

  const marker = tripMarkerById.get(stationId);
  if (!marker || !tripMap) return;

  if (pan) {
    tripMap.setView(marker.getLatLng(), Math.max(tripMap.getZoom(), 14));
    byId("tripMap").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  marker.openPopup();
}

function maneuverIcon(step) {
  const { type, modifier } = step.maneuver || {};

  if (type === "arrive") return "⌖";
  if (type === "depart") return "↑";
  if (type === "roundabout" || type === "rotary" || type === "roundabout turn") return "↻";

  switch (modifier) {
    case "left": return "↰";
    case "right": return "↱";
    case "sharp left": return "↲";
    case "sharp right": return "↳";
    case "slight left": return "↖";
    case "slight right": return "↗";
    case "uturn": return "↶";
    default: return "↑";
  }
}

function maneuverText(step) {
  const { type, modifier, exit } = step.maneuver || {};
  const road = step.name ? ` onto ${step.name}` : "";
  const on = step.name ? ` on ${step.name}` : "";

  switch (type) {
    case "depart":
      return step.name ? `Start on ${step.name}` : "Start driving";
    case "arrive":
      return "Arrive at your destination";
    case "turn":
      return `Turn ${modifier || "ahead"}${road}`;
    case "end of road":
      return `At the end of the road, turn ${modifier || "ahead"}${road}`;
    case "new name":
      return `Continue${road || " straight"}`;
    case "continue":
      return modifier && modifier !== "straight" ? `Continue ${modifier}${on}` : `Continue straight${on}`;
    case "merge":
      return `Merge ${modifier || ""}${road}`.replace(/\s+/g, " ").trim();
    case "on ramp":
      return `Take the ramp${modifier ? ` on the ${modifier.replace("slight ", "")}` : ""}${road}`;
    case "off ramp":
      return `Take the exit${modifier ? ` on the ${modifier.replace("slight ", "")}` : ""}${road}`;
    case "fork":
      return `Keep ${modifier || "straight"} at the fork${road}`;
    case "roundabout":
    case "rotary":
      return exit
        ? `At the roundabout, take exit ${exit}${road}`
        : `Enter the roundabout${road}`;
    case "roundabout turn":
      return `At the roundabout, turn ${modifier || "ahead"}${road}`;
    case "exit roundabout":
    case "exit rotary":
      return `Exit the roundabout${road}`;
    default:
      return `Continue${road}`;
  }
}

function renderDirections() {
  const { route } = lastPlan;
  const list = byId("tripSteps");
  list.replaceChildren();

  const steps = route.steps.filter(step => step.maneuver);

  setText("tripStepsMeta", `${steps.length} steps · ${formatDistanceKm(route.distanceKm)} · ${formatDuration(route.durationSec)}`);

  if (!steps.length) {
    const item = document.createElement("li");
    item.className = "step-item";
    item.innerHTML = '<div class="step-text">No step-by-step directions are available for this route.</div>';
    list.appendChild(item);
    return;
  }

  steps.forEach(step => {
    const item = document.createElement("li");
    item.className = "step-item";
    item.innerHTML = `
      <div class="step-icon">${maneuverIcon(step)}</div>
      <div class="step-text">${escapeHTML(maneuverText(step))}</div>
      <div class="step-dist">${step.maneuver.type === "arrive" ? "" : escapeHTML(formatDistanceKm(step.distance / 1000))}</div>
    `;

    item.style.cursor = "pointer";
    item.addEventListener("click", () => {
      const [lon, lat] = step.maneuver.location;
      tripMap?.setView([lat, lon], 16);
    });

    list.appendChild(item);
  });
}

function renderTripStationNote() {
  const groups = tripGroupLists();
  const total = lastPlan.stations.length;

  if (lastPlan.chargerError) {
    setText("tripStationNote", "Charger search failed. The route is still available.");
    return;
  }

  setText(
    "tripStationNote",
    total
      ? `${total} charger${total === 1 ? "" : "s"}: ${groups.start.length} near start, ${groups.route.length} along route, ${groups.end.length} near destination.`
      : "No mapped chargers were found for this trip. Try a wider distance from the route."
  );
}

function renderAllTripResults() {
  renderTripSummary();
  drawTripOnMap();
  renderTripTabs();
  renderTripStationList();
  renderTripStationNote();
  renderDirections();
  byId("tripDetails").classList.remove("hidden");
}

// Called when vehicle settings change, the reserve or the driving style changes.
function refreshPlanForProfile() {
  if (!lastPlan) return;

  const calc = calculateBattery(lastPlan.route.distanceKm);
  const suggested = chooseSuggestedStop(lastPlan.stations, calc, lastPlan.route.distanceKm);

  lastPlan.calc = calc;
  lastPlan.suggestedId = suggested ? suggested.id : null;

  renderAllTripResults();
}

/* --- Planning flow --- */

function currentInputKey() {
  return `${byId("tripOrigin").value.trim()}|${byId("tripDestination").value.trim()}`;
}

async function planTrip() {
  const originText = byId("tripOrigin").value.trim();
  const destText = byId("tripDestination").value.trim();

  if (!originText || !destText) {
    showToast("Enter both a starting point and a destination.");
    return;
  }

  if (tripController) tripController.abort();
  tripController = new AbortController();
  const controller = tripController;
  const signal = controller.signal;

  const submit = byId("tripSubmit");
  submit.disabled = true;
  submit.firstChild.textContent = "Planning… ";
  setTripStatus("Finding your start and destination…");

  try {
    // 1. Locations (Nominatim asks for at most one request per second).
    let from;
    if (originOverride && originText === CURRENT_LOCATION_LABEL) {
      from = { ...originOverride, label: CURRENT_LOCATION_LABEL };
    } else {
      from = await geocodeLocation(originText, signal);
      await sleep(1100);
    }
    const to = await geocodeLocation(destText, signal);

    // 2. Route and directions.
    setTripStatus("Calculating the route…");
    const route = await fetchRoute(from, to, signal);

    const plan = {
      from,
      to,
      originText,
      destText,
      route,
      calc: calculateBattery(route.distanceKm),
      stations: [],
      suggestedId: null,
      chargerError: "",
      inputKey: currentInputKey()
    };

    lastPlan = plan;
    activeTripTab = "all";
    setLogTripButton(false);
    renderAllTripResults();
    byId("tripMap").scrollIntoView({ behavior: "smooth", block: "nearest" });

    // 3. Chargers near the start, along the route and near the destination.
    setTripStatus("Searching for chargers near your start, along the route and near your destination…");

    try {
      plan.stations = await fetchTripStations(plan, Number(byId("tripRadius").value), signal);
      const suggested = chooseSuggestedStop(plan.stations, plan.calc, route.distanceKm);
      plan.suggestedId = suggested ? suggested.id : null;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      plan.chargerError = error.message || "Charger data is unavailable.";
    }

    if (lastPlan === plan) renderAllTripResults();

    if (plan.chargerError) {
      setTripStatus(`Route ready. ${plan.chargerError}`, true);
    } else {
      setTripStatus(`Route ready: ${formatDistanceKm(route.distanceKm)}, ${formatDuration(route.durationSec)}. Found ${plan.stations.length} charger(s).`);
    }
  } catch (error) {
    if (error.name === "AbortError") return;
    setTripStatus(error.message || "Could not plan this trip. Please try again.", true);
    showToast(error.message || "Could not plan this trip.");
  } finally {
    if (tripController === controller) {
      submit.disabled = false;
      submit.firstChild.textContent = "Plan route and find chargers ";
    }
  }
}

function setupTripPlanner() {
  byId("tripForm").addEventListener("submit", event => {
    event.preventDefault();
    planTrip();
  });

  byId("tripOrigin").addEventListener("input", () => {
    if (byId("tripOrigin").value !== CURRENT_LOCATION_LABEL) originOverride = null;
  });

  byId("tripLocate").addEventListener("click", async () => {
    const button = byId("tripLocate");
    button.disabled = true;
    button.textContent = "Locating…";

    try {
      const location = await locateUser();
      originOverride = { lat: location.lat, lon: location.lon };
      byId("tripOrigin").value = CURRENT_LOCATION_LABEL;
      showToast("Starting point set to your current location.");
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "Use GPS";
    }
  });

  // Changing the driving style re-runs the battery maths instantly.
  byId("tripConditions").addEventListener("change", refreshPlanForProfile);

  byId("openTripMap").addEventListener("click", () => {
    const originText = byId("tripOrigin").value.trim();
    const destText = byId("tripDestination").value.trim();

    if (!originText || !destText) {
      showToast("Enter both a starting point and destination.");
      return;
    }

    if (lastPlan && lastPlan.inputKey === currentInputKey()) {
      openExternal(googleMapsRoute({
        origin: coordinatesForMaps(lastPlan.from.lat, lastPlan.from.lon),
        destination: coordinatesForMaps(lastPlan.to.lat, lastPlan.to.lon),
        waypoint: lastPlan.suggestedId
          ? (() => {
              const stop = lastPlan.stations.find(s => s.id === lastPlan.suggestedId);
              return stop ? coordinatesForMaps(stop.lat, stop.lon) : "";
            })()
          : ""
      }));
      return;
    }

    const origin = originOverride && originText === CURRENT_LOCATION_LABEL
      ? coordinatesForMaps(originOverride.lat, originOverride.lon)
      : originText;

    openExternal(googleMapsDirections(destText, origin));
  });

  byId("findTripChargers").addEventListener("click", () => {
    const destination = byId("tripDestination").value.trim();

    if (destination) byId("stationLocation").value = destination;

    showPage("stations");

    if (destination) searchStations(destination, Number(byId("stationRadius").value));
  });
}

/* =========================================================
   WEEKLY ANALYSIS: trips and charging history (saved in this browser)
========================================================= */

const ACTIVITY_KEY = "voltly_activity_v1";
const DAY_MS = 24 * 60 * 60 * 1000;

let activity = loadActivity();
let placesLayer = null;
let placesSignature = "";

function loadActivity() {
  const empty = { trips: [], charges: [] };

  try {
    const parsed = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "null");
    if (!parsed) return empty;

    const trips = (Array.isArray(parsed.trips) ? parsed.trips : [])
      .filter(trip => trip && Number.isFinite(trip.ts) && Number.isFinite(trip.km))
      .map(trip => ({
        ...trip,
        from: String(trip.from || "Unknown place"),
        to: String(trip.to || "Unknown place"),
        usedPct: Number.isFinite(trip.usedPct) ? trip.usedPct : 0
      }));

    const charges = (Array.isArray(parsed.charges) ? parsed.charges : [])
      .filter(charge => charge && Number.isFinite(charge.ts) && Number.isFinite(charge.fromPct) && Number.isFinite(charge.toPct))
      .map(charge => ({ ...charge, place: String(charge.place || "Unknown place") }));

    return { trips, charges };
  } catch (error) {
    console.warn("Could not load activity history.", error);
    return empty;
  }
}

function saveActivity() {
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
    return true;
  } catch (error) {
    console.warn("Could not save activity history.", error);
    showToast("Could not save history in this browser.");
    return false;
  }
}

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function shortPlace(label, fallback = "Unknown place") {
  const text = String(label || "").split(",")[0].trim();
  return text || fallback;
}

function dayKey(date) {
  const pad = number => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toLocalInputValue(date) {
  const pad = number => String(number).padStart(2, "0");
  return `${dayKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getWeekDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = [];
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    days.push({
      date,
      key: dayKey(date),
      label: date.toLocaleDateString(undefined, { weekday: "short" }),
      longLabel: date.toLocaleDateString(undefined, { weekday: "long" }),
      isToday: offset === 0
    });
  }
  return days;
}

function computeWeek() {
  const days = getWeekDays();
  const startMs = days[0].date.getTime();
  const endDate = new Date(days[6].date);
  endDate.setDate(endDate.getDate() + 1);
  const endMs = endDate.getTime();

  const inWeek = item => item.ts >= startMs && item.ts < endMs;
  const trips = activity.trips.filter(inWeek).sort((a, b) => b.ts - a.ts);
  const charges = activity.charges.filter(inWeek).sort((a, b) => b.ts - a.ts);

  const perDay = new Map(days.map(day => [day.key, { km: 0, used: 0, added: 0 }]));

  trips.forEach(trip => {
    const row = perDay.get(dayKey(new Date(trip.ts)));
    if (row) {
      row.km += trip.km;
      row.used += trip.usedPct;
    }
  });

  charges.forEach(charge => {
    const row = perDay.get(dayKey(new Date(charge.ts)));
    if (row) row.added += Math.max(0, charge.toPct - charge.fromPct);
  });

  const places = new Map();
  trips.forEach(trip => {
    const key = trip.to.toLowerCase();
    const entry = places.get(key) || { name: trip.to, visits: 0, km: 0, lat: trip.toLat, lon: trip.toLon };
    entry.visits += 1;
    entry.km += trip.km;
    places.set(key, entry);
  });

  const chargePlaces = new Map();
  charges.forEach(charge => {
    const key = charge.place.toLowerCase();
    const entry = chargePlaces.get(key) || { name: charge.place, sessions: 0, added: 0 };
    entry.sessions += 1;
    entry.added += Math.max(0, charge.toPct - charge.fromPct);
    chargePlaces.set(key, entry);
  });

  return {
    days,
    perDay,
    trips,
    charges,
    places: [...places.values()].sort((a, b) => b.visits - a.visits || b.km - a.km),
    chargePlaces: [...chargePlaces.values()].sort((a, b) => b.added - a.added),
    totalKm: trips.reduce((sum, trip) => sum + trip.km, 0),
    totalUsed: trips.reduce((sum, trip) => sum + trip.usedPct, 0),
    totalAdded: charges.reduce((sum, charge) => sum + Math.max(0, charge.toPct - charge.fromPct), 0)
  };
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function renderBarChart(containerId, days, series) {
  const container = byId(containerId);
  if (!container) return;

  const max = Math.max(1, ...series.flatMap(item => item.values));
  container.replaceChildren();

  days.forEach((day, index) => {
    const column = document.createElement("div");
    column.className = `bar-col${day.isToday ? " today" : ""}`;

    const bars = series.map(item => {
      const value = item.values[index];
      const ratio = value > 0 ? Math.max(0.04, value / max) : 0;
      const tip = `${item.label}, ${day.longLabel}: ${Math.round(value)} ${item.unit}`;

      return `
        <div class="bar-wrap">
          <span class="bar-val">${value > 0 ? Math.round(value) : ""}</span>
          <div class="bar ${item.className}${value > 0 ? "" : " zero"}" style="--h:${ratio.toFixed(3)}" title="${escapeHTML(tip)}"></div>
        </div>`;
    }).join("");

    column.innerHTML = `<div class="bar-plot">${bars}</div><span class="bar-label">${escapeHTML(day.label)}</span>`;
    container.appendChild(column);
  });
}

function renderRankList(listId, items, emptyText) {
  const list = byId(listId);
  list.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "rank-empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }

  const max = Math.max(...items.map(item => item.score), 1);

  items.slice(0, 5).forEach(item => {
    const row = document.createElement("li");
    row.className = "rank-item";
    row.innerHTML = `
      <div class="rank-top"><strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(item.value)}</span></div>
      <div class="rank-bar"><div style="width:${Math.max(6, item.score / max * 100).toFixed(0)}%"></div></div>
      <div class="rank-meta">${escapeHTML(item.meta)}</div>`;
    list.appendChild(row);
  });
}

function renderActivityList(week) {
  const list = byId("activityList");
  list.replaceChildren();

  const events = [
    ...week.trips.map(trip => ({ ts: trip.ts, type: "trip", trip })),
    ...week.charges.map(charge => ({ ts: charge.ts, type: "charge", charge }))
  ].sort((a, b) => b.ts - a.ts).slice(0, 7);

  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "rank-empty";
    empty.textContent = "Nothing logged yet.";
    list.appendChild(empty);
    return;
  }

  events.forEach(event => {
    const when = new Date(event.ts).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    const item = document.createElement("li");
    item.className = "step-item";

    if (event.type === "trip") {
      const { trip } = event;
      item.innerHTML = `
        <div class="step-icon">↗</div>
        <div class="step-text"><strong>${escapeHTML(trip.from)} to ${escapeHTML(trip.to)}</strong><small>${escapeHTML(when)}</small></div>
        <div class="step-dist">${escapeHTML(formatKm(trip.km))}<br>${trip.usedPct.toFixed(0)}% used</div>`;
    } else {
      const { charge } = event;
      const added = Math.max(0, charge.toPct - charge.fromPct);
      item.innerHTML = `
        <div class="step-icon charge">ϟ</div>
        <div class="step-text"><strong>${escapeHTML(charge.place)}</strong><small>${escapeHTML(when)}, ${Math.round(charge.fromPct)}% to ${Math.round(charge.toPct)}%</small></div>
        <div class="step-dist">+${Math.round(added)}%</div>`;
    }

    list.appendChild(item);
  });
}

function renderPlacesOnMap(week) {
  if (!homeMap || !placesLayer) return;

  placesLayer.clearLayers();

  const located = week.places.filter(place => Number.isFinite(place.lat) && Number.isFinite(place.lon));

  located.forEach(place => {
    L.marker([place.lat, place.lon], { icon: createPlaceIcon(), title: place.name })
      .bindPopup(`<strong>${escapeHTML(place.name)}</strong><br>${plural(place.visits, "visit")} this week<br>${formatKm(place.km)} driven to get here`)
      .addTo(placesLayer);
  });

  const signature = located.map(place => `${place.lat},${place.lon}`).join("|");

  if (located.length && signature !== placesSignature && lastStationResults.length === 0) {
    const bounds = L.latLngBounds(located.map(place => [place.lat, place.lon]));
    homeMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
  }

  placesSignature = signature;
}

function renderWeekly() {
  if (!byId("weekSection")) return;

  const week = computeWeek();
  const hasData = week.trips.length > 0 || week.charges.length > 0;

  const formatDay = date => date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  setText("weekRange", `${formatDay(week.days[0].date)} to ${formatDay(week.days[6].date)}. Where you drove and how much you charged.`);

  byId("weekEmpty").classList.toggle("hidden", hasData);
  byId("weekContent").classList.toggle("hidden", !hasData);

  renderPlacesOnMap(week);
  if (!hasData) return;

  const tripCount = week.trips.length;
  const sessionCount = week.charges.length;

  setText("weekDistance", Math.round(week.totalKm).toLocaleString());
  setText("weekTrips", plural(tripCount, "trip"));
  setText("weekUsed", Math.round(week.totalUsed));
  setText("weekUsedNote", tripCount ? `About ${(week.totalUsed / tripCount).toFixed(0)}% per trip` : "No trips yet");
  setText("weekCharged", Math.round(week.totalAdded));
  setText("weekSessions", sessionCount ? `${plural(sessionCount, "session")}, avg +${Math.round(week.totalAdded / sessionCount)}%` : "No sessions yet");
  setText("weekPlaces", week.places.length);
  setText("weekPlacesNote", week.places[0] ? `Most visited: ${week.places[0].name}` : "No trips yet");

  const travelSentence = tripCount
    ? `You travelled ${formatKm(week.totalKm)} on ${plural(tripCount, "trip")} and used about ${Math.round(week.totalUsed)}% of your battery.`
    : "No trips were logged this week.";
  const chargeSentence = sessionCount
    ? `You added ${Math.round(week.totalAdded)}% across ${plural(sessionCount, "charging session")}.`
    : "No charging sessions were logged.";

  let busiest = "";
  if (week.totalKm > 0) {
    const top = week.days
      .map(day => ({ day, km: week.perDay.get(day.key).km }))
      .sort((a, b) => b.km - a.km)[0];
    busiest = ` Your busiest day was ${top.day.longLabel} (${formatKm(top.km)}).`;
  }

  setText("weekSummary", `${travelSentence} ${chargeSentence}${busiest}`);

  renderBarChart("chartDistance", week.days, [
    { label: "Distance", unit: "km", className: "bar-lime", values: week.days.map(day => week.perDay.get(day.key).km) }
  ]);

  renderBarChart("chartBattery", week.days, [
    { label: "Battery used", unit: "%", className: "bar-amber", values: week.days.map(day => week.perDay.get(day.key).used) },
    { label: "Charge added", unit: "%", className: "bar-teal", values: week.days.map(day => week.perDay.get(day.key).added) }
  ]);

  renderRankList(
    "placesList",
    week.places.map(place => ({
      name: place.name,
      value: plural(place.visits, "visit"),
      meta: `${formatKm(place.km)} driven to get here`,
      score: place.visits * 1000 + place.km
    })),
    "No trips logged yet."
  );

  renderRankList(
    "chargePlacesList",
    week.chargePlaces.map(place => ({
      name: place.name,
      value: `+${Math.round(place.added)}%`,
      meta: plural(place.sessions, "charging session"),
      score: place.added
    })),
    "No charging sessions logged yet."
  );

  renderActivityList(week);
}

/* --- Logging trips and charges --- */

function setLogTripButton(logged) {
  const button = byId("logTripButton");
  if (!button) return;

  button.disabled = logged;
  button.textContent = logged ? "Trip logged ✓" : "Mark trip as travelled ✓";
}

function logCurrentTrip() {
  if (!lastPlan || lastPlan.logged) return;

  const { route, calc, from, to, originText, destText } = lastPlan;

  if (calc.remainingPercent < 0) {
    showToast("This trip needs more battery than you have. Charge first, then log it.");
    return;
  }

  activity.trips.push({
    id: newId(),
    ts: Date.now(),
    from: shortPlace(from.label, shortPlace(originText)),
    to: shortPlace(to.label, shortPlace(destText)),
    fromLat: from.lat,
    fromLon: from.lon,
    toLat: to.lat,
    toLon: to.lon,
    km: route.distanceKm,
    usedPct: Math.min(calc.battery, calc.neededPercent),
    minutes: route.durationSec / 60
  });

  if (!saveActivity()) return;

  lastPlan.logged = true;
  setLogTripButton(true);

  profile.battery = Math.max(0, Math.round(calc.remainingPercent));
  saveProfile();
  syncProfileUI();
  renderWeekly();

  showToast(`Trip logged. Battery updated to about ${profile.battery}%.`);
}

function setupWeekly() {
  const form = byId("chargeForm");
  const toggle = byId("toggleChargeForm");
  if (!form || !toggle) return;

  const openForm = () => {
    const from = Math.round(profile.battery);
    byId("chargeFrom").value = from;
    byId("chargeTo").value = from < 80 ? 80 : 100;
    byId("chargeWhen").value = toLocalInputValue(new Date());
    setText("chargeFormStatus", "");
    form.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true");
    byId("chargePlace").focus();
  };

  const closeForm = () => {
    form.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", () => {
    if (form.classList.contains("hidden")) openForm();
    else closeForm();
  });

  byId("cancelCharge").addEventListener("click", closeForm);

  form.addEventListener("submit", event => {
    event.preventDefault();

    const place = byId("chargePlace").value.trim();
    const fromPct = Number(byId("chargeFrom").value);
    const toPct = Number(byId("chargeTo").value);
    const ts = new Date(byId("chargeWhen").value).getTime();
    const status = byId("chargeFormStatus");

    status.style.color = "";

    if (!place) {
      status.textContent = "Enter where you charged.";
      return;
    }

    if (!Number.isFinite(fromPct) || !Number.isFinite(toPct) || fromPct < 0 || toPct > 100 || toPct <= fromPct) {
      status.textContent = "Enter battery levels between 0 and 100, with the after level higher than the before level.";
      return;
    }

    if (!Number.isFinite(ts) || ts > Date.now() + 5 * 60 * 1000) {
      status.textContent = "Choose a date and time that is not in the future.";
      return;
    }

    activity.charges.push({ id: newId(), ts, place, fromPct, toPct });
    if (!saveActivity()) return;

    // Only treat it as the current battery level if the charge just happened.
    const justNow = Date.now() - ts < 3 * 60 * 60 * 1000;
    if (justNow) {
      profile.battery = Math.round(toPct);
      saveProfile();
      syncProfileUI();
    }

    byId("chargePlace").value = "";
    closeForm();
    renderWeekly();
    showToast(justNow ? `Charge saved. Battery updated to ${Math.round(toPct)}%.` : "Charge saved.");
  });

  byId("clearActivity").addEventListener("click", () => {
    if (!window.confirm("Remove all trips and charging sessions saved in this browser?")) return;

    activity = { trips: [], charges: [] };
    saveActivity();
    renderWeekly();
    showToast("History cleared.");
  });

  byId("loadSampleWeek").addEventListener("click", loadSampleWeek);
  byId("logTripButton").addEventListener("click", logCurrentTrip);
}

// Demo data so the analysis can be previewed before real trips are logged.
function loadSampleWeek() {
  const now = Date.now();
  const at = (daysAgo, hour, minute = 0) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, minute, 0, 0);
    return Math.min(date.getTime(), now - 10 * 60 * 1000);
  };

  const place = (name, lat, lon) => ({ name, lat, lon });
  const perambur = place("Perambur", 13.1143, 80.2329);
  const central = place("Chennai Central", 13.0827, 80.2750);
  const guindy = place("Guindy", 13.0067, 80.2206);
  const mahabalipuram = place("Mahabalipuram", 12.6269, 80.1927);
  const sriperumbudur = place("Sriperumbudur", 12.9675, 79.9419);
  const pondicherry = place("Pondicherry", 11.9416, 79.8083);

  const trip = (daysAgo, hour, from, to, km, usedPct, minutes) => ({
    id: newId(),
    ts: at(daysAgo, hour),
    from: from.name,
    to: to.name,
    fromLat: from.lat,
    fromLon: from.lon,
    toLat: to.lat,
    toLon: to.lon,
    km,
    usedPct,
    minutes
  });

  activity.trips.push(
    trip(6, 9, perambur, central, 9, 3, 25),
    trip(5, 8, central, mahabalipuram, 58, 19, 80),
    trip(5, 18, mahabalipuram, central, 58, 19, 85),
    trip(4, 10, perambur, guindy, 18, 6, 45),
    trip(3, 9, guindy, sriperumbudur, 32, 11, 50),
    trip(3, 17, sriperumbudur, perambur, 38, 13, 60),
    trip(1, 7, perambur, pondicherry, 152, 51, 190),
    trip(1, 19, pondicherry, perambur, 152, 51, 195),
    trip(0, 9, perambur, central, 9, 3, 25)
  );

  activity.charges.push(
    { id: newId(), ts: at(5, 20), place: "Home charger, Perambur", fromPct: 28, toPct: 90 },
    { id: newId(), ts: at(3, 21), place: "Home charger, Perambur", fromPct: 45, toPct: 95 },
    { id: newId(), ts: at(1, 13), place: "Pondicherry fast charger", fromPct: 38, toPct: 78 },
    { id: newId(), ts: at(1, 22), place: "Home charger, Perambur", fromPct: 30, toPct: 85 }
  );

  saveActivity();
  renderWeekly();
  showToast("Sample week loaded. Clear history to remove it.");
}

/* ---------- INITIALIZATION ---------- */

function setupInitialStationSearch() {
  setText("homeStationCount", "—");
  setText("homeStationCaption", "Search to find nearby chargers.");
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  if (!location.protocol.startsWith("http")) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(error => {
      console.warn("Service worker was not registered.", error);
    });
  });
}

function initializeApp() {
  setupNavigation();
  setupVehicleForm();
  setupTripPlanner();
  setupStationSearch();

  setupWeekly();

  syncProfileUI();
  setupInitialStationSearch();
  initMaps();
  renderWeekly();

  byId("stationLocation").value = DEFAULT_LOCATION.label;

  registerServiceWorker();
}

document.addEventListener("DOMContentLoaded", initializeApp);
