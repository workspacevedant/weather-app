/**
 * app.js — Skyglass Weather Dashboard
 *
 * DATA FLOW (the full pipeline on every search):
 *
 *  1. User types a city name and hits Enter or clicks "Go"
 *  2. handleSearch() reads the input, validates it, calls getWeather()
 *  3. getWeather() calls geocodeCity() first
 *       → hits Open-Meteo Geocoding API with the city string
 *       → returns { name, country, latitude, longitude } or throws
 *  4. getWeather() passes lat/lon to fetchWeatherData()
 *       → hits Open-Meteo forecast API for current conditions
 *       → returns a normalised weather object or throws
 *  5. getWeather() calls renderWeather() with the combined result
 *       → updates the DOM and switches the card to the "content" state
 *  6. If anything throws at any step, showError() is called instead
 *       → switches the card to the "error" state with a human message
 */

'use strict';

// ─────────────────────────────────────────────
// API ENDPOINTS
// Both are free, open, and require zero API keys.
// ─────────────────────────────────────────────

const GEOCODING_API =
  'https://geocoding-api.open-meteo.com/v1/search';

const WEATHER_API =
  'https://api.open-meteo.com/v1/forecast';

// ─────────────────────────────────────────────
// WMO WEATHER INTERPRETATION CODES
// Open-Meteo returns a numeric `weathercode` (WMO standard).
// This map converts each code into a human label + emoji icon.
// Docs: https://open-meteo.com/en/docs#weathervariables
// ─────────────────────────────────────────────

const WMO_CODES = {
  0:  { label: 'Clear sky',            emoji: '☀️'  },
  1:  { label: 'Mainly clear',         emoji: '🌤️' },
  2:  { label: 'Partly cloudy',        emoji: '⛅'  },
  3:  { label: 'Overcast',             emoji: '☁️'  },
  45: { label: 'Foggy',                emoji: '🌫️' },
  48: { label: 'Icy fog',              emoji: '🌫️' },
  51: { label: 'Light drizzle',        emoji: '🌦️' },
  53: { label: 'Moderate drizzle',     emoji: '🌦️' },
  55: { label: 'Dense drizzle',        emoji: '🌧️' },
  61: { label: 'Slight rain',          emoji: '🌧️' },
  63: { label: 'Moderate rain',        emoji: '🌧️' },
  65: { label: 'Heavy rain',           emoji: '🌧️' },
  71: { label: 'Slight snow',          emoji: '🌨️' },
  73: { label: 'Moderate snow',        emoji: '❄️'  },
  75: { label: 'Heavy snow',           emoji: '❄️'  },
  77: { label: 'Snow grains',          emoji: '🌨️' },
  80: { label: 'Slight showers',       emoji: '🌦️' },
  81: { label: 'Moderate showers',     emoji: '🌧️' },
  82: { label: 'Violent showers',      emoji: '⛈️'  },
  85: { label: 'Slight snow showers',  emoji: '🌨️' },
  86: { label: 'Heavy snow showers',   emoji: '❄️'  },
  95: { label: 'Thunderstorm',         emoji: '⛈️'  },
  96: { label: 'Thunderstorm w/ hail', emoji: '⛈️'  },
  99: { label: 'Thunderstorm w/ hail', emoji: '⛈️'  },
};

// Fallback for any unknown code
const UNKNOWN_CONDITION = { label: 'Unknown conditions', emoji: '🌡️' };

// ─────────────────────────────────────────────
// DOM REFERENCES
// Grabbed once at startup — never query the DOM repeatedly.
// ─────────────────────────────────────────────

const cityInput      = document.getElementById('city-input');
const searchBtn      = document.getElementById('search-btn');

const emptyState     = document.getElementById('empty-state');
const weatherContent = document.getElementById('weather-content');
const errorState     = document.getElementById('error-state');
const errorMessage   = document.getElementById('error-message');

const cityNameEl     = document.getElementById('city-name');
const countryCodeEl  = document.getElementById('country-code');
const conditionEl    = document.getElementById('condition-text');
const iconWrapEl     = document.getElementById('weather-icon-wrap');
const tempValueEl    = document.getElementById('temp-value');
const humidityEl     = document.getElementById('humidity-value');
const windEl         = document.getElementById('wind-value');
const feelsLikeEl   = document.getElementById('feels-like-value');

// ─────────────────────────────────────────────
// STATE HELPERS
// Three mutually exclusive card states. Each helper
// hides the other two and shows only itself.
// ─────────────────────────────────────────────

function showEmpty() {
  emptyState.removeAttribute('hidden');
  weatherContent.setAttribute('hidden', '');
  errorState.setAttribute('hidden', '');
}

function showContent() {
  weatherContent.removeAttribute('hidden');
  emptyState.setAttribute('hidden', '');
  errorState.setAttribute('hidden', '');
}

function showError(message) {
  errorMessage.textContent = message;
  errorState.removeAttribute('hidden');
  emptyState.setAttribute('hidden', '');
  weatherContent.setAttribute('hidden', '');
}

// ─────────────────────────────────────────────
// LOADING STATE
// Disable the button and input while a fetch is in flight
// to prevent duplicate requests.
// ─────────────────────────────────────────────

