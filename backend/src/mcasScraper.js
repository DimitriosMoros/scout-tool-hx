/**
 * MCAS (Motorcycle Accessories Supermarket) Scraper
 *
 * MCAS is a custom platform (not Shopify). Key differences from AMX:
 * - Each size is a SEPARATE product with its own SKU (e.g. 1124085-p = S, 1124086-p = M)
 * - Product pages list sibling size SKUs in the description
 * - Brand pages at /brand/{slug}/ return static HTML — no JS rendering needed
 * - Collection pages with filters need Puppeteer
 * - Image URLs: https://www.mcas.com.au/assets/thumb/{sku}-p.jpg
 *
 * Strategy:
 *  1. Crawl brand page or filtered collection URL with Puppeteer
 *  2. Extract "parent" product URLs (the -p ones, which are the default size)
 *  3. For each parent, fetch the product page and extract:
 *     - Title, vendor, price, description, image
 *     - Sibling SKU list (all sizes) from the page
 *  4. Group all sibling SKUs into variants under one product
 *  5. Return normalised product objects matching AMX scraper output format
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import { jobStore } from './jobStore.js';

const BASE = 'https://www.mcas.com.au';

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const MAX_PAGES_PER_COLLECTION = 5;
const MAX_PRODUCTS_TO_SCRAPE   = 20;

// ══════════════════════════════════════════════════════════════════════════════

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
};

// ── Direct static fetch ───────────────────────────────────────────────────────
async function fetchPage(url, timeout = 30000) {
  try {
    const r = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout,
      validateStatus: s => true,
    });
    if (r.status === 200) return r.data;
    console.log(`  ✗ Failed (${r.status}): ${url.slice(0, 80)}`);
    return null;
  } catch (e) {
    console.log(`  ✗ Error: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ── Puppeteer launcher (local Chrome, same as AMX scraper) ───────────────────
async function openPuppeteerPage(url, timeout = 60000) {
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

  let executablePath = null;
  const { existsSync } = await import('fs');
  for (const p of chromePaths) {
    if (existsSync(p)) { executablePath = p; break; }
  }

  if (!executablePath) {
    console.log('  [Puppeteer] No Chrome found — using static fetch');
    return null;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
      defaultViewport: { width: 1280, height: 900 },
    });
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en-US;q=0.9' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout });
    return { page, browser };
  } catch (e) {
    console.log(`  [Puppeteer] Failed: ${e.message.slice(0, 80)}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function scrapeMCAS(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_TO_SCRAPE;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_PER_COLLECTION;

  const startTime = Date.now();
  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });

  onProgress('Starting MCAS scan...', 5);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🏪  MCAS Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${baseUrl}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Max products : ${MAX_PRODUCTS} | Max pages: ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1: Crawl collection/brand page for product URLs
  onProgress('Crawling MCAS collection pages...', 10);
  const productUrls = await crawlMCASCollection(baseUrl, brands, onProgress, jobId, MAX_PRODUCTS, MAX_PAGES);

  if (!productUrls.length) {
    throw new Error('No products found on MCAS. Check the URL and brand filters.');
  }
  console.log(`[MCAS] Found ${productUrls.length} product URLs`);

  // Step 2: Scrape each product page
  onProgress(`Scraping ${productUrls.length} products...`, 30);
  const products = await scrapeMCASProducts(productUrls, brands, onProgress, jobId, MAX_PRODUCTS);

  const finishedAt  = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
  const elapsedSec  = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalVariants = products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);

  onProgress(`Extracted ${products.length} products, ${totalVariants} variants`, 90);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅  MCAS Scraper finished`);
  console.log(`  Started   : ${startedAt}`);
  console.log(`  Finished  : ${finishedAt}`);
  console.log(`  Duration  : ${elapsedSec}s`);
  console.log(`  Products  : ${products.length} extracted`);
  console.log(`  Variants  : ${totalVariants} total`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  return products;
}

// ── Collection crawler ────────────────────────────────────────────────────────

async function crawlMCASCollection(baseUrl, brands, onProgress, jobId, maxProducts, maxPages) {
  const productUrls = new Set();
  console.log(`[MCAS] Crawling collection: ${baseUrl}`);

  // MCAS search/collection pages use Findify — loads ~24 products at a time
  // clicking "Load more" (class: findify-components--button__link) appends the next batch
  // Strip any offset from the URL so we always start from the beginning
  const startUrl = new URL(baseUrl);
  startUrl.searchParams.delete('offset');
  const cleanUrl = startUrl.toString();

  const session = await openPuppeteerPage(cleanUrl, 60000);
  if (!session) {
    console.log('[MCAS] Puppeteer unavailable — falling back to static fetch');
    const html = await fetchPage(cleanUrl);
    if (html) extractMCASProductUrls(html, brands, productUrls, maxProducts);
    return [...productUrls];
  }

  const { page, browser } = session;

  try {
    const ts0 = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    await sleep(3000);

    const baseForOffset = new URL(cleanUrl);
    baseForOffset.searchParams.delete('offset');
    const baseUrlNoOffset = baseForOffset.toString();

    // Extract from initial page
    let html = await page.content();
    extractMCASProductUrls(html, brands, productUrls, maxProducts);
    console.log(`[MCAS] [${ts0}] Initial: ${productUrls.size} products`);
    onProgress(`Found ${productUrls.size} MCAS products...`, 12);

    // Offset pagination — step by 50 (MCAS loads ~50 per batch)
    const PAGE_SIZE = 50;
    let offset = PAGE_SIZE;
    let emptyCount = 0;
    const maxOffset = Math.max(maxProducts * 2, 600);

    while (offset <= maxOffset && productUrls.size < maxProducts) {
      if (jobId && jobStore.isCancelled(jobId)) { console.log('[MCAS] Cancelled'); break; }

      const sep = baseUrlNoOffset.includes('?') ? '&' : '?';
      const offsetUrl = `${baseUrlNoOffset}${sep}offset=${offset}`;
      const ts = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`[MCAS] [${ts}] Loading offset=${offset}...`);

      try {
        await page.goto(offsetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(2500);
      } catch(e) { break; }

      const prevSize = productUrls.size;
      html = await page.content();
      extractMCASProductUrls(html, brands, productUrls, maxProducts);

      let added = productUrls.size - prevSize;

      // Retry once on zero
      if (added === 0) {
        await sleep(2000);
        html = await page.content();
        extractMCASProductUrls(html, brands, productUrls, maxProducts);
        added = productUrls.size - prevSize;
      }

      const ts2 = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`[MCAS] [${ts2}] Offset ${offset}: +${added} new (${productUrls.size} total)`);
      onProgress(`Found ${productUrls.size} MCAS products...`, Math.min(12 + productUrls.size / 5, 28));

      if (added === 0) { emptyCount++; if (emptyCount >= 2) break; }
      else emptyCount = 0;

      offset += PAGE_SIZE;
    }

    const ts1 = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`[MCAS] [${ts1}] Done — ${productUrls.size} product URLs collected`);

  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`[MCAS] Found ${productUrls.size} product URLs`);
  return [...productUrls];
}

// ── Extract MCAS product URLs from HTML ───────────────────────────────────────
function extractMCASProductUrls(html, brands, productUrls, maxProducts) {
  const $ = cheerio.load(html);
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!/-p$/.test(href)) return;
    const fullUrl = href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? href : '/' + href}`;

    // Skip non-product URLs (category/brand/search pages)
    if (fullUrl.includes('/search') || fullUrl.includes('/category/') ||
        fullUrl.includes('/brand/') || (fullUrl.includes('?') && !fullUrl.includes('-p'))) return;

    // Brand filter on URL slug — catches non-brand products in carousels/sidebars
    if (brands.length) {
      const urlLow = fullUrl.toLowerCase();
      const matches = brands.some(b => urlLow.includes(b.toLowerCase().trim()));
      if (!matches) return;
    }

    if (!productUrls.has(fullUrl)) productUrls.add(fullUrl);
  });
}

// ── Product scraper ───────────────────────────────────────────────────────────

async function scrapeMCASProducts(productUrls, brands, onProgress, jobId, maxProducts) {
  const products = [];
  let done = 0;

  const urlsToScrape = productUrls.slice(0, maxProducts);

  for (const url of urlsToScrape) {
    if (jobId && jobStore.isCancelled(jobId)) {
      console.log(`[MCAS] Cancelled — collected ${products.length} products`);
      break;
    }

    done++;
    const product = await scrapeMCASProductPage(url, brands, done, urlsToScrape.length);

    if (product) {
      products.push(product);
      onProgress(
        `[${done}/${urlsToScrape.length}] ${product.title} (${product.variants.length} sizes)`,
        30 + Math.floor((done / urlsToScrape.length) * 58)
      );
    }

    await sleep(400);
  }

  return products;
}

// ── Single product page scraper ───────────────────────────────────────────────
// Gets ALL data from the parent page — no sibling fetches.
// MCAS page structure (from HTML analysis):
//   Price:       <div itemprop="price" content="1499.91">
//   SKU:         <p class="product-sku"><strong>SKU:</strong> 1128467</p>
//   Size btns:   <a class="_itmspec_lnk size-block">S</a>
//   SKU list:    <p class="small">(1128472-p, 1128470, 1128469, ...)</p>
//   Image:       <img src="/assets/alt_2_thumb/1128472-p.jpg" class="product-image-small">

async function scrapeMCASProductPage(url, brands, currentNum, totalNum) {
  const ts = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`  [${currentNum}/${totalNum}] [${ts}] ${url.slice(0, 80)}...`);

  // Use Puppeteer to click each size and capture the updated SKU
  const session = await openPuppeteerPage(url, 45000);
  let html;
  let variantSkuMap = {}; // size label → sku from clicking

  if (session) {
    const { page, browser } = session;
    try {
      // Click each size button and capture SKU after each click
      // Click each size button and wait until the SKU element changes value
      const sizeButtonEls = await page.$$('a._itmspec_lnk');
      for (const btn of sizeButtonEls) {
        const label = await btn.evaluate(el => el.textContent.trim().toUpperCase());
        if (!label || label.length > 6) continue;
        if (!/^(2XS|XS|S|M|L|XL|2XL|3XL|4XL|OS|ONE SIZE)$/.test(label)) continue;

        // Read current SKU before clicking
        const skuBefore = await page.evaluate(() => {
          const el = document.querySelector('p.product-sku, [class*="product-sku"]');
          if (!el) return '';
          const m = el.textContent.match(/SKU[:\s]+([A-Z0-9]+)/i);
          return m ? m[1] : '';
        });

        // Click the button
        await btn.evaluate(el => { el.scrollIntoView(); el.click(); });

        // Poll until SKU changes from skuBefore — max 5 seconds
        let sku = skuBefore;
        for (let i = 0; i < 25; i++) {
          await sleep(200);
          sku = await page.evaluate(() => {
            const el = document.querySelector('p.product-sku, [class*="product-sku"]');
            if (!el) return '';
            const m = el.textContent.match(/SKU[:\s]+([A-Z0-9]+)/i);
            return m ? m[1] : '';
          });
          if (sku && sku !== skuBefore) break;
        }

        // If SKU didn't change, this size has no unique SKU — leave blank
        if (sku && sku !== skuBefore) {
          variantSkuMap[label] = sku;
          console.log(`    ${label} → SKU: ${sku}`);
        } else {
          variantSkuMap[label] = ''; // no unique SKU found — will show as empty
          console.log(`    ${label} → SKU: (empty — unchanged from ${skuBefore})`);
        }
      }
      html = await page.content();
      await browser.close();
    } catch(e) {
      console.log(`    Puppeteer error: ${e.message.slice(0,60)}`);
      await browser.close().catch(()=>{});
      html = await fetchPage(url);
    }
  } else {
    html = await fetchPage(url);
  }

  if (!html) return null;

  const $ = cheerio.load(html);

  // ── Title ─────────────────────────────────────────────────────────────────
  let title = $('h1').first().text().trim() || $('[itemprop="name"]').first().text().trim();
  if (!title) title = $('[itemprop="description"] h2').first().text().trim();
  if (!title) { console.log(`  [${currentNum}/${totalNum}] ⚠ No title — skipping`); return null; }
  // Strip trailing size: "Shoei NXR2 Helmet - Black - XS" → "Shoei NXR2 Helmet - Black"
  title = title.replace(/\s*-\s*(2XS|XS|S|M|L|XL|2XL|3XL|4XL|XXS|XXL|XXXL|One\s*Size)\s*$/i, '').trim();

  // ── Vendor ────────────────────────────────────────────────────────────────
  // MCAS has many meta[itemprop="brand"] tags — one per product on the page.
  // The correct one matches the product title's first word (brand name).
  // Strategy: find a meta[itemprop="brand"] whose content matches the title start.
  let vendor = '';
  const titleFirstWord = title.split(' ')[0].toLowerCase();
  $('meta[itemprop="brand"]').each((_, el) => {
    const bc = $(el).attr('content') || '';
    if (bc.toLowerCase() === titleFirstWord || bc.toLowerCase().includes(titleFirstWord)) {
      vendor = bc; return false; // stop at first match
    }
  });
  // Fallback: match against brand filter
  if (!vendor && brands.length) {
    vendor = brands.find(b => title.toLowerCase().startsWith(b.toLowerCase())) ||
             brands.find(b => title.toLowerCase().includes(b.toLowerCase())) || '';
  }
  // Last resort: first word of title
  if (!vendor) vendor = title.split(' ')[0];

  // ── Price — use RRP as the listing price (original price before any discount) ──
  // <div class="productrrp"><s>RRP $899.90</s></div>
  // Fall back to the current store price if no RRP shown
  let price = 0;
  const rrpText = $('.productrrp').text();
  if (rrpText) {
    price = parseFloat(rrpText.replace(/[^0-9.]/g, '')) || 0;
  }
  if (!price) {
    // Fall back to store price: <div itemprop="price" content="...">
    price = parseFloat($('div[itemprop="price"][content]').attr('content') || '0') || 0;
  }
  if (!price) {
    $('div[content]').each((_, el) => {
      const cls = $(el).attr('class') || '';
      if (cls.includes('mca-store-price')) {
        price = parseFloat($(el).attr('content') || '0') || 0;
        if (price) return false;
      }
    });
  }

  // ── SKU of current page ───────────────────────────────────────────────────
  const skuText = $('p.product-sku, [class*="product-sku"]').text();
  // SKUs can be numeric (1128472) or alphanumeric (HE1310EDKRXL)
  const currentSku = skuText.match(/SKU[:\s]+([A-Z0-9]{4,})/i)?.[1] || url.match(/([A-Z0-9]{4,})-p/i)?.[1] || '';

  // ── Description (clean) ───────────────────────────────────────────────────
  const $desc = $('[itemprop="description"]');
  // Remove SKU list paragraphs: <p class="small">(HE0310EDAD-p , HE0310EDADL...)</p>
  $desc.find('p.small, p').each((_, el) => {
    const txt = $(el).text().trim();
    // Match paragraphs that are just a list of SKUs in parentheses
    if (/^\([A-Z0-9\s,\-p\.]+\)$/i.test(txt)) $(el).remove();
    // Also remove "Please Note: images shown are for display use only" disclaimer
    if (/please note.*images shown/i.test(txt)) $(el).remove();
  });
  const desc = $desc.html() || '';

  // ── Images ────────────────────────────────────────────────────────────────
  // product-image-small = the main product thumbnail (correct)
  // product-image = used for hot products section (wrong, don't use)
  // From HTML: <img src="/assets/alt_2_thumb/1128472-p.jpg" class="img-fluid product-image-small">
  const images = [];
  // Collect ALL product-image-small images (main + alternates like alt_4_thumb)
  // MCAS uses: /assets/alt_2_thumb/, /assets/alt_4_thumb/, /assets/thumbL/ etc.
  const seenImgKeys = new Set();

  // Primary: main-image div (highest quality — uses /assets/full/ link)
  const $mainImg = $('.main-image');
  if ($mainImg.length) {
    const fullHref = $mainImg.find('a[href*="/assets/"]').attr('href') || '';
    const thumbSrc = $mainImg.find('img#main-image, img[itemprop="image"]').attr('src') || '';
    const imgSrc   = fullHref || thumbSrc;
    if (imgSrc) {
      const src = imgSrc.startsWith('http') ? imgSrc : `${BASE}${imgSrc.startsWith('/') ? imgSrc : '/' + imgSrc}`;
      const key = src.split('?')[0];
      if (!seenImgKeys.has(key)) { seenImgKeys.add(key); images.push(src); }
    }
  }

  // Additional: all product-image-small thumbnails (alt angles)
  $('img.product-image-small').each((_, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src') || '';
    if (!src) return;
    src = src.startsWith('http') ? src : `${BASE}${src.startsWith('/') ? src : '/' + src}`;
    const key = src.split('?')[0];
    if (seenImgKeys.has(key)) return;
    // Must be a product image (contains numeric or alphanumeric SKU pattern)
    if (!/\/[A-Z0-9]{4,}.*-[pP]\.(jpg|jpeg|png|webp)/i.test(key) &&
        !/\/\d{4,}.*\.(jpg|jpeg|png|webp)/i.test(key)) return;
    if (/logo|banner|icon|placeholder/i.test(key)) return;
    seenImgKeys.add(key);
    images.push(src);
  });
  // Fallback: construct full image URL from SKU
  if (!images.length && currentSku) {
    images.push(`${BASE}/assets/full/${currentSku}.jpg`);
  }

  // ── Size buttons on parent page ───────────────────────────────────────────
  // <a class="_itmspec_lnk size-block border rounded py-1 px-2 mb-1 mr-1">S</a>
  // _itmspec_selected = currently selected size (not unavailable)
  // Unavailable sizes on MCAS are rendered with line-through via JS — not in static HTML
  // So all sizes visible in static HTML are treated as available
  const sizeButtons = [];
  $('a._itmspec_lnk').each((_, el) => {
    const label = $(el).text().trim().toUpperCase();
    if (!label || label.length > 5) return;
    // Only valid size labels
    if (!/^(2XS|XS|S|M|L|XL|2XL|3XL|4XL|XXXL|OS|ONE SIZE)$/.test(label)) return;
    const cls = $(el).attr('class') || '';
    const isUnavailable = cls.includes('disabled') || cls.includes('text-decoration-line-through');
    sizeButtons.push({ label, available: !isUnavailable });
  });

  // ── Sibling SKU list from description ─────────────────────────────────────
  // Format: (1128472-p , 1128470, 1128469, 1128468, 1128471, 1128467)
  const PHANTOM = new Set(['7085300', '31361008', '31371008']);
  const sibSkus = [];
  const rawHtml = $.html();
  // SKU list in description: (1128472-p, 1128470, HE1310EDKRXL, ...)
  const skuListMatches = rawHtml.match(/\([A-Z0-9\s,\-p]+\)/gi) || [];
  skuListMatches.forEach(m => {
    m.replace(/[()]/g, '').split(',').forEach(s => {
      const sku = s.trim().replace(/-p$/i, '').trim();
      // Accept numeric SKUs (5-8 digits) OR alphanumeric SKUs (4+ chars with letters)
      const isNumeric = /^\d{5,8}$/.test(sku);
      const isAlphaNum = /^[A-Z0-9]{4,20}$/i.test(sku) && /[A-Z]/i.test(sku) && /\d/.test(sku);
      if ((isNumeric || isAlphaNum) && !PHANTOM.has(sku) && !sibSkus.includes(sku)) sibSkus.push(sku);
    });
  });
  if (currentSku && !sibSkus.includes(currentSku)) sibSkus.unshift(currentSku);

  // ── Build variants — use Puppeteer-captured SKUs first, fall back to sibling list ──
  const SIZE_ORDER = ['2XS','XS','S','M','L','XL','2XL','3XL','4XL'];
  let variants = [];

  if (sizeButtons.length > 0) {
    for (let i = 0; i < sizeButtons.length; i++) {
      const btn   = sizeButtons[i];
      const label = btn.label;
      // variantSkuMap has the correct per-size SKU from clicking each button
      // fall back to sibling list position, then the page's currentSku
      const sku   = variantSkuMap[label] || sibSkus[i] || currentSku || '';
      variants.push({
        size:        label,
        sku,
        price,
        available:   btn.available,
        inventoryQty: btn.available ? 1 : 0,
      });
    }
  } else if (sibSkus.length > 0) {
    sibSkus.forEach((sku, i) => variants.push({
      size: SIZE_ORDER[i] || sku, sku, price, available: true, inventoryQty: 1,
    }));
  } else {
    variants.push({ size: 'One Size', sku: currentSku || '', price, available: true, inventoryQty: 1 });
  }

  // Sort by size order
  variants.sort((a, b) => {
    const ai = SIZE_ORDER.indexOf(a.size); const bi = SIZE_ORDER.indexOf(b.size);
    if (ai === -1 && bi === -1) return a.size.localeCompare(b.size);
    if (ai === -1) return 1; if (bi === -1) return -1;
    return ai - bi;
  });

  const tsF = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`  [${currentNum}/${totalNum}] [${tsF}] ✓ ${title} (${variants.length} variants, ${sizeButtons.length} size btns)`);

  return {
    sourceId:     currentSku || url,
    handle:       url.split('/').pop()?.replace(/-p$/, '') || 'unknown',
    title,
    description:  desc,
    vendor,
    productType:  'Road Helmet',
    images:       images.slice(0, 8),
    variants,
    priceMin:     price,
    priceMax:     price,
    sourceUrl:    url,
    sourcePlatform: 'mcas',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }