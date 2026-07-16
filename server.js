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

  // qtdPorPagina alto: sem isto, a DGEG só devolve os 50 mais baratos do país
  // (o suficiente para uma tabela de "mais baratos", mas não para uma pesquisa
  // por proximidade — precisamos de TODOS os postos para depois filtrar por raio).
  const url = `${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}&qtdPorPagina=5000&pagina=1`;
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

// ---------------- Tendência do petróleo Brent (não é previsão de combustível) ----------------
// Fonte gratuita, sem chave — dá-nos o preço atual do barril. Guardamos um
// histórico simples em memória (reinicia se o servidor reiniciar) para termos
// uma tendência real de "há uns dias para cá", não inventada.
let brentCache = null;
const BRENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const brentHistory = []; // [{price, at}], mantemos até 14 dias

app.get('/api/brent-trend', async (req, res) => {
  try {
    const now = Date.now();
    if (brentCache && now - brentCache.fetchedAt < BRENT_CACHE_TTL_MS) {
      return res.json(brentCache.data);
    }

    const r = await fetch('https://api.oilpriceapi.com/v1/demo/prices', {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!r.ok) throw new Error(`oilpriceapi devolveu ${r.status} ${r.statusText}`);
    const raw = await r.json();

    // a resposta pode vir em formas ligeiramente diferentes consoante o
    // endpoint — tentamos extrair o preço de forma tolerante
    const price = raw?.data?.price ?? raw?.price ?? raw?.data?.[0]?.price ?? null;
    if (price == null || !Number.isFinite(Number(price))) {
      throw new Error('Não foi possível interpretar o preço do Brent na resposta.');
    }
    const priceNum = Number(price);

    brentHistory.push({ price: priceNum, at: now });
    // limpa entradas com mais de 14 dias
    while (brentHistory.length && now - brentHistory[0].at > 14 * 24 * 60 * 60 * 1000) {
      brentHistory.shift();
    }

    const oldest = brentHistory[0];
    const trendPct = oldest && oldest.price ? ((priceNum - oldest.price) / oldest.price) * 100 : null;
    const trendDays = oldest ? Math.round((now - oldest.at) / (1000*60*60*24)) : 0;

    const data = { priceUsd: priceNum, trendPct, trendDays };
    brentCache = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao obter tendência do Brent', detail: String(err.message || err) });
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
    const { fromLat, fromLon, toLat, toLon, mass, consumption } = req.query;
    if ([fromLat, fromLon, toLat, toLon].some((v) => v === undefined)) {
      return res.status(400).json({ error: 'Parâmetros em falta: fromLat, fromLon, toLat, toLon' });
    }
    // veículo: mass (kg) e consumption (L/100km) são opcionais — usam os
    // valores de "carro médio" por omissão, para não partir pedidos antigos
    const massKg = Number.isFinite(Number(mass)) && Number(mass) > 0 ? Number(mass) : ASSUMED_MASS_KG;
    const consumptionL100 = Number.isFinite(Number(consumption)) && Number(consumption) > 0 ? Number(consumption) : ASSUMED_L_PER_100KM;
    const key = `${fromLat},${fromLon},${toLat},${toLon},${massKg},${consumptionL100}`;
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
    const distanceKm = route.distance / 1000;

    const elevation = await estimateFuelEffect(coordinates, distanceKm, massKg, consumptionL100);

    const data = {
      distanceKm,
      durationMin: route.duration / 60,
      coordinates,
      elevationGainM: elevation ? elevation.gainM : null,
      elevationLossM: elevation ? elevation.lossM : null,
      litersOneWay: elevation ? elevation.liters : null,
    };
    routeCache[key] = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao calcular a rota', detail: String(err.message || err) });
  }
});

// ---------------- Estimativa de consumo com base na altitude real do percurso ----------------
// Modelo físico simplificado (carro médio a combustão, não é o consumo exato
// do teu carro): subidas custam combustível extra; descidas poupam algum
// (motor a combustão não "recupera" energia como um elétrico, mas gasta
// muito menos a descer — travagem por motor/embalar).
const ASSUMED_MASS_KG = 1400; // omissão: carro ligeiro
const ASSUMED_L_PER_100KM = 6.5; // omissão: carro ligeiro
const USABLE_WH_PER_LITER = 3600; // energia mecânica útil por litro, após rendimento do motor
const DOWNHILL_SAVING_FACTOR = 0.4; // fração do custo de subida equivalente, poupada a descer
const G = 9.81;

async function estimateFuelEffect(coordinates, distanceKm, massKg, consumptionL100) {
  massKg = massKg || ASSUMED_MASS_KG;
  consumptionL100 = consumptionL100 || ASSUMED_L_PER_100KM;
  try {
    if (!coordinates || coordinates.length < 2) return null;
    const sampleCount = Math.min(20, coordinates.length);
    const step = Math.max(1, Math.floor(coordinates.length / sampleCount));
    const sampled = [];
    for (let i = 0; i < coordinates.length; i += step) sampled.push(coordinates[i]);
    if (sampled[sampled.length - 1] !== coordinates[coordinates.length - 1]) {
      sampled.push(coordinates[coordinates.length - 1]);
    }

    const locations = sampled.map(([lat, lon]) => `${lat},${lon}`).join('|');
    const url = `https://api.opentopodata.org/v1/eudem25m?locations=${locations}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const raw = await r.json();
    if (raw.status !== 'OK' || !Array.isArray(raw.results)) return null;

    const elevations = raw.results.map((p) => p.elevation).filter((e) => typeof e === 'number');
    if (elevations.length < 2) return null;

    let gainM = 0, lossM = 0;
    for (let i = 1; i < elevations.length; i++) {
      const delta = elevations[i] - elevations[i - 1];
      if (delta > 0) gainM += delta; else lossM += -delta;
    }

    const baseLiters = distanceKm * consumptionL100 / 100;
    const extraLitersUphill = (massKg * G * gainM / 3600) / USABLE_WH_PER_LITER;
    const savedLitersDownhill = DOWNHILL_SAVING_FACTOR * (massKg * G * lossM / 3600) / USABLE_WH_PER_LITER;
    const liters = Math.max(baseLiters * 0.7, baseLiters + extraLitersUphill - savedLitersDownhill);

    return { gainM: Math.round(gainM), lossM: Math.round(lossM), liters: Math.round(liters * 1000) / 1000 };
  } catch (e) {
    return null;
  }
}

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
