/**
 * AMX Superstores Dedicated Scraper
 *
 * AMX is a heavily-blocked Shopify store. This module:
 * - Uses Puppeteer (local Chrome) for both collection crawling and product pages
 * - Clicks each size variant to capture per-size Part Numbers (SKUs)
 * - Supports mid-scrape cancellation — returns partial results for gap analysis
 * - Timestamps every step in the terminal for easy monitoring
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer-core';
import pLimit from 'p-limit';
import { jobStore } from './jobStore.js';

// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION — defaults, overridden per-scan via options passed from UI
// ══════════════════════════════════════════════════════════════════════════════

const MAX_PAGES_PER_COLLECTION = 5;
const MAX_PRODUCTS_TO_SCRAPE   = 20;
const CONCURRENCY              = 1;   // Puppeteer pages: keep low to avoid memory issues

// ══════════════════════════════════════════════════════════════════════════════

const lim = pLimit(CONCURRENCY);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
};

// ── Direct HTTP fetch (lightweight, no proxy) ───────────────────────────────
async function fetchDirect(url, timeout = 30000) {
  try {
    const r = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, 'Accept': 'application/json' },
      timeout,
      validateStatus: s => true,
    });
    if (r.status === 200) return r.data;
    console.log(`  ✗ Failed (${r.status}): ${url.slice(0, 80)}...`);
    return null;
  } catch (e) {
    console.log(`  ✗ Error: ${e.message.slice(0, 60)}`);
    return null;
  }
}

// ── ScraperAPI static fetch (fallback for rendered pages) ────────────────────
function scraperApiUrl(targetUrl) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return null;
  const params = new URLSearchParams({
    api_key: key,
    url: targetUrl,
    country_code: 'au',
    render: 'true',
    device_type: 'desktop',
  });
  return `https://api.scraperapi.com?${params}`;
}

async function fetchViaProxy(url, timeout = 60000) {
  const proxyUrl = scraperApiUrl(url);
  if (!proxyUrl) throw new Error('SCRAPERAPI_KEY not set');
  try {
    const r = await axios.get(proxyUrl, { headers: BROWSER_HEADERS, timeout, validateStatus: s => true });
    if (r.status === 200) return r.data;
    console.log(`  ✗ Failed (${r.status}): ${url.slice(0, 80)}...`);
    return null;
  } catch (e) {
    console.log(`  ✗ Error: ${e.message.slice(0, 60)}`);
    return null;
  }
}

/**
 * Launch a local Puppeteer browser.
 * Uses the Chrome/Chromium installed on the machine.
 * Common paths for Windows, Mac, and Linux are tried automatically.
 */
