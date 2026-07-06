// CARGA+ — servidor
//
// Serve a app e disponibiliza /api/ev-postos, que vai buscar postos de
// carregamento elétrico reais ao OpenStreetMap (Overpass API), porque o
// browser não pode chamar essa API diretamente sem passar por aqui de forma
// fiável (cache, retries e vários espelhos do servidor).

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];

const EV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a localização dos postos muda pouco
const evCache = {};

function toRad(d) { return (d * Math.PI) / 180; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function parseOverpassStation(el) {
  const t = el.tags || {};
  const connectors = [];
  let maxPowerKw = null;

  for (const key of Object.keys(t)) {
    const outputMatch = key.match(/^socket:([a-z0-9_]+):output$/i);
    if (outputMatch) {
      const kw = parseFloat(String(t[key]).replace(/[^\d.]/g, ''));
      if (!isNaN(kw)) maxPowerKw = maxPowerKw ? Math.max(maxPowerKw, kw) : kw;
    }
    const socketMatch = key.match(/^socket:([a-z0-9_]+)$/i);
    if (socketMatch && !key.includes(':output')) {
      connectors.push(socketMatch[1].replace(/_/g, ' '));
    }
  }

  const addressParts = [t['addr:street'], t['addr:city']].filter(Boolean);

  return {
    id: `osm-${el.id}`,
    name: t.name || t.operator || t.brand || 'Posto de carregamento',
    operator: t.operator || t.network || t.brand || 'Operador desconhecido',
    municipio: t['addr:city'] || '',
    morada: addressParts.join(', '),
    lat: el.lat,
    lon: el.lon,
    power: maxPowerKw,
    connectors: connectors.length ? connectors : null,
    free: t.fee === 'no',
    source: 'OpenStreetMap',
  };
}

app.get('/api/ev-postos', async (req, res) => {
  try {
    const { lat, lon, raio } = req.query;
    if (lat === undefined || lon === undefined || raio === undefined) {
      return res.status(400).json({ error: 'Parâmetros em falta: lat, lon, raio' });
    }
    const centerLat = parseFloat(lat);
    const centerLon = parseFloat(lon);
    const radiusKm = parseFloat(raio);
    const radiusM = Math.max(1, Math.round(radiusKm * 1000));

    const cacheKey = `${round(centerLat, 2)},${round(centerLon, 2)},${radiusKm}`;
    const now = Date.now();

    let stations;
    if (evCache[cacheKey] && now - evCache[cacheKey].fetchedAt < EV_CACHE_TTL_MS) {
      stations = evCache[cacheKey].data;
    } else {
      const query = `[out:json][timeout:25];node["amenity"="charging_station"](around:${radiusM},${centerLat},${centerLon});out body;`;
      let raw = null;
      let lastErr = null;
      for (const base of OVERPASS_URLS) {
        try {
          const url = `${base}?data=${encodeURIComponent(query)}`;
          const r = await fetch(url, { headers: { 'User-Agent': 'CargaMaisApp/1.0' } });
          if (!r.ok) { lastErr = new Error(`${base} devolveu ${r.status} ${r.statusText}`); continue; }
          raw = await r.json();
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!raw) throw lastErr || new Error('Todos os servidores Overpass falharam');
      stations = (raw.elements || []).map(parseOverpassStation);
      evCache[cacheKey] = { data: stations, fetchedAt: now };
    }

    const result = stations
      .map((s) => ({ ...s, dist: haversineKm(centerLat, centerLon, s.lat, s.lon) }))
      .filter((s) => s.dist <= radiusKm)
      .sort((a, b) => a.dist - b.dist);

    res.json({ count: result.length, stations: result, source: 'OpenStreetMap (dados da comunidade, sem preço em tempo real)' });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao obter dados do OpenStreetMap', detail: String(err.message || err) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cachedQueries: Object.keys(evCache).length });
});

// ---------------- Distância e rota reais (por estrada, via OSRM) ----------------
const routeCache = {};
const ROUTE_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

app.get('/api/rota', async (req, res) => {
  try {
    const { fromLat, fromLon, toLat, toLon } = req.query;
    if ([fromLat, fromLon, toLat, toLon].some((v) => v === undefined)) {
      return res.status(400).json({ error: 'Parâmetros em falta: fromLat, fromLon, toLat, toLon' });
    }
    const key = `${fromLat},${fromLon},${toLat},${toLon}`;
    const now = Date.now();
    if (routeCache[key] && now - routeCache[key].fetchedAt < ROUTE_CACHE_TTL_MS) {
      return res.json(routeCache[key].data);
    }

    const url = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CargaMaisApp/1.0' } });
    if (!r.ok) throw new Error(`OSRM devolveu ${r.status} ${r.statusText}`);
    const raw = await r.json();

    if (raw.code !== 'Ok' || !raw.routes || !raw.routes[0]) {
      return res.status(404).json({ error: 'Sem rota encontrada por estrada entre estes pontos.' });
    }

    const route = raw.routes[0];
    const data = {
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      coordinates: (route.geometry.coordinates || []).map(([lon, lat]) => [lat, lon]),
    };
    routeCache[key] = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao calcular a rota', detail: String(err.message || err) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`CARGA+ a correr em http://localhost:${PORT}`);
});
