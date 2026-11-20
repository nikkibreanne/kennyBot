const endpoint = new URL('https://api.open-meteo.com/v1/forecast');
endpoint.search = new URLSearchParams({
  latitude: '34.0522',
  longitude: '-118.2437',
  current: 'temperature_2m,apparent_temperature,weather_code',
  daily: 'precipitation_probability_max',
  timezone: 'America/Los_Angeles',
  forecast_days: '1',
  temperature_unit: 'fahrenheit',
});

const conditions = {
  0: '☀️ Clear',
  1: '🌤️ Mostly clear',
  2: '⛅ Partly cloudy',
  3: '☁️ Overcast',
  45: '🌫️ Fog',
  48: '🌫️ Freezing fog',
  51: '🌧️ Light drizzle',
  53: '🌧️ Drizzle',
  55: '🌧️ Heavy drizzle',
  56: '🌧️ Light freezing drizzle',
  57: '🌧️ Freezing drizzle',
  61: '🌧️ Light rain',
  63: '🌧️ Rain',
  65: '🌧️ Heavy rain',
  66: '🌧️ Light freezing rain',
  67: '🌧️ Freezing rain',
  71: '🌨️ Light snow',
  73: '🌨️ Snow',
  75: '🌨️ Heavy snow',
  77: '🌨️ Snow grains',
  80: '🌧️ Light rain showers',
  81: '🌧️ Rain showers',
  82: '🌧️ Heavy rain showers',
  85: '🌨️ Light snow showers',
  86: '🌨️ Heavy snow showers',
  95: '⛈️ Thunderstorms',
  96: '⛈️ Thunderstorms with hail',
  97: '⛈️ Heavy thunderstorms',
  99: '⛈️ Thunderstorms with heavy hail',
};

let cachedReply;
let expiresAt = 0;
let pendingRequest;

async function fetchWeather() {
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);

  const { current, daily } = await response.json();
  const temperature = current?.temperature_2m;
  const feelsLike = current?.apparent_temperature;
  if (!Number.isFinite(temperature) || !Number.isFinite(feelsLike)) {
    throw new Error('Open-Meteo returned incomplete current temperatures');
  }

  const code = current.weather_code;
  const condition = Number.isInteger(code) && conditions[code] ? `${conditions[code]}, ` : '';
  const precipitation = daily?.precipitation_probability_max?.[0];
  const chance = Number.isFinite(precipitation) && precipitation >= 0 && precipitation <= 100
    ? `Today's peak precipitation chance: ${Math.round(precipitation)}%`
    : 'Precipitation chance unavailable';
  cachedReply = `Los Angeles weather | ${condition}🌡️ ${Math.round(temperature)}°F (feels like ${Math.round(feelsLike)}°F) | ☔ ${chance} | Open-Meteo`;
  expiresAt = Date.now() + 5 * 60_000;
  return cachedReply;
}

export default {
  names: ['weather'],
  mod: false,
  cooldownMs: 30_000,
  help: '!weather — current weather in Los Angeles, CA',
  async run({ reply, logger }) {
    if (Date.now() < expiresAt) return reply(cachedReply);

    pendingRequest ??= fetchWeather()
      .catch((err) => {
        logger.warn('weather lookup failed', { err: String(err) });
        return 'Los Angeles weather is unavailable right now. Try again in a moment.';
      })
      .finally(() => { pendingRequest = undefined; });
    return reply(await pendingRequest);
  },
};