async function openPuppeteerPage(url, timeout = 90000) {
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
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
    console.log('  [Puppeteer] No Chrome found — falling back to static fetch');
    console.log('  [Puppeteer] Set CHROME_PATH env var to your Chrome executable');
    return null;
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1280,900',
      ],
      defaultViewport: { width: 1280, height: 900 },
    });

    const page = await browser.newPage();

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8' });

    await page.goto(url, { waitUntil: 'networkidle2', timeout });

    console.log(`  [Puppeteer] Loaded: ${url.slice(0, 70)}...`);
    return { page, browser };

  } catch (e) {
    console.log(`  [Puppeteer] Failed: ${e.message.slice(0, 80)}`);
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * @param {string}   baseUrl
 * @param {string[]} brands
 * @param {Function} onProgress
 * @param {string|null} jobId     — for cancellation checks
 * @param {object}   options      — { maxProducts, maxPages } from UI scan settings
 */
export async function scrapeAMX(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  // Use values from UI if provided, otherwise fall back to module constants
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_TO_SCRAPE;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_PER_COLLECTION;

  const startTime = Date.now();
  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });

  onProgress('Starting AMX scan...', 5);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🏍️  AMX Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${baseUrl}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Mode         : Puppeteer (local Chrome)`);
  console.log(`  Max products : ${MAX_PRODUCTS}`);
  console.log(`  Max pages    : ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const collectionUrls = [baseUrl];
  console.log(`[AMX] Will crawl ${collectionUrls.length} collection URL(s)`);

  onProgress('Scanning collection pages...', 10);
  const productUrls = await crawlCollections(collectionUrls, brands, onProgress, jobId, MAX_PRODUCTS, MAX_PAGES);

  if (!productUrls.length) {
    throw new Error('No products found in AMX collections. Check brand filters.');
  }

  console.log(`[AMX] Found ${productUrls.length} product URLs`);

  onProgress(`Scraping ${productUrls.length} products with Puppeteer...`, 30);
  const products = await scrapeProducts(productUrls, brands, onProgress, jobId, MAX_PRODUCTS);

  const finishedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const elapsedMin = (elapsedSec / 60).toFixed(1);
  const totalVariants = products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);

  onProgress(`Extracted ${products.length} products, ${totalVariants} variants`, 90);

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅  AMX Scraper finished`);
  console.log(`  Started   : ${startedAt}`);
  console.log(`  Finished  : ${finishedAt}`);
  console.log(`  Duration  : ${elapsedSec}s (${elapsedMin} min)`);
  console.log(`  Products  : ${products.length} extracted`);
  console.log(`  Variants  : ${totalVariants} total`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  return products;
}

// ── Collection URL builder ───────────────────────────────────────────────────

function getAmxDomain(baseUrl) {
  try { return new URL(baseUrl).origin; } catch(_) { return 'https://www.amxsuperstores.com.au'; }
}

async function crawlCollections(collectionUrls, brands, onProgress, jobId, maxProducts = MAX_PRODUCTS_TO_SCRAPE, maxPages = MAX_PAGES_PER_COLLECTION) {
  const productUrls = new Set();

  for (const collUrl of collectionUrls) {
    if (productUrls.size >= maxProducts) break;
    if (jobId && jobStore.isCancelled(jobId)) { console.log('[AMX] Cancelled'); break; }

    console.log('[AMX] Crawling with Puppeteer:', collUrl);

    // Clean the URL — keep only vendor= param, strip page/sort/etc
    const cleanUrl = new URL(collUrl);
    const vendor = cleanUrl.searchParams.get('vendor');
    cleanUrl.search = '';
    if (vendor) cleanUrl.searchParams.set('vendor', vendor);

    for (let page = 1; page <= maxPages; page++) {
      if (productUrls.size >= maxProducts) break;
      if (jobId && jobStore.isCancelled(jobId)) break;

      const pageUrl = new URL(cleanUrl.toString());
      pageUrl.searchParams.set('page', String(page));
      const url = pageUrl.toString();

      const ts = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`[AMX] [${ts}] Collection page ${page}: ${url}`);

      const session = await openPuppeteerPage(url, 60000);
      if (!session) {
        console.log(`[AMX] Puppeteer unavailable for collection crawl — stopping`);
        break;
      }

      const { page: browserPage, browser } = session;

      try {
        const found_urls = await browserPage.evaluate((domain) => {
          const links = document.querySelectorAll('a[href*="/products/"]');
          const urls = new Set();
          links.forEach(a => {
            const href = a.href;
            if (href && href.includes('/products/') && !href.includes('/products/compare')) {
              try {
                const u = new URL(href);
                urls.add(`${u.origin}/products/${u.pathname.split('/products/')[1].split('?')[0]}`);
              } catch(_) {}
            }
          });
          return [...urls];
        }, getAmxDomain(collUrl));

        await browser.close();

        let found = 0;
        for (const u of found_urls) {
          if (brands.length) {
            const matchesBrand = brands.some(b => u.toLowerCase().includes(b.toLowerCase()));
            if (!matchesBrand) continue;
          }
          if (!productUrls.has(u)) { productUrls.add(u); found++; }
        }

        console.log(`  Page ${page}: +${found} products (${productUrls.size} total)`);
        onProgress(`Found ${productUrls.size} products...`, Math.min(10 + productUrls.size / 5, 28));

        if (found === 0) {
          console.log(`  No new products on page ${page} — stopping pagination`);
          break;
        }

      } catch (e) {
        console.log(`[AMX] Collection crawl error page ${page}:`, e.message.slice(0, 80));
        await browser.close().catch(() => {});
        break;
      }

      await sleep(1000);
    }
  }

  return [...productUrls];
}

// ── Product scraping (Puppeteer — clicks variants for per-size SKUs) ──────────

async function scrapeProducts(productUrls, brands, onProgress, jobId, maxProducts = MAX_PRODUCTS_TO_SCRAPE) {
  const products = [];
  let done = 0;

  const urlsToScrape = productUrls.slice(0, maxProducts);
  if (productUrls.length > maxProducts) {
    console.log(`[AMX] Limiting to first ${maxProducts} of ${productUrls.length} products`);
  }

  for (const url of urlsToScrape) {
    if (jobId && jobStore.isCancelled(jobId)) {
      console.log(`[AMX] Cancelled — collected ${products.length} products so far`);
      break;
    }

    done++;
    const product = await scrapeProductPageWithPuppeteer(url, brands, done, urlsToScrape.length);

    if (product) {
      products.push(product);
      onProgress(
        `[${done}/${urlsToScrape.length}] ${product.title} (${product.variants.length} sizes)`,
        30 + Math.floor((done / urlsToScrape.length) * 58)
      );
    }

    await sleep(500);
  }

  return products;
}

// ── Puppeteer product page scraper ───────────────────────────────────────────

async function scrapeProductPageWithPuppeteer(url, brands, currentNum, totalNum) {
  const ts = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`  [${currentNum}/${totalNum}] [${ts}] Puppeteer: ${url.slice(0, 80)}...`);

  const session = await openPuppeteerPage(url);

  if (!session) {
    console.log(`  [${currentNum}/${totalNum}] Fallback: static fetch`);
    return scrapeProductPageStatic(url, brands, currentNum, totalNum);
  }

  const { page, browser } = session;

  try {
    const productData = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';

        const m1 = text.match(/ShopifyAnalytics\.meta\s*=\s*({[\s\S]*?});/);
        if (m1) {
          try { const d = JSON.parse(m1[1]); if (d.product) return d.product; } catch(_) {}
        }

        const m2 = text.match(/var\s+meta\s*=\s*({[\s\S]*?"product"[\s\S]*?})\s*;/);
        if (m2) {
          try { const d = JSON.parse(m2[1]); if (d.product) return d.product; } catch(_) {}
        }

        if (text.includes('"variants"') && text.includes('"title"')) {
          const m3 = text.match(/"product"\s*:\s*({[\s\S]*?"variants"[\s\S]*?})\s*[,}]/);
          if (m3) {
            try { const d = JSON.parse(m3[1]); if (d.variants && d.title) return d; } catch(_) {}
          }
        }
      }
      return null;
    });

    const pageInfo = await page.evaluate(() => {
      const title = document.querySelector('h1')?.textContent?.trim() || '';
      const descEl = document.querySelector('.uc-rich-text-display, .product-details__rich-text, .product-description');
      const description = descEl?.innerHTML?.trim() || '';

      const imgSet = new Set();
      document.querySelectorAll('img[src*="cdn.shopify"]').forEach(img => {
        const src = img.src || img.dataset.src;
        if (src && !src.includes('placeholder')) {
          imgSet.add(src.replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original|master|1024x1024|800x800|600x600|400x400|100x100)\./g, '.'));
        }
      });

      const vendorEl = document.querySelector('[class*="vendor"], .product__vendor, .product-vendor');
      const vendor = vendorEl?.textContent?.trim() || '';

      return { title, description, images: [...imgSet].slice(0, 8), vendor };
    });

    const variantData = await extractVariantsWithPuppeteer(page);

    await browser.close();

    if (productData) {
      const variantSkuMap = {};
      variantData.forEach(v => { variantSkuMap[v.size.toLowerCase()] = v; });

      const variants = (productData.variants || []).map(v => {
        const size   = v.option1 || v.title || 'Default';
        const puppet = variantSkuMap[size.toLowerCase()];
        let sku = v.sku || v.barcode || puppet?.partNumber || '';
        sku = sku.replace(/^variant-/i, '').trim();

        return {
          id: String(v.id),
          size,
          sku,
          price: parseFloat(v.price) || 0,
          compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
          inventoryQty: v.inventory_quantity || 0,
          available: puppet?.available ?? (v.available !== false),
        };
      });

      const vendor = pageInfo.vendor || productData.vendor ||
        brands.find(b => (productData.title || '').toLowerCase().includes(b.toLowerCase())) || '';

      const prices = variants.map(v => v.price).filter(p => p > 0);
      const tsFound = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`  [${currentNum}/${totalNum}] [${tsFound}] ✓ ${productData.title} (${variants.length} variants)`);

      return {
        sourceId: String(productData.id),
        handle: productData.handle || url.split('/products/')[1]?.split('?')[0] || 'unknown',
        title: productData.title || pageInfo.title,
        description: pageInfo.description || productData.description || '',
        vendor,
        productType: productData.type || '',
        images: dedupeImages(pageInfo.images),
        variants,
        priceMin: prices.length ? Math.min(...prices) : 0,
        priceMax: prices.length ? Math.max(...prices) : 0,
        sourceUrl: url,
        sourcePlatform: 'amx-puppeteer',
      };
    }

    const tsHtml = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  [${currentNum}/${totalNum}] [${tsHtml}] ⚠ No JSON — using Puppeteer HTML extraction`);

    const price = variantData.find(v => v.price)?.price || 0;
    const vendor = extractVendorFromText(pageInfo.vendor || pageInfo.title, brands);

    return {
      sourceId: url,
      handle: url.split('/products/')[1]?.split('?')[0] || 'unknown',
      title: pageInfo.title,
      description: pageInfo.description,
      vendor,
      productType: '',
      images: dedupeImages(pageInfo.images),
      variants: variantData.map(v => ({
        size: v.size,
        sku: v.partNumber || '',
        price: v.price || price,
        inventoryQty: v.available ? 1 : 0,
        available: v.available,
      })),
      priceMin: price,
      priceMax: price,
      sourceUrl: url,
      sourcePlatform: 'amx-puppeteer',
    };

  } catch (e) {
    console.log(`  [${currentNum}/${totalNum}] Puppeteer error: ${e.message.slice(0, 80)}`);
    await browser.close().catch(() => {});
    return scrapeProductPageStatic(url, brands, currentNum, totalNum);
  }
}

