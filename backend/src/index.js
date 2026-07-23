import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeCompetitor } from './scraper.js';
import { gapAnalysis } from './gapAnalysis.js';
import { addProductTags, createDraftProducts, getShopifyProducts, getToken, initToken, searchShopifyProducts } from './shopify.js';
import { exportToExcel } from './excelExport.js';
import { MOTO_MAKES, generateTags } from './utils.js';
import { jobStore } from './jobStore.js';
import * as storage from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

const SHOP  = (process.env.SHOPIFY_STORE_DOMAIN || '').split('//').pop().split('/')[0];
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

if (!SHOP) {
  console.error('Missing SHOPIFY_STORE_DOMAIN in .env');
  process.exit(1);
}

const hasOAuth  = process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET;
const hasStatic = TOKEN;

if (!hasOAuth && !hasStatic) {
  console.error('Missing credentials in .env — need either:');
  console.error('  SHOPIFY_ACCESS_TOKEN  (static token), OR');
  console.error('  SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  (auto-refresh)');
  process.exit(1);
}

function requireAuth(req, res, next) {
  const secret = req.headers['x-app-secret'];
  if (process.env.APP_SECRET && secret !== process.env.APP_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.shop = SHOP;
  req.shopToken = TOKEN;
  next();
}

app.get('/api/competitors', requireAuth, (req, res) => {
  res.json(storage.getCompetitors(req.shop));
});

app.post('/api/competitors', requireAuth, (req, res) => {
  const { name, url, brands } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const entry = storage.saveCompetitor(req.shop, { name, url, brands: brands || [] });
  res.json(entry);
});

app.put('/api/competitors/:id', requireAuth, (req, res) => {
  const updated = storage.updateCompetitor(req.shop, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
});

app.delete('/api/competitors/:id', requireAuth, (req, res) => {
  storage.deleteCompetitor(req.shop, req.params.id);
  res.json({ ok: true });
});

app.get('/api/shop', requireAuth, async (req, res) => {
  try {
    const tok  = await getToken(req.shop) || req.shopToken;
    const r    = await fetch(`https://${req.shop}/admin/api/2025-01/shop.json`, {
      headers: { 'X-Shopify-Access-Token': tok }
    });
    const data = await r.json();
    res.json(data.shop || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/host-products', requireAuth, async (req, res) => {
  try {
    const vendor  = req.query.vendor  || null;
    const vendors = req.query.vendors ? req.query.vendors.split(',').filter(Boolean) : null;
    if (!vendor && (!vendors || !vendors.length)) {
      return res.status(400).json({ error: 'vendor or vendors param required — will not fetch entire catalogue' });
    }
    const products = await getShopifyProducts(req.shop, req.shopToken, { vendor, vendors });
    res.json({ products, total: products.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vendors', requireAuth, async (req, res) => {
  try {
    const vendors = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const query = `{
        productVendors(first: 1000${cursor ? `, after: "${cursor}"` : ''}) {
          nodes
          pageInfo { hasNextPage endCursor }
        }
      }`;

      const tok = await getToken(req.shop) || req.shopToken;
      const r = await fetch(`https://${req.shop}/admin/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (!r.ok) throw new Error(`Shopify GraphQL ${r.status}`);
      const data = await r.json();
      if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');

      const pv = data?.data?.productVendors;
      (pv?.nodes || []).forEach(v => { if (v) vendors.push(v); });
      hasNextPage = pv?.pageInfo?.hasNextPage || false;
      cursor      = pv?.pageInfo?.endCursor   || null;
    }

    vendors.sort();
    console.log(`[Vendors] Loaded ${vendors.length} vendors via GraphQL`);
    res.json({ vendors });
  } catch (err) {
    console.error('[Vendors] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/product-types', requireAuth, async (req, res) => {
  try {
    const { vendor } = req.query;
    const types = [];
    const tagSet = new Set();
    let cursor = null;
    let hasNextPage = true;
    let page = 0;

    // With a vendor: collect distinct types from that vendor's products only.
    // Without: the global productTypes connection (all types in the store).
    const escVendor = vendor ? String(vendor).replace(/\\/g, '').replace(/'/g, "\\'").replace(/"/g, '') : '';

    while (hasNextPage && page < 8) {
      page++;
      const query = vendor ? `{
        products(first: 250, query: "vendor:'${escVendor.replace(/"/g, '\\"')}'"${cursor ? `, after: "${cursor}"` : ''}) {
          nodes { productType tags }
          pageInfo { hasNextPage endCursor }
        }
      }` : `{
        productTypes(first: 1000${cursor ? `, after: "${cursor}"` : ''}) {
          nodes
          pageInfo { hasNextPage endCursor }
        }
      }`;

      const tok = await getToken(req.shop) || req.shopToken;
      const r = await fetch(`https://${req.shop}/admin/api/2025-01/graphql.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (!r.ok) throw new Error(`Shopify GraphQL ${r.status}`);
      const data = await r.json();
      if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');

      const pt = vendor ? data?.data?.products : data?.data?.productTypes;
      (pt?.nodes || []).forEach(t => {
        const val = vendor ? t?.productType : t;
        if (val && !types.includes(val)) types.push(val);
        if (vendor && Array.isArray(t?.tags)) t.tags.forEach(tag => { if (tag) tagSet.add(tag); });
      });
      hasNextPage = pt?.pageInfo?.hasNextPage || false;
      cursor      = pt?.pageInfo?.endCursor   || null;
    }

    types.sort();
    const tags = [...tagSet].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    res.json({ types, tags });
  } catch (err) {
    console.error('[ProductTypes] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(storage.getStats());
});

// ── Tag Manager — search host products & bulk-add tags ────────────────────────
app.get('/api/store-products', requireAuth, async (req, res) => {
  try {
    const { vendor, type, tag, q } = req.query;
    if (!vendor && !type && !tag && !q) {
      return res.status(400).json({ error: 'Provide a vendor, product type, tag or search text — will not fetch entire catalogue' });
    }
    const products = await searchShopifyProducts(req.shop, req.shopToken, { vendor, productType: type, tag, text: q });
    res.json({ products, total: products.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/store-products/add-tags', requireAuth, async (req, res) => {
  try {
    const { productIds, tags } = req.body;
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds required' });
    const cleanTags = (Array.isArray(tags) ? tags : []).map(t => String(t).trim()).filter(Boolean);
    if (!cleanTags.length) return res.status(400).json({ error: 'At least one tag required' });

    console.log(`[TagManager] Adding [${cleanTags.join(', ')}] to ${productIds.length} products`);
    const result = await addProductTags(req.shop, req.shopToken, productIds, cleanTags);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suggest-tags', requireAuth, (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'products required' });

  const tagMap = new Map(); // tag → Set<productId>
  for (const p of products) {
    const existingLower = new Set((p.existingTags || []).map(t => t.toLowerCase()));
    const generated = generateTags(
      { title: p.title || '', description: '', variants: [], productType: p.productType || '' },
      p.vendor || ''
    ).split(', ').filter(Boolean);
    for (const tag of generated) {
      if (!existingLower.has(tag.toLowerCase())) {
        if (!tagMap.has(tag)) tagMap.set(tag, new Set());
        tagMap.get(tag).add(p.id);
      }
    }
  }

  const suggestions = [...tagMap.entries()].map(([tag, ids]) => ({ tag, productIds: [...ids] }));
  res.json({ suggestions });
});

// ── Discovery module router ───────────────────────────────────────────────────
async function getDiscoveryModule(competitorUrl) {
  if (competitorUrl.includes('amxsuperstores.com.au')) return import('./amxScraper.js');
  if (competitorUrl.includes('mcas.com.au'))           return import('./mcasScraper.js');
  if (competitorUrl.includes('roadstore.com.au'))      return import('./roadstoreScraper.js');
  return import('./motoheavenScraper.js');
}

// ── Competitor brand discovery ────────────────────────────────────────────────
const BRAND_REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days

app.get('/api/competitors/:id/brands', requireAuth, async (req, res) => {
  const competitor = storage.getCompetitors(req.shop).find(c => c.id === req.params.id);
  if (!competitor) return res.status(404).json({ error: 'Not found' });

  const forceRefresh = !!req.query.refresh;
  const catalog      = storage.getSiteCatalog(competitor.url);
  const hasCached    = catalog?.brands?.length > 0;
  const isStale      = !catalog?.lastChecked ||
    (Date.now() - new Date(catalog.lastChecked).getTime() > BRAND_REFRESH_INTERVAL);

  // Serve cached data immediately; trigger background refresh if stale
  if (hasCached && !forceRefresh) {
    const payload = { brands: catalog.brands, lastChecked: catalog.lastChecked, cached: true };
    if (isStale) payload.stale = true;
    res.json(payload);

    if (isStale) {
      console.log(`[Discovery] Brands stale for ${competitor.url} — refreshing in background`);
      setImmediate(async () => {
        try {
          const { discoverCompetitorBrands } = await getDiscoveryModule(competitor.url);
          const brands = await discoverCompetitorBrands(competitor.url);
          storage.saveSiteCatalog(competitor.url, { brands, lastChecked: new Date().toISOString() });
          console.log(`[Discovery] Background brand refresh done: ${brands.length} brands`);
        } catch (err) {
          console.error('[Discovery] Background brand refresh failed:', err.message);
        }
      });
    }
    return;
  }

  // No cache or forced refresh — synchronous discovery (user waits)
  try {
    console.log(`[Discovery] Discovering brands for ${competitor.name}`);
    const { discoverCompetitorBrands } = await getDiscoveryModule(competitor.url);
    const brands      = await discoverCompetitorBrands(competitor.url);
    const lastChecked = new Date().toISOString();
    // When forcing a full refresh, also wipe subcategory cache so stale subcats get re-discovered lazily
    const subcategoryUpdates = forceRefresh ? { subcategories: {} } : {};
    storage.saveSiteCatalog(competitor.url, { brands, lastChecked, ...subcategoryUpdates });
    res.json({ brands, lastChecked });
  } catch (err) {
    console.error('[Discovery] Brands error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Competitor subcategory discovery ──────────────────────────────────────────
app.get('/api/competitors/:id/subcategories', requireAuth, async (req, res) => {
  const { vendor } = req.query;
  if (!vendor) return res.status(400).json({ error: 'vendor required' });

  const competitor = storage.getCompetitors(req.shop).find(c => c.id === req.params.id);
  if (!competitor) return res.status(404).json({ error: 'Not found' });

  const cacheKey = vendor.toLowerCase();
  const catalog  = storage.getSiteCatalog(competitor.url);
  const cached   = catalog?.subcategories?.[cacheKey];

  if (cached) {
    console.log(`[Discovery] Serving ${cached.length} cached subcategories for ${vendor}`);
    return res.json({ subcategories: cached, cached: true });
  }

  // No cache — run Puppeteer to discover subcategories for this brand
  try {
    console.log(`[Discovery] Discovering subcategories for ${competitor.name}/${vendor}`);
    const { discoverCompetitorSubcategories } = await getDiscoveryModule(competitor.url);
    const subcategories = await discoverCompetitorSubcategories(competitor.url, vendor);
    const existing      = catalog?.subcategories || {};
    storage.saveSiteCatalog(competitor.url, {
      subcategories: { ...existing, [cacheKey]: subcategories },
    });
    res.json({ subcategories });
  } catch (err) {
    console.error('[Discovery] Subcategories error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape', requireAuth, (req, res) => {
  const { competitorId, vendor, vendorHandle, subcategoryParam, useCache, maxProducts } = req.body;
  if (!competitorId) return res.status(400).json({ error: 'competitorId required' });
  if (!vendor) return res.status(400).json({ error: 'vendor required' });

  const competitor = storage.getCompetitors(req.shop).find(c => c.id === competitorId);
  if (!competitor) return res.status(404).json({ error: 'Competitor not found' });

  // Build collection URL — path prefix varies by site
  const slug       = vendorHandle || vendor.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  let pathPrefix = 'collections';
  if (competitor.url.includes('amxsuperstores.com.au')) pathPrefix = 'brands';
  else if (competitor.url.includes('mcas.com.au'))      pathPrefix = 'brand';
  else if (competitor.url.includes('roadstore.com.au')) pathPrefix = 'brand';
  const baseCompUrl = `${competitor.url.replace(/\/$/, '')}/${pathPrefix}/${slug}`;
  let competitorUrl;
  if (subcategoryParam) {
    if (subcategoryParam.startsWith('#')) {
      // Hash-based filter (Road Store SearchSpring) — append directly after trailing slash
      competitorUrl = `${baseCompUrl}/${subcategoryParam}`;
    } else {
      const url = new URL(baseCompUrl);
      new URLSearchParams(subcategoryParam).forEach((v, k) => url.searchParams.set(k, v));
      competitorUrl = url.toString();
    }
  } else {
    competitorUrl = baseCompUrl;
  }

  const competitorName = competitor.name;
  const brands         = [vendor];

  const jobId = Date.now().toString();
  jobStore.create(jobId, { shop: req.shop, competitorUrl, competitorName, brands });
  runScrapeJob(jobId, req.shop, req.shopToken, {
    competitorUrl, competitorName, brands, competitorId, useCache, maxProducts, explicitVendor: vendor,
  }).catch(err => jobStore.fail(jobId, err.message));
  res.json({ jobId });
});

app.get('/api/scrape/:jobId', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

async function runScrapeJob(jobId, shop, token, { competitorUrl, competitorName, brands, competitorId, useCache, maxProducts, explicitVendor }) {
  try {
    jobStore.update(jobId, { status: 'scraping', progress: 5, message: `Connecting to ${competitorName || competitorUrl}...` });

    let competitorProducts = [];

    // Load existing cached products (always — to merge with new scrape)
    let cachedProducts = [];
    if (competitorId) {
      const cached = storage.getScrapedProducts(shop, competitorId);
      if (cached.products && cached.products.length) {
        cachedProducts = cached.products;
        console.log(`[Cache] Found ${cachedProducts.length} previously scraped products from ${cached.scrapedAt}`);
        // When scanning a specific vendor, ignore cached products from other vendors
        if (explicitVendor) {
          const evLower = explicitVendor.toLowerCase();
          const filtered = cachedProducts.filter(p => (p.vendor || '').toLowerCase() === evLower);
          if (filtered.length !== cachedProducts.length) {
            console.log(`[Cache] Filtered to vendor "${explicitVendor}": ${filtered.length} of ${cachedProducts.length} cached products`);
          }
          cachedProducts = filtered;
        }
      }
    }

{
      // Build set of already-scraped IDs to skip when cache is enabled
      const cachedIds = new Set(cachedProducts.map(p => p.sourceId || p.handle).filter(Boolean));

      if (useCache && cachedIds.size) {
        console.log(`[Cache] Continuation mode — skipping ${cachedIds.size} already-scraped products, scraping next ${maxProducts || 20} new ones`);
      }

      const scrapeOptions = {
        maxProducts: maxProducts || 20,
        maxPages:    20,
        skipIds:     useCache && cachedIds.size ? cachedIds : new Set(),
      };
      console.log(`[Scrape] Options: maxProducts=${scrapeOptions.maxProducts}, maxPages=${scrapeOptions.maxPages}, skipIds=${scrapeOptions.skipIds.size}`);

      const freshProducts = await scrapeCompetitor(competitorUrl, brands, (msg, pct) => {
        jobStore.update(jobId, { message: msg, progress: Math.min(pct, 44) });
      }, jobId, scrapeOptions);

      if (!freshProducts.length && !cachedProducts.length) {
        return jobStore.fail(jobId, 'No products found on competitor site.');
      }

      if (freshProducts.length) storage.incrementStats({ productsScanned: freshProducts.length });

      // Merge: cached products + fresh products, deduped by sourceId/handle
      const seenIds = new Set();
      const merged  = [];
      for (const p of [...cachedProducts, ...freshProducts]) {
        const key = p.sourceId || p.handle;
        if (key && seenIds.has(key)) continue;
        if (key) seenIds.add(key);
        merged.push(p);
      }

      competitorProducts = merged;
      console.log(`[Cache] Merged: ${cachedProducts.length} cached + ${freshProducts.length} fresh = ${merged.length} total (${merged.length - cachedProducts.length - freshProducts.length + (merged.length)} unique)`);

      // Save merged results back to cache
      if (competitorId) {
        storage.saveScrapedProducts(shop, competitorId, competitorProducts);
        console.log(`[Cache] Saved ${competitorProducts.length} products to cache`);
      }
    }

    // Tag all scraped products.
    // "Scraped" marks every competitor product for Shopify collection/automation.
    // "Site_bikebiz" (etc.) uses the reliable sourcePlatform field — not the
    // user-typed competitor name which can contain typos or arbitrary text.
    competitorProducts = competitorProducts.map(p => {
      const siteTag = p.sourcePlatform ? `Site_${p.sourcePlatform}` : null;
      return {
        ...p,
        tags: [...new Set(
          [p.tags, 'Scraped', siteTag]
            .flatMap(t => (t || '').split(',').map(s => s.trim()))
            .filter(Boolean)
        )].join(', '),
      };
    });

    // ── Determine which vendors to fetch from Shopify ────────────────────────
    let vendorsToFetch;
    if (explicitVendor) {
      // User chose a specific vendor at scan time — fetch only that vendor.
      // Skipping auto-discovery prevents pulling unrelated brands from Shopify.
      vendorsToFetch = [explicitVendor];
      console.log(`[Compare] Explicit vendor — fetching only: ${explicitVendor}`);
    } else {
      // Legacy path: auto-discover vendors from scraped product records
      const VENDOR_ALIASES = { 'quad': 'Quadlock', 'quad lock': 'Quadlock' };
      const scrapedVendors = [...new Set(
        competitorProducts.map(p => {
          const v = (p.vendor || '').trim();
          return VENDOR_ALIASES[v.toLowerCase()] || v;
        }).filter(Boolean)
      )];
      const makeVendors = [...new Set(
        competitorProducts.flatMap(p => MOTO_MAKES.filter(m => {
          const escaped = m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[\\-\\s]');
          return new RegExp(`\\b${escaped}\\b`, 'i').test(p.title || '');
        }))
      )];
      if (makeVendors.length) console.log(`[Compare] Bike makes in titles — also fetching vendors: ${makeVendors.join(', ')}`);
      const allVendors = [...new Set([...scrapedVendors, ...makeVendors])];
      vendorsToFetch = allVendors.length > 0 ? allVendors : (brands?.length ? brands : null);
      if (!vendorsToFetch?.length) {
        return jobStore.fail(jobId, 'Could not determine vendor names from scraped products.');
      }
    }

    console.log(`[Compare] Fetching Shopify products for vendors: ${vendorsToFetch.join(', ')}`);
    jobStore.update(jobId, {
      status: 'comparing', progress: 50,
      message: `Loading ${vendorsToFetch.join(', ')} from your Shopify store...`,
    });

    const hostProducts = await getShopifyProducts(shop, token, { vendors: vendorsToFetch });

    jobStore.update(jobId, { progress: 70, message: 'Running gap analysis...' });
    const { missing, matched, summary, variantGaps } = gapAnalysis(competitorProducts, hostProducts, brands);

    if (missing.length) storage.incrementStats({ productsMissing: missing.length });

    const draftStatus = storage.getDraftStatus(shop);
    missing.forEach(p => { p.isDraft = draftStatus[p.sourceId] || false; });
    matched.forEach(p => { p.isDraft = draftStatus[p.sourceId] || false; });

    jobStore.update(jobId, {
      status: 'done', progress: 100,
      message: `Found ${missing.length} missing products (${matched.length} already stocked)`,
      result: { missing, matched, summary, variantGaps: variantGaps || [], competitorUrl, competitorName, brands, scrapedCount: competitorProducts.length },
    });

    storage.saveScanHistory(shop, { missing, matched, variantGaps: variantGaps || [], summary, competitorUrl, competitorName, competitorId, brands, scrapedCount: competitorProducts.length });

  } catch (err) { jobStore.fail(jobId, err.message); }
}

app.post('/api/create-drafts', requireAuth, async (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || !products.length) {
    return res.status(400).json({ error: 'products array required' });
  }
  try {
    const results = await createDraftProducts(req.shop, req.shopToken, products);
    const createdTitles = new Set((results.created || []).map(c => c.title));
    const successfulIds = products
      .filter(p => createdTitles.has(p.title))
      .map(p => p.sourceId)
      .filter(Boolean);
    if (successfulIds.length) {
      storage.markAsDraft(req.shop, successfulIds);
      storage.incrementStats({ productsUploaded: successfulIds.length });
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/draft-status/clear', requireAuth, (req, res) => {
  const { sourceIds } = req.body;
  if (!Array.isArray(sourceIds)) return res.status(400).json({ error: 'sourceIds array required' });
  storage.clearDraftStatus(req.shop, sourceIds);
  res.json({ ok: true, cleared: sourceIds.length });
});

app.delete('/api/draft-status', requireAuth, (req, res) => {
  storage.clearAllDraftStatus(req.shop);
  res.json({ ok: true });
});

app.get('/api/cache', requireAuth, (req, res) => {
  res.json(storage.getAllScrapedCache(req.shop));
});

app.delete('/api/cache/:competitorId', requireAuth, (req, res) => {
  storage.clearScrapedCache(req.shop, req.params.competitorId);
  res.json({ ok: true });
});

app.delete('/api/cache', requireAuth, (req, res) => {
  const cache = storage.getAllScrapedCache(req.shop);
  Object.keys(cache).forEach(id => storage.clearScrapedCache(req.shop, id));
  res.json({ ok: true });
});

app.post('/api/export', requireAuth, async (req, res) => {
  const { products, competitorName } = req.body;
  if (!products?.length) return res.status(400).json({ error: 'No products' });
  try {
    const buffer = await exportToExcel(products, competitorName || 'Export');
    const name   = `missing-${(competitorName || 'export').replace(/\s+/g, '-')}-${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(Buffer.from(buffer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scrape/:jobId/cancel', requireAuth, (req, res) => {
  const cancelled = jobStore.cancel(req.params.jobId);
  res.json({ ok: cancelled });
});

app.get('/api/scan-history', requireAuth, (req, res) => {
  res.json(storage.getScanHistory(req.shop));
});

app.get('/api/scan-history/:id', requireAuth, (req, res) => {
  const entry = storage.getScanHistoryEntry(req.shop, req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json(entry);
});

app.put('/api/scan-history/:id', requireAuth, (req, res) => {
  const updated = storage.updateScanHistoryEntry(req.shop, req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/scan-history/:id', requireAuth, (req, res) => {
  const deleted = storage.deleteScanHistoryEntry(req.shop, req.params.id);
  if (deleted?.competitorId) {
    storage.clearScrapedCache(req.shop, deleted.competitorId);
    console.log(`[Cache] Cleared scraped cache for competitor ${deleted.competitorId}`);
  }
  res.json({ ok: true });
});

app.get('/api/watchlist', requireAuth, (req, res) => {
  res.json(storage.getWatchlistItems(req.shop));
});

app.post('/api/watchlist', requireAuth, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  const added = storage.addToWatchlist(req.shop, items);
  res.json({ ok: true, added });
});

app.put('/api/watchlist/:sourceId', requireAuth, (req, res) => {
  const sourceId = decodeURIComponent(req.params.sourceId);
  const updated  = storage.updateWatchlistItem(req.shop, sourceId, req.body);
  res.json({ ok: updated });
});

app.delete('/api/watchlist/:sourceId', requireAuth, (req, res) => {
  const sourceId = decodeURIComponent(req.params.sourceId);
  storage.removeWatchlistItem(req.shop, sourceId);
  res.json({ ok: true });
});

app.post('/api/watchlist/remove-many', requireAuth, (req, res) => {
  const { sourceIds } = req.body;
  if (!Array.isArray(sourceIds)) return res.status(400).json({ error: 'sourceIds array required' });
  const removed = storage.removeWatchlistItems(req.shop, sourceIds);
  res.json({ ok: true, removed });
});

app.delete('/api/watchlist', requireAuth, (req, res) => {
  storage.clearWatchlistItems(req.shop);
  res.json({ ok: true });
});

app.get('/api/watchlist/download', requireAuth, (req, res) => {
  const items = storage.getWatchlistItems(req.shop);
  const name  = `watchlist-${req.shop}-${new Date().toISOString().slice(0,10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(JSON.stringify(items, null, 2));
});

app.post('/api/rescrape-product', requireAuth, async (req, res) => {
  const { url, sourceId } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    let products;
    if (/bikebiz\.com\.au/i.test(url)) {
      const { scrapeBikebizProduct } = await import('./bikebizScraper.js');
      products = await scrapeBikebizProduct(url);
    } else if (/roadstore\.com\.au/i.test(url)) {
      const { scrapeRoadstoreProduct } = await import('./roadstoreScraper.js');
      products = await scrapeRoadstoreProduct(url);
    } else {
      const { scrapeAMX } = await import('./amxScraper.js');
      products = await scrapeAMX(url, [], () => {}, null, { maxProducts: 1, maxPages: 1 });
    }
    if (!products.length) return res.status(404).json({ error: 'Product not found or could not be scraped' });
    // Colour-bundled pages share one URL — pick the colour this watchlist item tracks
    const product = (sourceId && products.find(p => p.sourceId === sourceId)) || products[0];
    res.json({ product });
  } catch (err) {
    console.error('[Rescrape] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, shop: SHOP, ts: Date.now() }));

app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ── Live log streaming ────────────────────────────────────────────────────────
const logClients = new Set();
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);

function broadcastLog(level, args) {
  const line = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  const payload = JSON.stringify({ level, line, ts: Date.now() });
  for (const res of logClients) {
    try { res.write(`data: ${payload}\n\n`); } catch(_) { logClients.delete(res); }
  }
}

console.log   = (...args) => { _origLog(...args);   broadcastLog('log',   args); };
console.error = (...args) => { _origError(...args); broadcastLog('error', args); };

app.get('/api/logs', requireAuth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ level: 'log', line: '-- Log stream connected --', ts: Date.now() })}\n\n`);
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true, message: 'Server shutting down...' });
  console.log('\n  Shutdown requested via UI');
  setTimeout(() => process.exit(0), 500);
});

const PORT   = process.env.PORT || 3001;

// Open the browser only on a fresh launch — not when the server restarts
// (e.g. watch mode reacting to OneDrive touching files), which would keep
// opening extra tabs. Marker lives in the OS temp dir so it is never synced.
const LAUNCH_MARKER = path.join(os.tmpdir(), 'competitor-scout.last-launch');
function shouldOpenBrowser() {
  try {
    const last = Number(fs.readFileSync(LAUNCH_MARKER, 'utf8'));
    if (Date.now() - last < 2 * 60 * 1000) return false;
  } catch (_) {}
  try { fs.writeFileSync(LAUNCH_MARKER, String(Date.now())); } catch (_) {}
  return true;
}

const server = app.listen(PORT, async () => {
  console.log(`\n  Competitor Scout running`);
  console.log(`  Shop : ${SHOP}`);
  console.log(`  Open : http://localhost:${PORT}\n`);
  await initToken(SHOP);
  if (process.platform === 'win32' && shouldOpenBrowser()) {
    import('child_process').then(({ exec }) => exec(`start http://localhost:${PORT}`));
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} already in use.`);
    console.error(`  Run: Get-Process -Name node | Stop-Process -Force\n`);
    process.exit(1);
  } else throw err;
});