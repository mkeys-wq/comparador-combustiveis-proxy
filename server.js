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
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ---- IDs de tipo de combustível — TODOS confirmados com dados reais em 06/07/2026 ----
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

// Testa uma gama de IDs de tipo de combustível em paralelo e devolve o nome
// que a DGEG associa a cada um — usar uma vez para confirmar FUEL_IDS.
app.get('/api/debug/probe-fuel-ids', async (req, res) => {
  const from = parseInt(req.query.from || '3195', 10);
  const to = parseInt(req.query.to || '3212', 10);
  const ids = [];
  for (let id = from; id <= to; id++) ids.push(id);

  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const raw = await fetchJson(`${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}`);
        const list = raw.resultado || raw.Postos || raw.postos || (Array.isArray(raw) ? raw : []);
        return [id, list.length ? `${list[0].Combustivel} (${list[0].Quantidade} postos)` : '(sem resultados)'];
      } catch (err) {
        return [id, 'erro: ' + String(err.message || err)];
      }
    })
  );

  res.json(Object.fromEntries(results));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cachedFuels: Object.keys(cache) });
});

// ---------------- Carregamento elétrico (dados reais via OpenStreetMap) ----------------
// A DGEG não publica dados de carregamento elétrico. Em vez de inventar
// preços, usamos o OpenStreetMap (Overpass API) para obter localizações,
// potências e tipos de tomada REAIS, mantidos pela comunidade. Não há preço
// por posto em tempo real disponível publicamente, por isso não o mostramos.
const evCache = {}; // "lat,lon,raio" arredondados -> { data, fetchedAt }

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
    const EV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — a localização dos postos muda pouco

    let stations;
    if (evCache[cacheKey] && now - evCache[cacheKey].fetchedAt < EV_CACHE_TTL_MS) {
      stations = evCache[cacheKey].data;
    } else {
      const query = `[out:json][timeout:25];node["amenity"="charging_station"](around:${radiusM},${centerLat},${centerLon});out body;`;
      const url = `${OVERPASS_URL}?data=${encodeURIComponent(query)}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'ComparadorCombustivelProxy/1.0' } });
      if (!r.ok) throw new Error(`Overpass devolveu ${r.status} ${r.statusText}`);
      const raw = await r.json();
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


app.get('/api/debug/find-tipos-endpoint', async (req, res) => {
  try {
    const homeRes = await fetch('https://precoscombustiveis.dgeg.gov.pt/postos/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ComparadorCombustivelProxy/1.0)' },
    });
    const html = await homeRes.text();

    const varRe = /(var\s+)?(UrlTiposCombustiveis|urlGlobal|UrlMarcas|urlListarDadosPostos)\s*=\s*['"]([^'"]+)['"]/g;
    const vars = {};
    let vm;
    while ((vm = varRe.exec(html)) !== null) {
      vars[vm[2]] = vm[3];
    }

    let rawAssignments = [];
    if (!vars.UrlTiposCombustiveis) {
      const jsFiles = [
        'https://precoscombustiveis.dgeg.gov.pt/assets/js/home.js',
        'https://precoscombustiveis.dgeg.gov.pt/assets/js/functions.js',
      ];
      for (const url of jsFiles) {
        try {
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const js = await r.text();
          const re = /UrlTiposCombustiveis\s*=[^;]+;/g;
          let m2;
          while ((m2 = re.exec(js)) !== null) {
            rawAssignments.push({ file: url, line: m2[0] });
          }
        } catch (e) {}
      }
    }

    let tiposResult = null;
    let triedUrl = null;
    if (vars.UrlTiposCombustiveis) {
      triedUrl = vars.UrlTiposCombustiveis.startsWith('http')
        ? vars.UrlTiposCombustiveis
        : new URL(vars.UrlTiposCombustiveis, 'https://precoscombustiveis.dgeg.gov.pt/').toString();
    } else if (rawAssignments.length > 0) {
      const pathMatch = rawAssignments[0].line.match(/['"](\/[^'"]+)['"]/);
      if (pathMatch) {
        triedUrl = vars.urlGlobal + pathMatch[1];
      }
    }

    if (triedUrl) {
      try {
        const tr = await fetch(triedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        tiposResult = await tr.text();
        try { tiposResult = JSON.parse(tiposResult); } catch (e2) {}
      } catch (e) {
        tiposResult = 'erro a chamar ' + triedUrl + ': ' + String(e.message || e);
      }
    }

    res.json({ varsFound: vars, rawAssignments, triedUrl, tiposResult });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});



app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Comparador Combustível+ proxy a correr em http://localhost:${PORT}`);
  console.log(`Testa primeiro: http://localhost:${PORT}/api/debug/raw-search?id=3201`);
});