// ── Click each size variant and capture its Part Number ──────────────────────

async function extractVariantsWithPuppeteer(page) {
  try {
    const variantEls = await page.$$('.product-variants__options--div');

    if (!variantEls.length) {
      const partNumber = await page.$eval(
        'p.product-details__product-part-number, [class*="product-part-number"]',
        el => el.textContent.match(/Part\s*Number\s*[:\-]?\s*([A-Z0-9\-]+)/i)?.[1]?.trim() || ''
      ).catch(() => '');

      const priceText = await page.$eval('[class*="price"]', el => el.textContent).catch(() => '0');
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;

      return [{ size: 'One Size', partNumber, price, available: true }];
    }

    const variants = [];

    for (const el of variantEls) {
      const sizeLabel = await el.$eval('label', l => l.textContent.trim()).catch(() => '');
      if (!sizeLabel) continue;

      const isUnavailable = await el.evaluate(node => node.classList.contains('unavailable'));

      const radio = await el.$('input[type="radio"]');
      if (radio) {
        await radio.click();
        await sleep(600);
      }

      const partNumber = await page.$eval(
        'p.product-details__product-part-number, [class*="product-part-number"]',
        el => {
          const text = el.textContent || '';
          const match = text.match(/Part\s*Number\s*[:\-]?\s*([A-Z0-9\-]+)/i);
          return match ? match[1].trim() : '';
        }
      ).catch(() => '');

      const priceText = await page.$eval(
        '.product-price, [class*="product-price"], [class*="price"]',
        el => el.textContent
      ).catch(() => '0');
      const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;

      console.log(`    Size: ${sizeLabel} → SKU: ${partNumber || '—'} ${isUnavailable ? '(unavailable)' : ''}`);

      variants.push({ size: sizeLabel, partNumber, price, available: !isUnavailable });
    }

    return variants;

  } catch (e) {
    console.log(`  [Puppeteer] Variant extraction error: ${e.message.slice(0, 60)}`);
    return [];
  }
}

