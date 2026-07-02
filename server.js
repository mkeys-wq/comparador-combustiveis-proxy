// Comparador Combustível+ — servidor proxy

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DGEG_BASE = 'https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb';

const FUEL_IDS = {
  gasolina95: 3201,
  gasolina95p: 3205,
  gasoleo: 2101,
  gasoleop: 2105,
  gasoleoagr: 2150,
  gasolina98: 3203,
  gpl: 3207,
};

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = {};

function pick(obj, candidates, fallback = null) {
  for (const key of candidates) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function parseNumber(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const cleaned = String(raw).replace('€/litro', '').replace('€/kWh', '').replace('€', '').trim().replace(',', '.');
  return parseFloat(cleaned);
}

function toRad(d) { return (d * Math.PI) / 180; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; ComparadorCombustivelProxy/1.0)' },
  });
  if (!res.ok) throw new Error(`DGEG devolveu ${res.status} ${res.statusText} para ${url}`);
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
    lat, lon, price,
    updatedAt: pick(item, ['DataAtualizacao', 'dataAtualizacao', 'Data', 'data']),
  };
}

async function loadFuel(fuelKey) {
  const now = Date.now();
  if (cache[fuelKey] && now - cache[fuelKey].fetchedAt < CACHE_TTL_MS) return cache[fuelKey];
  const id = FUEL_IDS[fuelKey];
  if (!id) throw new Error(`Tipo de combustível desconhecido: ${fuelKey}`);
  const url = `${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}`;
  const raw = await fetchJson(url);
  const list = Array.isArray(raw) ? raw : raw.resultado || raw.Postos || raw.postos || raw.Resultado || [];
  const stations = list.map(normalizeStation).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.price));
  const entry = { data: stations, fetchedAt: now, rawCount: list.length };
  cache[fuelKey] = entry;
  return entry;
}

app.get('/api/postos', async (req, res) => {
  try {
    const { fuel, lat, lon, raio } = req.query;
    if (!fuel || lat === undefined || lon === undefined || raio === undefined) {
      return res.status(400).json({ error: 'Parâmetros em falta: fuel, lat, lon, raio' });
    }
    const { data, rawCount } = await loadFuel(fuel);
    const centerLat = parseFloat(lat), centerLon = parseFloat(lon), radiusKm = parseFloat(raio);
    const result = data.map((s) => ({ ...s, dist: haversineKm(centerLat, centerLon, s.lat, s.lon) }))
      .filter((s) => s.dist <= radiusKm).sort((a, b) => a.price - b.price);
    if (data.length === 0 && rawCount > 0) {
      return res.status(502).json({ error: 'Não foi possível interpretar os campos.', rawCount });
    }
    res.json({ count: result.length, totalNoTipo: data.length, stations: result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Falha ao obter dados da DGEG', detail: String(err.message || err) });
  }
});

app.get('/api/debug/raw-search', async (req, res) => {
  try {
    const id = req.query.id || FUEL_IDS.gasolina95;
    const raw = await fetchJson(`${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}`);
    res.json(raw);
  } catch (err) { res.status(502).json({ error: String(err.message || err) }); }
});

app.get('/api/debug/raw-posto', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'Parâmetro id em falta, ex: ?id=67080' });
    const raw = await fetchJson(`${DGEG_BASE}/GetDadosPostoMapa?id=${id}&f=json`);
    res.json(raw);
  } catch (err) { res.status(502).json({ error: String(err.message || err) }); }
});

app.get('/api/debug/probe-fuel-ids', async (req, res) => {
  const from = parseInt(req.query.from || '3195', 10);
  const to = parseInt(req.query.to || '3212', 10);
  const ids = [];
  for (let id = from; id <= to; id++) ids.push(id);
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const raw = await fetchJson(`${DGEG_BASE}/PesquisarPostos?idsTiposComb=${id}`);
      const list = raw.resultado || raw.Postos || raw.postos || (Array.isArray(raw) ? raw : []);
      return [id, list.length ? `${list[0].Combustivel} (${list[0].Quantidade} postos)` : '(sem resultados)'];
    } catch (err) { return [id, 'erro: ' + String(err.message || err)]; }
  }));
  res.json(Object.fromEntries(results));
});

app.get('/api/health', (req, res) => { res.json({ ok: true, cachedFuels: Object.keys(cache) }); });

app.get('/api/debug/find-dropdown-source', async (req, res) => {
  try {
    const homeRes = await fetch('https://precoscombustiveis.dgeg.gov.pt/postos/', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ComparadorCombustivelProxy/1.0)' },
    });
    const html = await homeRes.text();
    const scriptSrcs = Array.from(html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)).map((m) => m[1]);
    const absoluteUrls = scriptSrcs.map((src) => src.startsWith('http') ? src : new URL(src, 'https://precoscombustiveis.dgeg.gov.pt/postos/').toString());
    const keywords = ['cboTipoCombustivel', 'TipoCombustivel', 'urlListar', 'urlGlobal', '.append(', 'GetTipos'];
    const findings = [];
    for (const url of absoluteUrls) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) continue;
        const js = await r.text();
        for (const kw of keywords) {
          let idx = js.indexOf(kw);
          let count = 0;
          while (idx !== -1 && count < 8) {
            findings.push({ file: url, keyword: kw, context: js.slice(Math.max(0, idx - 100), idx + 150) });
            idx = js.indexOf(kw, idx + 1);
            count++;
          }
        }
      } catch (e) {}
    }
    res.json({ findingsCount: findings.length, findings: findings.slice(0, 80) });
  } catch (err) { res.status(502).json({ error: String(err.message || err) }); }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Comparador Combustível+ proxy a correr em http://localhost:${PORT}`);
});