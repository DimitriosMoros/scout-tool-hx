/**
 * Bikebiz Scraper
 *
 * Bikebiz is a Next.js App Router + Saleor headless store. Product data is
 * delivered via RSC streaming (self.__next_f.push chunks), not __NEXT_DATA__.
 * Strategy:
 *  1. Load the collection/brand/search page with Puppeteer
 *  2. Extract product cards from the rendered DOM (name + URL + rough price)
 *  3. Paginate via infinite scroll
 *  4. For each product URL, load the page and extract from RSC payload or JSON-LD
 */

import puppeteer from 'puppeteer-core';
import { jobStore } from './jobStore.js';

const BASE = 'https://www.bikebiz.com.au';

const MAX_PAGES_PER_COLLECTION = 8;
const MAX_PRODUCTS_TO_SCRAPE   = 20;

// ── Browser launcher ──────────────────────────────────────────────────────────
async function openBrowser() {
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ].filter(Boolean);
  if (process.env.CHROME_PATH) chromePaths.unshift(process.env.CHROME_PATH);
  const { existsSync } = await import('fs');
  const executablePath = chromePaths.find(p => existsSync(p));
  if (!executablePath) throw new Error('Chrome not found. Set CHROME_PATH in .env');
  const proxyUrl = process.env.SCRAPER_PROXY || null;
  const args = ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--window-size=1280,900'];
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);
  return puppeteer.launch({ executablePath, headless: true, args, defaultViewport: { width: 1280, height: 900 } });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',  { get: () => [1,2,3] });
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en-US;q=0.9' });
  const proxyUrl = process.env.SCRAPER_PROXY || null;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      if (u.username) await page.authenticate({ username: u.username, password: decodeURIComponent(u.password) });
    } catch(_) {}
  }
  return page;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function scrapeBikebiz(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_TO_SCRAPE;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_PER_COLLECTION;

  const startTime  = Date.now();
  const startedAt  = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });

  onProgress('Starting Bikebiz scan...', 5);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🏍️  Bikebiz Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${baseUrl}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Max products : ${MAX_PRODUCTS} | Max pages: ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let browser;
  try {
    browser = await openBrowser();
    const page = await newPage(browser);

    onProgress('Loading Bikebiz listing page...', 8);
    const listings = await collectListings(page, baseUrl, brands, MAX_PRODUCTS, MAX_PAGES, onProgress);

    if (!listings.length) throw new Error('No products found on listing page. Check brand filters or URL.');
    console.log(`[Bikebiz] Collected ${listings.length} product listings`);

    onProgress(`Fetching details for ${listings.length} products...`, 35);
    const products = await fetchProductDetails(page, listings, brands, onProgress, jobId, MAX_PRODUCTS);

    await browser.close();

    const finishedAt    = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
    const elapsedSec    = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalVariants = products.reduce((s, p) => s + (p.variants?.length || 0), 0);

    onProgress(`Extracted ${products.length} products, ${totalVariants} variants`, 90);
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅  Bikebiz Scraper finished`);
    console.log(`  Started  : ${startedAt}`);
    console.log(`  Finished : ${finishedAt}`);
    console.log(`  Duration : ${elapsedSec}s`);
    console.log(`  Products : ${products.length}`);
    console.log(`  Variants : ${totalVariants}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    return products;

  } catch(e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

// ── Step 1: Scrape product cards from the listing/brand/search page ───────────
// Products are SSR'd into the HTML — we just read the DOM.
async function collectListings(page, collectionUrl, brands, maxProducts, maxPages, onProgress) {
  try {
    await page.goto(collectionUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch(_) {
    try { await page.goto(collectionUrl, { waitUntil: 'domcontentloaded', timeout: 40000 }); } catch(_) {}
  }
  await sleep(2000);

  const seen    = new Map(); // href → listing item
  const bl      = brands.map(b => b.toLowerCase());

  function mergeItems(items) {
    for (const it of items) {
      if (!it.href || seen.has(it.href)) continue;
      if (bl.length && !bl.some(b => it.name.toLowerCase().includes(b))) continue;
      seen.set(it.href, it);
    }
  }

  mergeItems(await extractListingCards(page));
  console.log(`[Bikebiz] After initial load: ${seen.size} products`);
  onProgress(`Found ${seen.size} products — scrolling for more...`, 15);

  for (let p = 1; p < maxPages && seen.size < maxProducts; p++) {
    const beforeCount = seen.size;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(3000);
    mergeItems(await extractListingCards(page));

    console.log(`[Bikebiz] After scroll ${p}: ${seen.size} products (${seen.size - beforeCount} new)`);
    onProgress(`Scroll ${p + 1} — ${seen.size} products...`, 15 + p * 3);

    if (seen.size === beforeCount) break; // no new products loaded
  }

  return [...seen.values()].slice(0, maxProducts);
}

// Extract product cards from the current DOM state.
// Bikebiz product tiles contain an image from image-cdn.bikebiz.com.au (via /_next/image).
// The alt text is the product name; the nearest <a> ancestor carries the product URL.
function extractListingCards(page) {
  return page.evaluate(() => {
    const results = [];
    const seen    = new Set();

    // All product images come through /_next/image pointing at image-cdn.bikebiz.com.au
    const imgs = Array.from(document.querySelectorAll(
      'img[src*="image-cdn.bikebiz.com.au"], img[src*="/_next/image"][alt]'
    ));

    for (const img of imgs) {
      const name = (img.alt || '').trim();
      if (!name) continue;

      // Walk up to find the product card link
      let el = img.parentElement;
      let link = null;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        if (el.tagName === 'A' && el.href) { link = el; break; }
        el = el.parentElement;
      }
      if (!link) continue;

      const href = link.href;
      // Only include actual product URLs (not CDN/image links, not root, not brand pages)
      if (!href || href.includes('/_next') || href.includes('image-cdn') || seen.has(href)) continue;
      const path = new URL(href).pathname.replace(/\/$/, '');
      if (!path || path === '' || path.split('/').length < 2) continue;
      seen.add(href);

      // Find price: scan siblings/cousins within the card container
      let priceText = '';
      let container = link.parentElement || link;
      for (let i = 0; i < 4; i++) {
        const text = container ? container.textContent : '';
        const m    = text.match(/\$[\d,]+\.?\d*/);
        if (m) { priceText = m[0]; break; }
        if (container?.parentElement) container = container.parentElement;
        else break;
      }

      // Thumbnail — prefer the full src URL before /_next/image transforms it
      const rawSrc  = img.getAttribute('src') || '';
      let thumbUrl = rawSrc.includes('image-cdn.bikebiz.com.au')
        ? rawSrc
        : (rawSrc.includes('url=') ? decodeURIComponent(rawSrc.split('url=')[1]?.split('&')[0] || '') : rawSrc);
      // Drop Bikebiz's "IMAGE NOT AVAILABLE" placeholder (id contains "download")
      const thumbId = (thumbUrl.split('/').slice(-3)[0] || '').toLowerCase();
      if (thumbId.includes('download')) thumbUrl = '';

      results.push({ name, href, priceText, thumbUrl });
    }
    return results;
  });
}

// ── Step 2: Load each product page and extract full details ───────────────────
async function fetchProductDetails(page, listings, brands, onProgress, jobId, maxProducts) {
  const products = [];
  const toFetch  = listings.slice(0, maxProducts);

  for (let i = 0; i < toFetch.length; i++) {
    if (jobId && jobStore.isCancelled(jobId)) { console.log(`[Bikebiz] Cancelled`); break; }

    const listing = toFetch[i];
    const ts      = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  [${i+1}/${toFetch.length}] [${ts}] ${listing.name}`);

    try {
      const detail = await scrapeProductPage(page, listing, brands);
      // Colour-bundled pages return one product per colourway
      const items = Array.isArray(detail) ? detail : (detail ? [detail] : []);
      for (const d of items) {
        products.push(d);
        console.log(`  [${i+1}/${toFetch.length}] ✓ ${d.title} (${d.variants.length} variants)`);
      }
      if (items.length) {
        onProgress(`[${i+1}/${toFetch.length}] ${items[0].title}`, 35 + Math.floor(((i+1)/toFetch.length)*55));
      }
    } catch(e) {
      console.log(`    ✗ Error: ${e.message.slice(0, 80)}`);
    }
    await sleep(300);
  }
  return products;
}

// Scrape a single product page. Tries RSC payload (Next.js App Router, most complete),
// then JSON-LD, then raw DOM extraction as a last resort.
export async function scrapeProductPage(page, listing, brands) {
  try {
    await page.goto(listing.href, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch(_) {
    try { await page.goto(listing.href, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch(_) {}
  }
  // Wait for RSC streaming to inject ProductDetailSchema into the DOM.
  // Falls back to a fixed sleep if the selector never appears (e.g., blocked/404).
  try {
    await page.waitForSelector('script#ProductDetailSchema', { timeout: 12000 });
  } catch(_) {
    await sleep(1500);
  }

  const pageData = await page.evaluate(() => {
    // Extract the product description HTML.
    // Primary: the description div is the nextElementSibling of the banner card.
    // The banner card is the parent of img[alt="Bikebiz Best Buys"], so this is
    // exact and never matches other "styles_content" elements on the page.
    // Fallback: scope to the "Product Details" section heading, then grab
    // the first styles_content div inside it (strips any nested banners).
    const descHtml = (() => {
      // Primary — most precise
      const bannerImg = document.querySelector('img[alt="Bikebiz Best Buys"]');
      if (bannerImg) {
        const descEl = bannerImg.parentElement?.nextElementSibling;
        if (descEl?.textContent?.trim()) return descEl.innerHTML.trim();
      }
      // Fallback — scoped to the Product Details section
      const detailH4 = Array.from(document.querySelectorAll('h4'))
        .find(h => /product detail/i.test(h.textContent));
      if (detailH4) {
        const section = detailH4.closest('div[class*="flex-wrap"]')
          || detailH4.closest('div[class*="flex"]')
          || detailH4.parentElement?.parentElement;
        const el = section?.querySelector('[class*="styles_content"]');
        if (el?.textContent?.trim()) {
          const clone = el.cloneNode(true);
          clone.querySelectorAll('[class*="bannerBg"], img[alt*="Best Buys"]').forEach(b => {
            let up = b;
            while (up.parentElement && up.parentElement !== clone) up = up.parentElement;
            if (up.parentElement === clone) up.remove();
          });
          return clone.innerHTML.trim();
        }
      }
      return '';
    })();

    // Displayed prices. Bikebiz renders the (possibly discounted) price as the
    // big figure and, when on sale, the original/RRP price in its own span
    // (font-[700] flex items-center leading-[60px]). RSC/JSON-LD only carry
    // the discounted amount, so the RRP is only available from these spans.
    const findPriceSpan = (...classNeedles) => {
      const el = Array.from(document.querySelectorAll('span')).find(s =>
        classNeedles.every(n => s.className.includes(n)) &&
        /^\$[\d,]+\.?\d*$/.test(s.textContent.trim())
      );
      if (!el) return '';
      // Cents are rendered in a separate smaller span ("$179" + ".95")
      const cents = el.nextElementSibling?.textContent?.trim() || '';
      return el.textContent.trim() + (/^\.\d{1,2}$/.test(cents) ? cents : '');
    };
    const originalPriceText = findPriceSpan('font-[700]', 'leading-[60px]', 'items-center');
    const currentPriceText  = findPriceSpan('font-[700]', 'text-[48px]');

    // Gallery images. The main image and thumbnail strip are /_next/image
    // proxies of CDN URLs shaped .../<imageId>/<Product-Slug>/public — decode
    // them back to the full-res CDN URL. The page also renders ~20 related
    // products' images from the same CDN, so keep only images whose slug
    // segment matches this product's handle.
    const galleryImgs = (() => {
      const handle = location.pathname.replace(/\/$/, '').split('/').pop().toLowerCase();
      const urls = [];
      for (const img of document.querySelectorAll('img')) {
        let src = img.getAttribute('src') || '';
        if (src.includes('/_next/image') && src.includes('url=')) {
          try { src = decodeURIComponent(src.split('url=')[1].split('&')[0]); } catch(_) {}
        }
        if (!src.includes('image-cdn.bikebiz.com.au')) continue;
        const parts = src.split('/');
        const slug  = (parts[parts.length - 2] || '').toLowerCase();
        // Image IDs containing "download" are Bikebiz's "IMAGE NOT AVAILABLE"
        // placeholder (carries their logo) — never import those
        const imageId = (parts[parts.length - 3] || '').toLowerCase();
        if (imageId.includes('download')) continue;
        if (slug === handle || slug.startsWith(handle)) urls.push(src);
      }
      return [...new Set(urls)];
    })();

    // ── 1. Try RSC payload (Next.js App Router — has per-variant data) ────────
    try {
      const frames = window.__next_f || [];
      for (const frame of frames) {
        if (!Array.isArray(frame)) continue;
        const text = typeof frame[1] === 'string' ? frame[1] : '';
        if (!text.includes('"quantityAvailable"') || !text.includes('"variants"')) continue;
        const jsonStart = text.indexOf('{');
        if (jsonStart < 0) continue;
        try {
          const data = JSON.parse(text.slice(jsonStart));
          const product = data?.product;
          if (product?.name && Array.isArray(product.variants)) {
            return { source: 'rsc', product, descHtml, originalPriceText, currentPriceText, galleryImgs };
          }
        } catch(_) {}
      }
    } catch(_) {}

    // ── 2. Try JSON-LD Product schema ─────────────────────────────────────────
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const ld = JSON.parse(script.textContent);
        const schemas = Array.isArray(ld) ? ld : [ld];
        for (const s of schemas) {
          if (s['@type'] === 'Product') return { source: 'jsonld', product: s, descHtml, originalPriceText, currentPriceText, galleryImgs };
        }
      } catch(_) {}
    }

    // ── 3. DOM fallback ───────────────────────────────────────────────────────
    const title   = document.querySelector('h1')?.textContent?.trim() || '';
    const priceEl = document.querySelector('[class*="price"],[data-testid*="price"]');
    const priceText = priceEl?.textContent?.trim() || '';
    const sku     = document.querySelector('[class*="sku"],[data-testid*="sku"]')?.textContent?.replace(/sku:?\s*/i,'').trim() || '';
    const imgs    = galleryImgs;

    // Variant options — the size picker is a button group under the
    // "Select size:" label. Don't match bare <select>s: those are the
    // "find parts for your bike" Make/Model/Year dropdowns, not variants.
    const sizeEls = (() => {
      const label = Array.from(document.querySelectorAll('label'))
        .find(l => /select size/i.test(l.textContent));
      let scope = label?.parentElement;
      for (let i = 0; i < 3 && scope; i++) {
        const btns = Array.from(scope.querySelectorAll('button'))
          .map(b => b.textContent.trim())
          .filter(t => t && t.length <= 12 && !/add to cart/i.test(t));
        if (btns.length) return [...new Set(btns)];
        scope = scope.parentElement;
      }
      return [];
    })();

    return { source: 'dom', product: { title, priceText, sku, imgs, sizeEls }, descHtml, originalPriceText, currentPriceText, galleryImgs };
  });

  // ── Interactive pass — colour splitting + per-size SKUs ───────────────────
  // Bikebiz bundles every colourway of a model on one page (round swatches
  // under the "Colour:" label) and only reveals per-size SKUs after clicking
  // a size button. Split each colour into its own product, and flag greyed-out
  // sizes as unavailable (their SKU can't be read until they restock).
  try {
    const colourCount = await countColourSwatches(page);
    if (colourCount >= 2) {
      console.log(`    ${colourCount} colours — splitting into separate products`);
      return await scrapeColourProducts(page, listing, brands, pageData, colourCount);
    }

    const product = normaliseProductPage(listing, pageData, brands);
    const sizeVariants = await extractSizeVariants(page);
    if (sizeVariants.length) {
      product.variants = sizeVariants.map(v => ({ ...v, price: product.priceMin }));
    }
    return product;
  } catch(e) {
    console.log(`    Interactive extraction failed (${e.message.slice(0, 60)}) — using static data`);
    return normaliseProductPage(listing, pageData, brands);
  }
}

// Count the round colour swatches under the "Colour:" label (0 if none).
function countColourSwatches(page) {
  return page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label')).find(el => /^colou?r:?$/i.test(el.textContent.trim()));
    const row = lab?.parentElement?.nextElementSibling;
    if (!row) return 0;
    return Array.from(row.children).filter(c =>
      /rounded-full/.test(c.className) && /cursor-pointer/.test(c.className)
    ).length;
  });
}

function clickColourSwatch(page, idx) {
  return page.evaluate(i => {
    const lab = Array.from(document.querySelectorAll('label')).find(el => /^colou?r:?$/i.test(el.textContent.trim()));
    const row = lab?.parentElement?.nextElementSibling;
    const swatches = Array.from(row?.children || []).filter(c =>
      /rounded-full/.test(c.className) && /cursor-pointer/.test(c.className)
    );
    swatches[i]?.click();
  }, idx);
}

// Read the currently selected colour name (second label in the "Colour:" block).
function readColourName(page) {
  return page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label')).find(el => /^colou?r:?$/i.test(el.textContent.trim()));
    return lab?.parentElement?.textContent?.replace(/colou?r:?/i, '').trim() || '';
  });
}

// Read the main gallery image for the current colour — the first large
// image-cdn img whose slug matches this product (excludes related products).
function readMainImage(page) {
  return page.evaluate(() => {
    const handle = location.pathname.replace(/\/$/, '').split('/').pop().toLowerCase();
    for (const img of document.querySelectorAll('img')) {
      let src = img.getAttribute('src') || '';
      if (src.includes('/_next/image') && src.includes('url=')) {
        try { src = decodeURIComponent(src.split('url=')[1].split('&')[0]); } catch(_) {}
      }
      if (!src.includes('image-cdn.bikebiz.com.au')) continue;
      const parts = src.split('/');
      const slug  = (parts[parts.length - 2] || '').toLowerCase();
      if (!slug.startsWith(handle)) continue;
      // Skip the "IMAGE NOT AVAILABLE" placeholder (id contains "download")
      if ((parts[parts.length - 3] || '').toLowerCase().includes('download')) continue;
      if ((img.width || 0) > 100) return src;
    }
    return '';
  });
}

// Read the currently displayed price spans (they can change per colour).
function readPriceSpans(page) {
  return page.evaluate(() => {
    const find = (...needles) => {
      const el = Array.from(document.querySelectorAll('span')).find(s =>
        needles.every(n => s.className.includes(n)) && /^\$[\d,]+\.?\d*$/.test(s.textContent.trim()));
      if (!el) return '';
      // Cents are rendered in a separate smaller span ("$179" + ".95")
      const cents = el.nextElementSibling?.textContent?.trim() || '';
      return el.textContent.trim() + (/^\.\d{1,2}$/.test(cents) ? cents : '');
    };
    return {
      original: find('font-[700]', 'leading-[60px]', 'items-center'),
      current:  find('font-[700]', 'text-[48px]'),
    };
  });
}

// Click each size button of the current colour and capture its SKU.
// Greyed-out sizes (disabled / opacity-40 / strike line) are never clicked —
// clicking them does nothing and the SKU display would keep the previous
// size's value — they're recorded as unavailable with an empty SKU.
async function extractSizeVariants(page) {
  const readSizes = () => page.evaluate(() => {
    const sizeLabel = Array.from(document.querySelectorAll('label')).find(l => /select size/i.test(l.textContent));
    let scope = sizeLabel?.parentElement;
    for (let i = 0; i < 3 && scope; i++) {
      const btns = Array.from(scope.querySelectorAll('button'))
        .filter(b => b.textContent.trim() && b.textContent.trim().length <= 12 && !/add to cart/i.test(b.textContent));
      if (btns.length) {
        return btns.map(b => ({
          size: b.textContent.trim(),
          unavailable: b.disabled || /opacity-\d|border-grey/.test(b.className) || !!b.querySelector('[class*="line"]'),
        }));
      }
      scope = scope.parentElement;
    }
    return [];
  });

  const clickSize = idx => page.evaluate(i => {
    const sizeLabel = Array.from(document.querySelectorAll('label')).find(l => /select size/i.test(l.textContent));
    let scope = sizeLabel?.parentElement;
    for (let k = 0; k < 3 && scope; k++) {
      const btns = Array.from(scope.querySelectorAll('button'))
        .filter(b => b.textContent.trim() && b.textContent.trim().length <= 12 && !/add to cart/i.test(b.textContent));
      if (btns.length) { btns[i]?.click(); return; }
      scope = scope.parentElement;
    }
  }, idx);

  const readSku = () => page.evaluate(() => {
    const lab = Array.from(document.querySelectorAll('label,p,span')).find(el =>
      /^sku/i.test(el.textContent.trim()) && el.textContent.trim().length < 30);
    return lab?.parentElement?.textContent?.replace(/sku(\/part number)?:?/i, '').trim() || '';
  });

  const sizes = await readSizes();
  const variants = [];
  for (let i = 0; i < sizes.length; i++) {
    if (sizes[i].unavailable) {
      variants.push({ size: sizes[i].size, sku: '', available: false, inventoryQty: 0 });
      continue;
    }
    await clickSize(i);
    await sleep(350);
    variants.push({ size: sizes[i].size, sku: await readSku(), available: true, inventoryQty: 1 });
  }
  return variants;
}

// One product per colour swatch: click through each colour, read its name,
// main image and prices, then click through the sizes for SKUs/availability.
async function scrapeColourProducts(page, listing, brands, pageData, colourCount) {
  const products = [];
  for (let c = 0; c < colourCount; c++) {
    await clickColourSwatch(page, c);
    await sleep(900);

    const colourName = (await readColourName(page)) || `Colour ${c + 1}`;
    const mainImg    = await readMainImage(page);
    const prices     = await readPriceSpans(page);
    const variants   = await extractSizeVariants(page);

    const base = normaliseProductPage(listing, {
      ...pageData,
      originalPriceText: prices.original || pageData.originalPriceText,
      currentPriceText:  prices.current  || pageData.currentPriceText,
      galleryImgs:       mainImg ? [mainImg] : pageData.galleryImgs,
    }, brands);

    const colourSlug = colourName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const available  = variants.filter(v => v.available).length;
    console.log(`    [colour ${c + 1}/${colourCount}] ${colourName} — ${variants.length} sizes (${variants.length - available} unavailable)`);

    products.push({
      ...base,
      title:    `${base.title} - ${colourName}`,
      handle:   `${base.handle}-${colourSlug}`,
      // Stable identity — SKUs shift as sizes go in/out of stock, so key the
      // product on handle+colour for caching and draft status
      sourceId: `${base.handle}-${colourSlug}`,
      images:   mainImg ? [mainImg] : base.images,
      variants: variants.length
        ? variants.map(v => ({ ...v, price: base.priceMin }))
        : base.variants,
    });
  }
  return products;
}

// ── Normalise scraped product page into standard shape ────────────────────────
function normaliseProductPage(listing, pageData, brands) {
  const { source, product, descHtml = '', originalPriceText = '', currentPriceText = '', galleryImgs = [] } = pageData;

  let title       = listing.name;
  let sku         = '';
  let priceMin    = 0;
  let priceMax    = 0;
  let images      = listing.thumbUrl ? [listing.thumbUrl] : [];
  let description = '';
  let variants    = [];

  if (source === 'rsc') {
    // Saleor/GraphQL product from Next.js App Router RSC payload
    const p = product;
    title       = p.name || title;
    // p.description is Saleor rich-text JSON, not HTML — use the rendered DOM HTML instead
    description = descHtml || p.description || '';

    priceMin = parseFloat(p.pricing?.priceRange?.start?.gross?.amount) || 0;
    priceMax = parseFloat(p.pricing?.priceRange?.stop?.gross?.amount)  || priceMin;

    if (p.images?.length) images = p.images.map(img => img.url).filter(Boolean);

    if (p.variants?.length) {
      sku = p.variants[0]?.sku || '';
      variants = p.variants.map(v => {
        const varPrice  = v.pricing?.price?.gross?.amount ?? priceMin;
        const sizeAttr  = (v.attributes || []).find(a =>
          /size|colour|color/i.test(a.attribute?.name || '')
        );
        const sizeName  = v.name || sizeAttr?.values?.[0]?.name || 'Default';
        return {
          size:        sizeName,
          sku:         v.sku || sku,
          price:       parseFloat(varPrice) || priceMin,
          available:   v.isAvailable !== false,
          inventoryQty: v.quantityAvailable ?? 1,
        };
      });
    }

  } else if (source === 'jsonld') {
    // JSON-LD Product schema (fallback — single offer, no per-variant inventory)
    title       = product.name || title;
    // JSON-LD description is SEO text, not body HTML — use the rendered DOM HTML instead
    description = descHtml || '';
    sku         = product.sku || '';

    const offers = Array.isArray(product.offers) ? product.offers : (product.offers ? [product.offers] : []);
    const prices = offers.map(o => parseFloat(String(o.price || '0').replace(/[^0-9.]/g, ''))).filter(p => p > 0);
    if (prices.length) { priceMin = Math.min(...prices); priceMax = Math.max(...prices); }

    const ldImgs = Array.isArray(product.image) ? product.image : (product.image ? [product.image] : []);
    if (ldImgs.length) images = ldImgs;

    variants = offers.map((o, idx) => ({
      size:        o.name || o.itemCondition || (offers.length === 1 ? 'Default' : `Option ${idx + 1}`),
      sku:         o.sku || sku,
      price:       parseFloat(String(o.price || '0').replace(/[^0-9.]/g, '')) || priceMin,
      available:   o.availability !== 'https://schema.org/OutOfStock',
      inventoryQty: o.availability === 'https://schema.org/OutOfStock' ? 0 : 1,
    }));

  } else {
    // DOM fallback
    title       = product.title || title;
    sku         = product.sku || '';
    description = descHtml || '';

    // Prefer the detail-page price span — the listing card shows the sale
    // price first, so its first $ match is the discounted amount
    const rawPrice = currentPriceText || product.priceText || listing.priceText || '';
    priceMin = parseFloat(rawPrice.replace(/[^0-9.]/g, '')) || 0;
    priceMax = priceMin;

    if (product.imgs?.length) images = product.imgs;
    else if (listing.thumbUrl) images = [listing.thumbUrl];

    if (product.sizeEls?.length) {
      variants = product.sizeEls.map(sz => ({
        size:        sz,
        sku:         sku,
        price:       priceMin,
        available:   true,
        inventoryQty: 1,
      }));
    }
  }

  // Prefer the DOM gallery images when they're more complete — RSC/JSON-LD
  // usually carry only the primary image, and the listing thumb is low-res.
  if (galleryImgs.length > images.length) images = galleryImgs;

  // On-sale products: every source above carries the discounted price, and the
  // original (RRP) only appears in its own span on the page. Prefer the RRP so
  // gap analysis compares regular pricing, lifting variants that share the
  // discounted base price (variants with genuinely different prices are kept).
  const originalPrice = parseFloat(originalPriceText.replace(/[^0-9.]/g, '')) || 0;
  if (originalPrice > priceMin) {
    const discounted = priceMin;
    variants = variants.map(v =>
      (!v.price || v.price === discounted) ? { ...v, price: originalPrice } : v
    );
    priceMin = originalPrice;
    priceMax = Math.max(priceMax, originalPrice);
  }

  // Ensure at least one variant
  if (!variants.length) {
    // Try to parse price from listing if we still have none
    if (!priceMin && listing.priceText) {
      priceMin = parseFloat(listing.priceText.replace(/[^0-9.]/g, '')) || 0;
      priceMax = priceMin;
    }
    variants = [{ size: 'Default', sku, price: priceMin, available: true, inventoryQty: 1 }];
  }

  if (!priceMin) {
    const prices = variants.map(v => v.price).filter(p => p > 0);
    if (prices.length) { priceMin = Math.min(...prices); priceMax = Math.max(...prices); }
  }

  const vendor = brands.find(b => title.toLowerCase().includes(b.toLowerCase()))
    || title.split(' ')[0] || '';

  const path   = new URL(listing.href).pathname.replace(/\/$/, '');
  const handle = path.split('/').pop() || 'unknown';

  return {
    sourceId:       sku || handle,
    handle,
    title,
    description,
    vendor,
    productType:    '',
    images,
    variants,
    priceMin,
    priceMax,
    sourceUrl:      listing.href,
    sourcePlatform: 'bikebiz',
  };
}

// Scrape a single product URL (used by the watchlist rescrape). Returns an
// array — colour-bundled pages yield one product per colour.
export async function scrapeBikebizProduct(url) {
  const browser = await openBrowser();
  try {
    const page    = await newPage(browser);
    const listing = { href: url, name: '', priceText: '', thumbUrl: '' };
    const detail  = await scrapeProductPage(page, listing, []);
    return Array.isArray(detail) ? detail : (detail ? [detail] : []);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Brand & subcategory discovery ─────────────────────────────────────────────

export async function discoverCompetitorBrands(baseUrl) {
  const browser = await openBrowser();
  try {
    const page = await newPage(browser);
    await page.goto(`${BASE}/brands/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);

    const seen      = new Set();
    const allBrands = [];

    // The brands page shows one letter's brands at a time via JS-driven letter buttons.
    // Click each letter A-Z and collect brands after each click.
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      const clicked = await page.evaluate(ltr => {
        const target = Array.from(document.querySelectorAll('p'))
          .find(p => p.textContent.trim() === ltr && p.closest('[class*="cursor-pointer"]'));
        if (!target) return false;
        target.closest('[class*="cursor-pointer"]').click();
        return true;
      }, letter);

      if (!clicked) continue;
      await sleep(1200);

      const letterBrands = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/brands/"]'))
          .map(a => {
            const path  = new URL(a.href).pathname.replace(/\/$/, '');
            const parts = path.split('/').filter(Boolean);
            // Only direct brand pages: /brands/{handle}
            if (parts.length !== 2 || parts[0] !== 'brands') return null;
            const handle = parts[1].toLowerCase();
            // Skip single-letter nav links e.g. /brands/a
            if (/^[a-z]$/.test(handle)) return null;
            // Get visible text only — clone and strip images/SVGs first
            const clone = a.cloneNode(true);
            clone.querySelectorAll('img, svg').forEach(el => el.remove());
            const name = clone.textContent.replace(/\s+/g, ' ').trim()
                      || a.title?.trim()
                      || handle;
            return { name, handle };
          })
          .filter(Boolean);
      });

      let added = 0;
      for (const b of letterBrands) {
        if (!seen.has(b.handle)) {
          seen.add(b.handle);
          allBrands.push(b);
          added++;
        }
      }
      console.log(`  [BikeBiz] ${letter}: ${added} new brands (total: ${allBrands.length})`);
    }

    return allBrands;
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function discoverCompetitorSubcategories(baseUrl, vendorHandle) {
  const browser = await openBrowser();
  try {
    const page = await newPage(browser);
    await page.goto(`${BASE}/brands/${vendorHandle}/`, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2500);

    const subcategories = await page.evaluate(() => {
      const links = document.querySelectorAll('#carousel a.carousel-item');
      const seen = new Set();
      return Array.from(links).map(a => {
        const slug = a.href.split('/').filter(Boolean).pop();
        if (!slug || seen.has(slug)) return null;
        seen.add(slug);
        const label = a.querySelector('span')?.textContent.trim() || slug;
        return { label, filterParam: slug };
      }).filter(Boolean);
    });

    return subcategories;
  } finally {
    await browser.close().catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