// ── Static fallback (used when Puppeteer unavailable or fails) ────────────────

async function scrapeProductPageStatic(url, brands, currentNum, totalNum) {
  const ts = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`  [${currentNum}/${totalNum}] [${ts}] Static fetch: ${url.slice(0, 80)}...`);
  const html = await fetchViaProxy(url);
  if (!html) return null;

  const $ = cheerio.load(html);
  let productData = null;

  $('script').each((_, el) => {
    if (productData) return;
    const text = $(el).html() || '';
    const patterns = [
      /(?:window\.|var\s+)(?:product|productData|currentProduct)\s*=\s*(\{[\s\S]*?\});?(?:\s|$)/,
      /"product"\s*:\s*(\{[\s\S]*?"variants"[\s\S]*?\})\s*(?:,|\})/,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        try { const d = JSON.parse(m[1]); if (d.variants && d.title) { productData = d; return; } } catch(_) {}
      }
    }
  });

  const title  = $('h1').first().text().trim();
  const vendor = extractVendorFromHtml($, title, brands, productData?.vendor);
  const desc   = $('.uc-rich-text-display, .product-details__rich-text, .product-description').first().html() || '';
  const partNo = extractPartNumber($);
  const images = extractImages($, productData);

  if (productData) {
    const variants = (productData.variants || []).map(v => ({
      id: String(v.id),
      size: v.option1 || v.title || 'Default',
      sku: v.sku || v.barcode || partNo || '',
      price: parseFloat(v.price) || 0,
      compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
      inventoryQty: v.inventory_quantity || 0,
      available: v.available !== false,
    }));
    const prices = variants.map(v => v.price).filter(p => p > 0);
    const tsFound = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  [${currentNum}/${totalNum}] [${tsFound}] ✓ ${productData.title} (${variants.length} variants)`);
    return {
      sourceId: String(productData.id),
      handle: productData.handle || url.split('/products/')[1]?.split('?')[0] || 'unknown',
      title: productData.title || title,
      description: desc || productData.description || '',
      vendor,
      productType: productData.type || '',
      images,
      variants,
      priceMin: prices.length ? Math.min(...prices) : 0,
      priceMax: prices.length ? Math.max(...prices) : 0,
      sourceUrl: url,
      sourcePlatform: 'amx-shopify',
    };
  }

  if (!title) return null;

  const priceText = $('.price, .product-price, [data-product-price]').first().text();
  const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;
  const variants = extractVariantsFromHTML($, price, partNo);

  return {
    sourceId: url,
    handle: url.split('/products/')[1]?.split('?')[0] || 'unknown',
    title, description: desc, vendor, productType: '',
    images, variants,
    priceMin: price, priceMax: price,
    sourceUrl: url, sourcePlatform: 'amx-shopify',
  };
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function extractPartNumber($) {
  let pn = '';
  $('p.product-details__product-part-number, [class*="product-part-number"]').each((_, el) => {
    const m = $(el).text().match(/Part\s*Number\s*[:\-]?\s*([A-Z0-9\-]+)/i);
    if (m) { pn = m[1].trim(); return false; }
  });
  if (!pn) {
    $('p, span, div').each((_, el) => {
      const text = $(el).text().trim();
      if (text.startsWith('Part Number') && text.length < 50) {
        const m = text.match(/Part\s*Number\s*[:\-]?\s*([A-Z0-9\-]+)/i);
        if (m) { pn = m[1].trim(); return false; }
      }
    });
  }
  return pn;
}

function extractImages($, productData) {
  const seen = new Set();
  const imgs = [];
  const add = src => {
    if (!src) return;
    const norm = src.split('?')[0].replace(/^\/\//, 'https://');
    if (seen.has(norm) || src.includes('placeholder')) return;
    seen.add(norm);
    imgs.push(src.startsWith('//') ? 'https:' + src : src);
  };
  if (productData?.images) productData.images.forEach(i => add(typeof i === 'string' ? i : i?.src));
  else if (productData?.featured_image) add(productData.featured_image);
  if (!imgs.length) $('img[src*="cdn.shopify"]').each((_, el) => add($(el).attr('src') || $(el).attr('data-src')));
  return imgs;
}

function dedupeImages(imgs) {
  const seen = new Set();
  return (imgs || []).filter(src => {
    const k = src.split('?')[0];
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function extractVariantsFromHTML($, price, defaultSku) {
  const variants = [];
  $('.product-variants__options--div').each((_, el) => {
    const label = $(el).find('label').text().trim();
    if (!label) return;
    const available = !$(el).hasClass('unavailable');
    variants.push({ size: label, sku: defaultSku || '', price, inventoryQty: available ? 1 : 0, available });
  });
  if (!variants.length) variants.push({ size: 'One Size', sku: defaultSku || '', price, inventoryQty: 0, available: false });
  return variants;
}

function extractVendorFromHtml($, title, brands, jsonVendor) {
  const html = $('[class*="vendor"], .product__vendor, .product-vendor').first().text().trim();
  if (html && html.length < 40) return html;
  if (jsonVendor?.trim()) return jsonVendor.trim();
  if (brands?.length) {
    const m = brands.find(b => (title || '').toLowerCase().includes(b.toLowerCase()));
    if (m) return m;
  }
  const first = (title || '').split(/\s+/)[0];
  return (first && /^[A-Z]/.test(first)) ? first : '';
}

function extractVendorFromText(text, brands) {
  if (brands?.length) {
    const m = brands.find(b => (text || '').toLowerCase().includes(b.toLowerCase()));
    if (m) return m;
  }
  const first = (text || '').split(/\s+/)[0];
  return (first && /^[A-Z]/.test(first)) ? first : '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }