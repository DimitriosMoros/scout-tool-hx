import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeCompetitor } from './scraper.js';
import { gapAnalysis } from './gapAnalysis.js';
import { createDraftProducts, getShopifyProducts, getToken, initToken } from './shopify.js';
import { exportToExcel } from './excelExport.js';
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

app.post('/api/scrape', requireAuth, (req, res) => {
  const { competitorUrl, competitorName, brands, competitorId, useCache, maxProducts, maxPages } = req.body;
  if (!competitorUrl) return res.status(400).json({ error: 'competitorUrl required' });
  const jobId = Date.now().toString();
  jobStore.create(jobId, { shop: req.shop, competitorUrl, competitorName, brands });
  runScrapeJob(jobId, req.shop, req.shopToken, { competitorUrl, competitorName, brands, competitorId, useCache, maxProducts, maxPages })
    .catch(err => jobStore.fail(jobId, err.message));
  res.json({ jobId });
});

app.get('/api/scrape/:jobId', requireAuth, (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

async function runScrapeJob(jobId, shop, token, { competitorUrl, competitorName, brands, competitorId, useCache, maxProducts, maxPages }) {
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
        maxPages:    maxPages    || 5,
        skipIds:     useCache && cachedIds.size ? cachedIds : new Set(),
      };
      console.log(`[Scrape] Options: maxProducts=${scrapeOptions.maxProducts}, maxPages=${scrapeOptions.maxPages}, skipIds=${scrapeOptions.skipIds.size}`);

      const freshProducts = await scrapeCompetitor(competitorUrl, brands, (msg, pct) => {
        jobStore.update(jobId, { message: msg, progress: Math.min(pct, 44) });
      }, jobId, scrapeOptions);

      if (!freshProducts.length && !cachedProducts.length) {
        return jobStore.fail(jobId, 'No products found on competitor site.');
      }

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

    // Tag all scraped products
    competitorProducts = competitorProducts.map(p => ({
      ...p,
      tags: [...new Set(
        [p.tags, 'Scraped', competitorName]
          .flatMap(t => (t || '').split(',').map(s => s.trim()))
          .filter(Boolean)
      )].join(', '),
    }));

    // ── Fetch ONLY the vendors present in scraped products from Shopify ─────
    // This ensures we never pull the whole catalogue — only specific vendors
    // Apply vendor aliases so we fetch "Quadlock" not "Quad" from Shopify
    const VENDOR_ALIASES = {
      'quad':      'Quadlock',
      'quad lock': 'Quadlock',
    };
    const scrapedVendors = [...new Set(
      competitorProducts.map(p => {
        const v = (p.vendor || '').trim();
        return VENDOR_ALIASES[v.toLowerCase()] || v;
      }).filter(Boolean)
    )];
    const vendorsToFetch = scrapedVendors.length > 0 ? scrapedVendors
      : (brands && brands.length ? brands : null);

    if (!vendorsToFetch || !vendorsToFetch.length) {
      return jobStore.fail(jobId, 'Could not determine vendor names from scraped products. Add a brand filter and try again.');
    }

    console.log(`[Compare] Fetching Shopify products for vendors: ${vendorsToFetch.join(', ')}`);
    jobStore.update(jobId, {
      status: 'comparing', progress: 50,
      message: `Loading ${vendorsToFetch.join(', ')} from your Shopify store...`,
    });

    const hostProducts = await getShopifyProducts(shop, token, { vendors: vendorsToFetch });

    jobStore.update(jobId, { progress: 70, message: 'Running gap analysis...' });
    const { missing, matched, summary, variantGaps } = gapAnalysis(competitorProducts, hostProducts, brands);

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
    if (successfulIds.length) storage.markAsDraft(req.shop, successfulIds);
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
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { scrapeAMX } = await import('./amxScraper.js');
    const products = await scrapeAMX(url, [], () => {}, null, { maxProducts: 1, maxPages: 1 });
    if (!products.length) return res.status(404).json({ error: 'Product not found or could not be scraped' });
    res.json({ product: products[0] });
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
const server = app.listen(PORT, async () => {
  console.log(`\n  Competitor Scout running`);
  console.log(`  Shop : ${SHOP}`);
  console.log(`  Open : http://localhost:${PORT}\n`);
  await initToken(SHOP);
  if (process.platform === 'win32') {
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