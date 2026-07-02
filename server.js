// Comparador Combustível+ — servidor proxy
//
// Faz de intermediário entre a app (browser) e a API pública da DGEG,
// porque o browser não pode chamar precoscombustiveis.dgeg.gov.pt diretamente (CORS).
//
// IMPORTANTE — leia o README.md antes de publicar:
// Os IDs de tipo de combustível (FUEL_IDS) e os nomes de campo usados em pick(...)
// abaixo são a MELHOR ESTIMATIVA a partir de investigação pública (não foram
// confirmados com uma chamada real bem-sucedida à API a partir do ambiente onde
// este código foi escrito). Use os endpoints /api/debug/* para confirmar a forma
// real da resposta da DGEG e ajustar o que for preciso — ver README.md, secção
// "Primeira verificação (obrigatória)".

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DGEG_BASE = 'https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb';

// ---- Melhor estimativa dos IDs de tipo de combustível — CONFIRMAR (ver README) ----
const FUEL_IDS = {
  gasolina95: 3201,
  gasolina95p: 3202,
  gasolina98: 3203,
  gasoleo: 3204,
  gasoleop: 3205,
  gasoleoagr: 3206,
  gpl: 3207,
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
    .replace('€/kWh', '')
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
    throw new Error(
      `Resposta da DGEG não é JSON válido (pode ser HTML de erro ou exigir outros cabeçalhos). Início da resposta: ${text.slice(0, 300)}`
    );
  }
}

// Normaliza a resposta da DGEG para o formato interno da app, tentando
// vários nomes de campo possíveis (ver /api/debug/raw-search para confirmar
// quais são os corretos e simplificar esta lista depois).
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

  // A resposta pode vir como array direto ou dentro de um invólucro — tenta os dois.
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
      // Os dados vieram da DGEG mas nenhum registo tinha lat/lon/preço reconhecíveis
      // com os nomes de campo atuais — sinal para rever normalizeStation().
      return res.status(502).json({
        error:
          'A DGEG devolveu dados mas não foi possível interpretar os campos (lat/lon/preço). Verifica /api/debug/raw-search para ajustar os nomes de campo em normalizeStation().',
        rawCount,
      });
    }

    res.json({ count: result.length, totalNoTipo: data.length, stations: result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao obter dados da DGEG', detail: String(err.message || err) });
  }
});

// Endpoints de depuração — usar durante a primeira verificação (ver README.md)
app.get('/api/debug/raw-search', async (req, res) => {
  try {
    const id = req.query.id || FUEL_IDS.gasolina95;
    const raw = await fetchJson(`${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}`);
    res.json(raw);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/debug/raw-posto', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Parâmetro id em falta, ex: ?id=67080' });
    const raw = await fetchJson(`${DGEG_BASE}/GetDadosPostoMapa?id=${id}&f=json`);
    res.json(raw);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cachedFuels: Object.keys(cache) });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Comparador Combustível+ proxy a correr em http://localhost:${PORT}`);
  console.log(`Testa primeiro: http://localhost:${PORT}/api/debug/raw-search?id=3201`);
});
