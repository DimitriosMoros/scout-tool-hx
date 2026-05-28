/**
 * Motoheaven Scraper
 *
 * Motoheaven is a Shopify store that blocks server-side requests (403).
 * Strategy:
 *  1. Use Puppeteer to load the collection page (bypasses Cloudflare)
 *  2. Extract product handles from collection links
 *  3. For each handle, fetch /products/{handle}.json via the browser page
 *     (same session = no 403) to get clean Shopify JSON with all variants
 *
 * This gives us perfect data: titles, SKUs, barcodes, prices, images, availability.
 */

import puppeteer from 'puppeteer-core';
import { jobStore } from './jobStore.js';

const BASE = 'https://motoheaven.com.au';

const MAX_PAGES_PER_COLLECTION = 5;
const MAX_PRODUCTS_TO_SCRAPE   = 20;

// ── Puppeteer launcher ────────────────────────────────────────────────────────
async function openBrowser() {
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  if (process.env.CHROME_PATH) chromePaths.unshift(process.env.CHROME_PATH);

  const { existsSync } = await import('fs');
  const executablePath = chromePaths.find(p => existsSync(p));

  if (!executablePath) {
    throw new Error('Chrome not found. Set CHROME_PATH in your .env file.');
  }

  const proxyUrl = process.env.SCRAPER_PROXY || null;
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
  ];
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args,
    defaultViewport: { width: 1280, height: 900 },
  });

  return browser;
}

async function newPage(browser, proxyUrl) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en-US;q=0.9' });

  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      if (u.username && u.password) {
        await page.authenticate({ username: u.username, password: decodeURIComponent(u.password) });
      }
    } catch(_) {}
  }

  return page;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function scrapeMotoheaven(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_TO_SCRAPE;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_PER_COLLECTION;
  const proxyUrl     = process.env.SCRAPER_PROXY || null;

  const startTime = Date.now();
  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });

  onProgress('Starting Motoheaven scan...', 5);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🏍️  Motoheaven Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${baseUrl}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Max products : ${MAX_PRODUCTS} | Max pages: ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let browser;
  try {
    browser = await openBrowser();
    const page = await newPage(browser, proxyUrl);

    // ── Step 1: Crawl collection for product handles ──────────────────────────
    onProgress('Crawling Motoheaven collection...', 10);
    const handles = await crawlCollection(page, baseUrl, brands, onProgress, jobId, MAX_PRODUCTS, MAX_PAGES);

    if (!handles.length) throw new Error('No products found. Check URL and brand filters.');
    console.log(`[Motoheaven] Found ${handles.length} product handles`);

    // ── Step 2: Fetch each product's JSON via browser session ─────────────────
    onProgress(`Fetching ${handles.length} products...`, 30);
    const products = await fetchProducts(page, handles, brands, onProgress, jobId, MAX_PRODUCTS);

    await browser.close();

    const finishedAt    = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
    const elapsedSec    = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalVariants = products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);

    onProgress(`Extracted ${products.length} products, ${totalVariants} variants`, 90);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅  Motoheaven Scraper finished`);
    console.log(`  Started  : ${startedAt}`);
    console.log(`  Finished : ${finishedAt}`);
    console.log(`  Duration : ${elapsedSec}s`);
    console.log(`  Products : ${products.length}`);
    console.log(`  Variants : ${totalVariants}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    return products;

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

// ── Collection crawler ────────────────────────────────────────────────────────