function setLoading(isLoading) {
  searchBtn.disabled  = isLoading;
  cityInput.disabled  = isLoading;
  searchBtn.textContent = isLoading ? '…' : 'Go';
}

// ─────────────────────────────────────────────
// STEP 1: GEOCODING
// Converts a city name string into lat/lon coordinates.
// Returns the first (best-match) result from the API.
// Throws a descriptive Error if nothing is found.
// ─────────────────────────────────────────────

async function geocodeCity(cityName) {
  const url = `${GEOCODING_API}?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;

  const response = await fetch(url);

  // Check for network-level errors (e.g. no internet)
  if (!response.ok) {
    throw new Error(`Geocoding service error (HTTP ${response.status}). Try again.`);
  }

  const data = await response.json();

  // The API returns an empty `results` array when the city isn't found
  if (!data.results || data.results.length === 0) {
    throw new Error(`No city found for "${cityName}". Check the spelling and try again.`);
  }

  // Destructure only what we need from the first result
  const { name, country_code, latitude, longitude } = data.results[0];

  return { name, country: country_code, latitude, longitude };
}

// ─────────────────────────────────────────────
// STEP 2: WEATHER FETCH
// Takes lat/lon from geocoding and requests current
// weather from Open-Meteo's forecast endpoint.
// We request only the `current` fields we actually display.
// ─────────────────────────────────────────────

async function fetchWeatherData(latitude, longitude) {
  const params = new URLSearchParams({
    latitude,
    longitude,
    current: [
      'temperature_2m',        // air temp at 2 m above ground
      'apparent_temperature',  // "feels like"
      'relative_humidity_2m',  // humidity %
      'wind_speed_10m',        // wind at 10 m above ground
      'weathercode',           // WMO code for condition
    ].join(','),
    wind_speed_unit: 'kmh',
    timezone: 'auto',          // auto-detect timezone from coordinates
  });

  const url = `${WEATHER_API}?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Weather service error (HTTP ${response.status}). Try again.`);
  }

  const data = await response.json();
  const c = data.current; // shorthand for the current block

  // Return a clean, normalised object — no raw API shape leaking into the UI layer
  return {
    temperature:  Math.round(c.temperature_2m),
    feelsLike:    Math.round(c.apparent_temperature),
    humidity:     c.relative_humidity_2m,
    windSpeed:    Math.round(c.wind_speed_10m),
    weatherCode:  c.weathercode,
  };
}

// ─────────────────────────────────────────────
// STEP 3: RENDER
// Writes all the fetched data into the DOM,
// then switches the card to its "content" state.
// ─────────────────────────────────────────────

function renderWeather(location, weather) {
  // Resolve the WMO code → label + emoji (fallback if unknown)
  const condition = WMO_CODES[weather.weatherCode] ?? UNKNOWN_CONDITION;

  // ── Location ──
  cityNameEl.textContent    = location.name;
  countryCodeEl.textContent = location.country ?? '';

  // ── Condition icon (emoji rendered in a styled span) ──
  iconWrapEl.innerHTML = `<span class="condition-emoji" role="img" aria-label="${condition.label}">${condition.emoji}</span>`;

  conditionEl.textContent = condition.label;

  // ── Temperature ──
  tempValueEl.textContent = weather.temperature;

  // ── Stats ──
  humidityEl.textContent  = `${weather.humidity}%`;
  windEl.textContent      = `${weather.windSpeed} km/h`;
  feelsLikeEl.textContent = `${weather.feelsLike}°C`;

  // Switch card state to show the content panel
  showContent();
}

// ─────────────────────────────────────────────
// ORCHESTRATOR
// Runs the full pipeline: geocode → fetch → render.
// A single try/catch covers every failure mode across
// all three steps — any thrown Error lands in showError().
// ─────────────────────────────────────────────

async function getWeather(cityName) {
  setLoading(true);

  try {
    // Step 1 — city string → coordinates
    const location = await geocodeCity(cityName);

    // Step 2 — coordinates → weather data
    const weather = await fetchWeatherData(location.latitude, location.longitude);

    // Step 3 — data → DOM
    renderWeather(location, weather);

  } catch (error) {
    // Show the error's message in the card (never log-only)
    showError(error.message);
  } finally {
    // Always re-enable the UI, whether success or failure
    setLoading(false);
  }
}

// ─────────────────────────────────────────────
// SEARCH HANDLER
// Shared by the button click and the Enter key listener.
// Guards against blank / whitespace-only input.
// ─────────────────────────────────────────────

function handleSearch() {
  const query = cityInput.value.trim();

  if (!query) {
    // Politely prompt the user rather than silently ignoring
    showError('Please enter a city name to search.');
    return;
  }

  getWeather(query);
}

// ─────────────────────────────────────────────
// EVENT LISTENERS
// ─────────────────────────────────────────────

// Click the "Go" button
searchBtn.addEventListener('click', handleSearch);

// Press Enter while focused in the input field
cityInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handleSearch();
});

// ─────────────────────────────────────────────
// INITIAL LOAD
// Fetch Lucknow automatically so the dashboard
// is never empty when a visitor first lands.
// ─────────────────────────────────────────────

getWeather('Lucknow');