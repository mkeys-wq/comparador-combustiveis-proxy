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
  const stations =