async function crawlCollection(page, baseUrl, brands, onProgress, jobId, maxProducts, maxPages) {
  const handles = new Set();

  // Build clean base URL — strip page param
  const collUrl = new URL(baseUrl);
  collUrl.searchParams.delete('page');

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (handles.size >= maxProducts) break;
    if (jobId && jobStore.isCancelled(jobId)) { console.log('[Motoheaven] Cancelled'); break; }

    collUrl.searchParams.set('page', String(pageNum));
    const url = collUrl.toString();

    const ts = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`[Motoheaven] [${ts}] Collection page ${pageNum}: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      const found = await page.evaluate((brands, base) => {
        const links = document.querySelectorAll('a[href*="/products/"]');
        const seen  = new Set();
        const out   = [];

        links.forEach(a => {
          const href = a.href || '';
          if (!href.includes('/products/')) return;
          if (href.includes('/products/compare')) return;

          // Extract handle — strip query string and trailing slash
          const handle = href.split('/products/')[1]?.split('?')[0]?.split('#')[0]?.replace(/\/$/, '');
          if (!handle || seen.has(handle)) return;

          // Brand filter — check card text or URL
          if (brands.length) {
            const card = a.closest('[class*="card"], [class*="product"], li, article') || a;
            const text = card.textContent?.toLowerCase() || '';
            const matchesBrand = brands.some(b =>
              text.includes(b.toLowerCase()) || handle.toLowerCase().includes(b.toLowerCase())
            );
            if (!matchesBrand) return;
          }

          seen.add(handle);
          out.push(handle);
        });

        return out;
      }, brands, BASE);

      let added = 0;
      for (const h of found) {
        if (!handles.has(h)) { handles.add(h); added++; }
        if (handles.size >= maxProducts) break;
      }

      console.log(`  Page ${pageNum}: +${added} handles (${handles.size} total)`);
      onProgress(`Found ${handles.size} products...`, Math.min(10 + handles.size / 3, 28));

      if (found.length === 0) {
        console.log(`  No products on page ${pageNum} — stopping`);
        break;
      }

    } catch (e) {
      console.log(`[Motoheaven] Page ${pageNum} error: ${e.message.slice(0, 80)}`);
      break;
    }

    await sleep(500);
  }

  return [...handles];
}

// ── Product fetcher — uses /products/{handle}.json via browser ────────────────

async function fetchProducts(page, handles, brands, onProgress, jobId, maxProducts) {
  const products = [];
  const toFetch  = handles.slice(0, maxProducts);

  for (let i = 0; i < toFetch.length; i++) {
    if (jobId && jobStore.isCancelled(jobId)) {
      console.log(`[Motoheaven] Cancelled — collected ${products.length} products`);
      break;
    }

    const handle = toFetch[i];
    const ts     = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  [${i + 1}/${toFetch.length}] [${ts}] ${handle}`);

    try {
      // Fetch JSON via browser page (avoids 403) then parse full response
      const jsonUrl = `${BASE}/products/${handle}.json`;

      // Navigate to JSON URL — browser already has session cookies, no 403
      const response = await page.goto(jsonUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || !response.ok()) {
        console.log(`    ✗ HTTP ${response?.status()} for ${handle}`);
        continue;
      }

      // Get full response body (no truncation unlike page.evaluate return values)
      const bodyText = await response.text();
      let result;
      try { result = JSON.parse(bodyText); } catch(e) {
        console.log(`    ✗ JSON parse error: ${e.message.slice(0, 60)}`);
        continue;
      }

      if (!result?.product) {
        console.log(`    ✗ No product in response for ${handle}`);
        continue;
      }

      const p = result.product;

      const variants = (p.variants || []).map(v => {
        const salePrice     = parseFloat(v.price) || 0;
        const comparePrice  = v.compare_at_price ? parseFloat(v.compare_at_price) : null;

        // Use the ORIGINAL (compare_at) price as the listing price.
        // If no compare_at_price, the current price IS the regular price.
        const listingPrice  = comparePrice && comparePrice > salePrice ? comparePrice : salePrice;

        return {
          // id: intentionally omitted — Shopify assigns new IDs on import
          size:        v.option1 || v.title || 'Default',
          sku:         v.sku     || '',
          barcode:     v.barcode || '',
          price:       listingPrice,
          inventoryQty: v.inventory_quantity || 0,
          available:   v.available !== false,
          weightUnit:  v.weight_unit || 'kg',
          weight:      v.grams ? v.grams / 1000 : 0,
        };
      });

      const images = (p.images || [])
        .map(img => img.src)
        .filter(src => {
          if (!src) return false;
          const lower = src.toLowerCase();
          // Skip how-to/banner/lifestyle images — not product images
          if (/how.?to.?measure|banner|lifestyle|logo|placeholder|icon/i.test(lower)) return false;
          // Skip images with these keywords in the filename
          if (/measure|sizing|size.?guide|guide|header/i.test(lower)) return false;
          return true;
        });
      const prices = variants.map(v => v.price).filter(p => p > 0);

      const vendor = p.vendor || brands.find(b => (p.title || '').toLowerCase().includes(b.toLowerCase())) || '';

      const tsFound = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`  [${i + 1}/${toFetch.length}] [${tsFound}] ✓ ${p.title} (${variants.length} variants)`);

      products.push({
        sourceId:     String(p.id),
        handle:       p.handle,
        title:        p.title,
        description:  p.body_html || p.description || '',
        vendor,
        productType:  p.product_type || '',
        tags:         Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
        images,
        variants,
        priceMin:     prices.length ? Math.min(...prices) : 0,
        priceMax:     prices.length ? Math.max(...prices) : 0,
        sourceUrl:    `${BASE}/products/${handle}`,
        sourcePlatform: 'motoheaven',
      });

      onProgress(
        `[${i + 1}/${toFetch.length}] ${p.title}`,
        30 + Math.floor(((i + 1) / toFetch.length) * 58)
      );

    } catch (e) {
      console.log(`    ✗ Error: ${e.message.slice(0, 80)}`);
    }

    await sleep(300);
  }

  return products;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }