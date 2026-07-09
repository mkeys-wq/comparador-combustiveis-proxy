// Comparador Combustível+ — servidor proxy
//
// Faz de intermediário entre a app (browser) e a API pública da DGEG,
// porque o browser não pode chamar precoscombustiveis.dgeg.gov.pt diretamente (CORS).

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DGEG_BASE = 'https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb';

// ---- IDs de tipo de combustível — todos confirmados com dados reais ----
const FUEL_IDS = {
  gasolina95: 3201,
  gasolina95p: 3205,
  gasoleo: 2101,
  gasoleop: 2105,
  gasoleoagr: 2150,
  gasolina98: 3400,
  gpl: 1120,
};

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora — os preços da DGEG só mudam diariamente
const cache = {}; // fuelKey -> { data: Station[], fetchedAt: number }

// ---------------- helpers ----------------

function pick(obj, candidates, fallback = null) {
  for (const key of candidates) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function parseNumber(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw)
    .replace('€/litro', '')
    .replace('€', '')
    .trim()
    .replace(',', '.');
  return parseFloat(cleaned);
}

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

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; ComparadorCombustivelProxy/1.0; +https://precoscombustiveis.dgeg.gov.pt)',
    },
  });
  if (!res.ok) {
    throw new Error(`DGEG devolveu ${res.status} ${res.statusText} para ${url}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Resposta da DGEG não é JSON válido. Início: ${text.slice(0, 300)}`);
  }
}

function normalizeStation(item) {
  const lat = parseNumber(pick(item, ['Latitude', 'latitude', 'Lat', 'lat']));
  const lon = parseNumber(pick(item, ['Longitude', 'longitude', 'Lon', 'lon', 'Long']));
  const price = parseNumber(pick(item, ['Preco', 'preco', 'Price']));
  return {
    id: pick(item, ['Id', 'id', 'PostoId', 'postoId']),
    name: pick(item, ['Nome', 'nome', 'NomePosto', 'nomePosto']),
    brand: pick(item, ['Marca', 'marca']),
    municipio: pick(item, ['Municipio', 'municipio']),
    distrito: pick(item, ['Distrito', 'distrito']),
    morada: pick(item, ['Morada', 'morada']),
    lat,
    lon,
    price,
    updatedAt: pick(item, ['DataAtualizacao', 'dataAtualizacao', 'Data', 'data']),
  };
}

async function loadFuel(fuelKey) {
  const now = Date.now();
  if (cache[fuelKey] && now - cache[fuelKey].fetchedAt < CACHE_TTL_MS) {
    return cache[fuelKey];
  }
  const id = FUEL_IDS[fuelKey];
  if (!id) throw new Error(`Tipo de combustível desconhecido: ${fuelKey}`);

  const url = `${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}`;
  const raw = await fetchJson(url);
  const list = Array.isArray(raw) ? raw : raw.resultado || raw.Postos || raw.postos || raw.Resultado || [];

  const stations = list
    .map(normalizeStation)
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.price));

  const entry = { data: stations, fetchedAt: now, rawCount: list.length };
  cache[fuelKey] = entry;
  return entry;
}

// ---------------- rotas ----------------

app.get('/api/postos', async (req, res) => {
  try {
    const { fuel, lat, lon, raio } = req.query;
    if (!fuel || lat === undefined || lon === undefined || raio === undefined) {
      return res.status(400).json({ error: 'Parâmetros em falta: fuel, lat, lon, raio' });
    }
    const { data, rawCount } = await loadFuel(fuel);
    const centerLat = parseFloat(lat);
    const centerLon = parseFloat(lon);
    const radiusKm = parseFloat(raio);

    const result = data
      .map((s) => ({ ...s, dist: haversineKm(centerLat, centerLon, s.lat, s.lon) }))
      .filter((s) => s.dist <= radiusKm)
      .sort((a, b) => a.price - b.price);

    if (data.length === 0 && rawCount > 0) {
      return res.status(502).json({ error: 'Não foi possível interpretar os campos da resposta da DGEG.', rawCount });
    }

    res.json({ count: result.length, totalNoTipo: data.length, stations: result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao obter dados da DGEG', detail: String(err.message || err) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cachedFuels: Object.keys(cache) });
});

// Testa se o endpoint com preço/coordenadas aceita um parâmetro de paginação
// que permita ir além dos 50 resultados habituais.
app.get('/api/debug/pesquisar-mais', async (req, res) => {
  try {
    const id = req.query.id || FUEL_IDS.gasoleo;
    const qtd = req.query.qtd || '500';
    const url = `${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}&qtdPorPagina=${qtd}&pagina=1`;
    const raw = await fetchJson(url);
    const list = Array.isArray(raw) ? raw : raw.resultado || raw.Postos || raw.postos || raw.Resultado || [];
    res.json({ totalRecebido: list.length, primeiro: list[0], ultimo: list[list.length-1] });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Testa se existe um endpoint alternativo que devolva TODOS os postos de um
// tipo de combustível (não só os 50 mais baratos do país, como PesquisarPostos).
app.get('/api/debug/listar-postos', async (req, res) => {
  try {
    const id = req.query.id || FUEL_IDS.gasoleo;
    const url = `${DGEG_BASE}/ListarDadosPostos?idsTiposComb=${id}&qtdPorPagina=9999&pagina=1`;
    const raw = await fetchJson(url);
    const list = Array.isArray(raw) ? raw : raw.resultado || raw.Postos || raw.postos || raw.Resultado || [];
    res.json({ totalRecebido: list.length, amostra: list.slice(0, 3), raw: Array.isArray(raw) ? undefined : Object.keys(raw) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---------------- Pesquisa de localidades (qualquer sítio em Portugal) ----------------
const geocodeCache = {};
const GEOCODE_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

app.get('/api/geocode', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });

    const key = q.toLowerCase();
    const now = Date.now();
    if (geocodeCache[key] && now - geocodeCache[key].fetchedAt < GEOCODE_CACHE_TTL_MS) {
      return res.json({ results: geocodeCache[key].data });
    }

    const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=pt&addressdetails=1&limit=8&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'CombustivelMaisApp/1.0 (busca de localidades)' } });
    if (!r.ok) throw new Error(`Nominatim devolveu ${r.status} ${r.statusText}`);
    const raw = await r.json();

    const results = raw.map((item) => ({
      name: item.display_name,
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon),
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));

    geocodeCache[key] = { data: results, fetchedAt: now };
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha na pesquisa de localidades', detail: String(err.message || err) });
  }
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
    const r = await fetch(url, { headers: { 'User-Agent': 'CombustivelMaisApp/1.0' } });
    if (!r.ok) throw new Error(`OSRM devolveu ${r.status} ${r.statusText}`);
    const raw = await r.json();

    if (raw.code !== 'Ok' || !raw.routes || !raw.routes[0]) {
      return res.status(404).json({ error: 'Sem rota encontrada por estrada entre estes pontos.' });
    }

    const route = raw.routes[0];
    const coordinates = (route.geometry.coordinates || []).map(([lon, lat]) => [lat, lon]);

    const data = {
      distanceKm: route.distance / 1000,
      durationMin: route.duration / 60,
      coordinates,
    };
    routeCache[key] = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao calcular a rota', detail: String(err.message || err) });
  }
});

// A página principal nunca deve ficar presa em cache do browser — garante
// que quem abre a app recebe sempre a versão mais recente publicada.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Comparador Combustível+ proxy a correr em http://localhost:${PORT}`);
});
