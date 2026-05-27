/**
 * Persistent Storage Layer
 * Stores competitors, scraped products, draft status, scan history, and watchlist in JSON files
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const COMPETITORS_FILE   = path.join(DATA_DIR, 'competitors.json');
const SCRAPED_CACHE_FILE = path.join(DATA_DIR, 'scraped-products.json');
const DRAFT_STATUS_FILE  = path.join(DATA_DIR, 'draft-status.json');
const SCAN_HISTORY_FILE  = path.join(DATA_DIR, 'scan-history.json');
const WATCHLIST_FILE     = path.join(DATA_DIR, 'watchlist.json');

// Initialize files if they don't exist
function ensureFile(filepath, defaultData = []) {
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify(defaultData, null, 2));
  }
}

ensureFile(COMPETITORS_FILE,   []);
ensureFile(SCRAPED_CACHE_FILE, {});
ensureFile(DRAFT_STATUS_FILE,  {});
ensureFile(SCAN_HISTORY_FILE,  {});
ensureFile(WATCHLIST_FILE,     {});

// ═══════════════════════════════════════════════════════════════════════════
// COMPETITORS
// ═══════════════════════════════════════════════════════════════════════════

export function getCompetitors(shop) {
  const data = JSON.parse(fs.readFileSync(COMPETITORS_FILE, 'utf8'));
  return data.filter(c => c.shop === shop);
}

export function saveCompetitor(shop, competitor) {
  const data = JSON.parse(fs.readFileSync(COMPETITORS_FILE, 'utf8'));
  const newEntry = { ...competitor, shop, id: competitor.id || Date.now().toString() };
  data.push(newEntry);
  fs.writeFileSync(COMPETITORS_FILE, JSON.stringify(data, null, 2));
  return newEntry;
}

export function updateCompetitor(shop, id, updates) {
  const data = JSON.parse(fs.readFileSync(COMPETITORS_FILE, 'utf8'));
  const index = data.findIndex(c => c.shop === shop && c.id === id);
  if (index === -1) return null;
  data[index] = { ...data[index], ...updates };
  fs.writeFileSync(COMPETITORS_FILE, JSON.stringify(data, null, 2));
  return data[index];
}

export function deleteCompetitor(shop, id) {
  const data = JSON.parse(fs.readFileSync(COMPETITORS_FILE, 'utf8'));
  const filtered = data.filter(c => !(c.shop === shop && c.id === id));
  fs.writeFileSync(COMPETITORS_FILE, JSON.stringify(filtered, null, 2));
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCRAPED PRODUCTS CACHE
// ═══════════════════════════════════════════════════════════════════════════

export function getScrapedProducts(shop, competitorId) {
  const cache = JSON.parse(fs.readFileSync(SCRAPED_CACHE_FILE, 'utf8'));
  const key = `${shop}:${competitorId}`;
  return cache[key] || [];
}

export function saveScrapedProducts(shop, competitorId, products) {
  const cache = JSON.parse(fs.readFileSync(SCRAPED_CACHE_FILE, 'utf8'));
  const key = `${shop}:${competitorId}`;
  cache[key] = {
    products,
    scrapedAt: new Date().toISOString(),
    count: products.length,
  };
  fs.writeFileSync(SCRAPED_CACHE_FILE, JSON.stringify(cache, null, 2));
  return cache[key];
}

export function clearScrapedCache(shop, competitorId) {
  const cache = JSON.parse(fs.readFileSync(SCRAPED_CACHE_FILE, 'utf8'));
  const key = `${shop}:${competitorId}`;
  delete cache[key];
  fs.writeFileSync(SCRAPED_CACHE_FILE, JSON.stringify(cache, null, 2));
  return true;
}

export function getAllScrapedCache(shop) {
  const cache = JSON.parse(fs.readFileSync(SCRAPED_CACHE_FILE, 'utf8'));
  const result = {};
  for (const [key, value] of Object.entries(cache)) {
    if (key.startsWith(`${shop}:`)) {
      const competitorId = key.split(':')[1];
      result[competitorId] = value;
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAFT STATUS TRACKING
// ═══════════════════════════════════════════════════════════════════════════

export function getDraftStatus(shop) {
  const status = JSON.parse(fs.readFileSync(DRAFT_STATUS_FILE, 'utf8'));
  return status[shop] || {};
}

export function markAsDraft(shop, productSourceIds) {
  const status = JSON.parse(fs.readFileSync(DRAFT_STATUS_FILE, 'utf8'));
  if (!status[shop]) status[shop] = {};
  productSourceIds.forEach(id => {
    status[shop][id] = { sentToDraft: true, draftedAt: new Date().toISOString() };
  });
  fs.writeFileSync(DRAFT_STATUS_FILE, JSON.stringify(status, null, 2));
  return true;
}

export function isDraft(shop, productSourceId) {
  const status = JSON.parse(fs.readFileSync(DRAFT_STATUS_FILE, 'utf8'));
  return status[shop]?.[productSourceId]?.sentToDraft || false;
}

export function clearDraftStatus(shop, productSourceIds) {
  const status = JSON.parse(fs.readFileSync(DRAFT_STATUS_FILE, 'utf8'));
  if (!status[shop]) return true;
  productSourceIds.forEach(id => { delete status[shop][id]; });
  fs.writeFileSync(DRAFT_STATUS_FILE, JSON.stringify(status, null, 2));
  return true;
}

export function clearAllDraftStatus(shop) {
  const status = JSON.parse(fs.readFileSync(DRAFT_STATUS_FILE, 'utf8'));
  status[shop] = {};
  fs.writeFileSync(DRAFT_STATUS_FILE, JSON.stringify(status, null, 2));
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCAN HISTORY
// ═══════════════════════════════════════════════════════════════════════════

const MAX_HISTORY_PER_SHOP = 50;

export function saveScanHistory(shop, scanResult) {
  const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8'));
  if (!data[shop]) data[shop] = [];
  const entry = {
    id:             Date.now().toString(),
    scannedAt:      new Date().toISOString(),
    competitorName: scanResult.competitorName || '',
    competitorUrl:  scanResult.competitorUrl  || '',
    competitorId:   scanResult.competitorId   || '',
    brands:         scanResult.brands         || [],
    summary:        scanResult.summary        || {},
    missingCount:   scanResult.missing?.length  || 0,
    matchedCount:   scanResult.matched?.length  || 0,
    scrapedCount:   scanResult.scrapedCount    || 0,
    result: {
      missing:        scanResult.missing        || [],
      matched:        scanResult.matched        || [],
      summary:        scanResult.summary        || {},
      competitorName: scanResult.competitorName || '',
      competitorUrl:  scanResult.competitorUrl  || '',
      brands:         scanResult.brands         || [],
      scrapedCount:   scanResult.scrapedCount   || 0,
    },
  };
  data[shop].unshift(entry);
  data[shop] = data[shop].slice(0, MAX_HISTORY_PER_SHOP);
  fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify(data, null, 2));
  return entry;
}

export function getScanHistory(shop) {
  const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8'));
  return (data[shop] || []).map(e => ({
    id:             e.id,
    scannedAt:      e.scannedAt,
    competitorName: e.competitorName,
    competitorUrl:  e.competitorUrl,
    competitorId:   e.competitorId,
    brands:         e.brands,
    summary:        e.summary,
    missingCount:   e.missingCount,
    matchedCount:   e.matchedCount,
    scrapedCount:   e.scrapedCount,
  }));
}

export function getScanHistoryEntry(shop, id) {
  const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8'));
  return (data[shop] || []).find(e => e.id === id) || null;
}

export function deleteScanHistoryEntry(shop, id) {
  const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8'));
  if (!data[shop]) return null;
  const entry = data[shop].find(e => e.id === id);
  data[shop] = data[shop].filter(e => e.id !== id);
  fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify(data, null, 2));
  return entry;
}

export function updateScanHistoryEntry(shop, id, updates) {
  const data = JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8'));
  if (!data[shop]) return null;
  const idx = data[shop].findIndex(e => e.id === id);
  if (idx === -1) return null;

  // Merge updates
  data[shop][idx] = { ...data[shop][idx], ...updates };

  // Always recalculate top-level counts from result arrays
  if (updates.result) {
    const r = updates.result;
    data[shop][idx].result       = r;
    data[shop][idx].missingCount = r.missing?.length  ?? data[shop][idx].missingCount;
    data[shop][idx].matchedCount = r.matched?.length  ?? data[shop][idx].matchedCount;

    // Rebuild summary from current missing/matched so history list shows correct counts
    const allProducts = [...(r.missing||[]), ...(r.matched||[])];
    const vendorMap = {};
    allProducts.forEach(p => {
      const v = (p.vendor||'').trim(); if (!v) return;
      const key = v.toLowerCase();
      if (!vendorMap[key]) vendorMap[key] = v;
    });
    const summary = {};
    for (const [bLower, canonical] of Object.entries(vendorMap)) {
      summary[canonical] = {
        total:   allProducts.filter(p => (p.vendor||'').toLowerCase() === bLower).length,
        missing: (r.missing||[]).filter(p => (p.vendor||'').toLowerCase() === bLower).length,
        matched: (r.matched||[]).filter(p => (p.vendor||'').toLowerCase() === bLower).length,
      };
    }
    data[shop][idx].summary = summary;
  }

  fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify(data, null, 2));
  return data[shop][idx];
}

// ═══════════════════════════════════════════════════════════════════════════
// WATCHLIST — products with partially unavailable variants
// Persists to backend/data/watchlist.json
// Only removed when all variants are scraped as available, or by user
// ═══════════════════════════════════════════════════════════════════════════

export function getWatchlistItems(shop) {
  const data = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
  return data[shop] || [];
}

export function saveWatchlistItems(shop, items) {
  const data = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8'));
  data[shop] = items;
  fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(data, null, 2));
}

export function addToWatchlist(shop, newItems) {
  const existing   = getWatchlistItems(shop);
  const existIds   = new Set(existing.map(w => w.sourceId));
  const toAdd      = newItems.filter(w => !existIds.has(w.sourceId));
  if (!toAdd.length) return 0;
  const updated = [...toAdd, ...existing].slice(0, 500);
  saveWatchlistItems(shop, updated);
  return toAdd.length;
}

export function updateWatchlistItem(shop, sourceId, updates) {
  const items = getWatchlistItems(shop);
  const idx   = items.findIndex(w => w.sourceId === sourceId);
  if (idx === -1) return false;
  items[idx] = { ...items[idx], ...updates };
  saveWatchlistItems(shop, items);
  return true;
}

export function removeWatchlistItem(shop, sourceId) {
  const items   = getWatchlistItems(shop);
  const updated = items.filter(w => w.sourceId !== sourceId);
  saveWatchlistItems(shop, updated);
  return items.length !== updated.length;
}

export function removeWatchlistItems(shop, sourceIds) {
  const set     = new Set(sourceIds);
  const items   = getWatchlistItems(shop);
  const updated = items.filter(w => !set.has(w.sourceId));
  saveWatchlistItems(shop, updated);
  return items.length - updated.length;
}

export function clearWatchlistItems(shop) {
  saveWatchlistItems(shop, []);
}