/**
 * Hurtle Gear Scraper
 *
 * Hurtlegear is on the Neto/Maropost Commerce platform (Australian hosted).
 * Key traits:
 * - Cloudflare-protected (Puppeteer required)
 * - Each size is a separate product at /{slug} (root-level URL)
 * - Images at /assets/thumb/{SKU}.jpg — SKU is embedded in the filename
 * - Category pages use ?p=N for pagination
 * - Brand search via /search/?q={brand}
 * - Price shown as "Now $X" / "Was $X" in the listing
 *
 * Strategy:
 *  1. Puppeteer-load the collection/search URL (bypasses Cloudflare)
 *  2. Paginate through listing pages, extracting product links + basic data
 *  3. Load each product page for stock status and full description
 *  4. Group size-variants under one parent product (strip " - Small" suffix etc.)
 *  5. Return normalised products matching the standard scraper output format
 */

import puppeteer from 'puppeteer-core';
import { jobStore } from './jobStore.js';

const BASE = 'https://www.hurtlegear.com.au';

const MAX_PAGES_PER_COLLECTION = 5;
const MAX_PRODUCTS_TO_SCRAPE   = 20;

// Neto shows one product per size — strip common size suffixes to group variants
const SIZE_RE = [
  / - (XXS|XS|S|SM|M|MD|L|LG|XL|XXL|2XL|3XL|4XL|5XL|6XL|XXXL|Small|Medium|Large|One Size)$/i,
  / \[Size:? ?(XXS|XS|S|SM|M|MD|L|LG|XL|XXL|2XL|3XL|4XL|5XL|One Size)\]$/i,
  / \((XXS|XS|Small|Medium|Large|One Size)\)$/i,
];

function splitSize(title) {
  for (const re of SIZE_RE) {
    const m = title.match(re);
    if (m) return { parentTitle: title.replace(re, '').trim(), size: m[1] };
  }
  return { parentTitle: title, size: 'Default' };
}

function skuFromImageUrl(imgUrl) {
  const m = (imgUrl || '').match(/\/assets\/(?:thumb|full)\/([^.?/]+)/);
  return m?.[1] || '';
}

// ── Browser launcher ───────────────────────────────────────────────────────────
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
  return puppeteer.launch({
    executablePath, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',  { get: () => [1, 2, 3] });
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en-US;q=0.9' });
  return page;
}

// ── Main entry point ───────────────────────────────────────────────────────────
export async function scrapeHurtlegear(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_TO_SCRAPE;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_PER_COLLECTION;

  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
  const startTime = Date.now();

  onProgress('Starting Hurtle Gear scan...', 5);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🏍️  Hurtle Gear Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${baseUrl}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Max products : ${MAX_PRODUCTS} | Max pages: ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let browser;
  try {
    browser = await openBrowser();
    const page = await newPage(browser);

    // Decide start URL: brand search > passed URL
    const startUrl = buildStartUrl(baseUrl, brands);
    onProgress('Scanning product listings...', 10);

    const listings = await crawlListings(page, startUrl, brands, MAX_PAGES, MAX_PRODUCTS, onProgress);
    console.log(`[Hurtlegear] Found ${listings.length} product entries from listings`);

    if (!listings.length) throw new Error('No products found. Check URL and brand filters.');

    onProgress(`Fetching ${listings.length} product pages...`, 35);
    const detailed = await fetchProductPages(page, listings, onProgress, jobId);

    await browser.close();

    const products    = groupVariants(detailed, brands);
    const elapsedSec  = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalVar    = products.reduce((s, p) => s + (p.variants?.length || 0), 0);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅  Hurtle Gear Scraper finished in ${elapsedSec}s`);
    console.log(`  Products : ${products.length} | Variants: ${totalVar}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    return products;

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function buildStartUrl(baseUrl, brands) {
  // If the user passed a specific non-root URL, honour it
  try {
    const u = new URL(baseUrl);
    if (u.hostname.includes('hurtlegear') && u.pathname !== '/') return baseUrl;
  } catch (_) {}
  // Fall back to brand search
  if (brands.length) {
    return `${BASE}/search/?q=${encodeURIComponent(brands[0])}`;
  }
  return baseUrl;
}

function addPageParam(url, pageNum) {
  try {
    const u = new URL(url.startsWith('http') ? url : BASE + url);
    u.searchParams.set('p', String(pageNum));
    return u.toString();
  } catch (_) {
    return `${url}${url.includes('?') ? '&' : '?'}p=${pageNum}`;
  }
}

// ── Listing crawler ────────────────────────────────────────────────────────────

async function crawlListings(page, startUrl, brands, maxPages, maxProducts, onProgress) {
  const seen    = new Map(); // href → listing item
  const bl      = brands.map(b => b.toLowerCase());

  for (let p = 1; p <= maxPages; p++) {
    if (seen.size >= maxProducts) break;

    const url = p === 1 ? startUrl : addPageParam(startUrl, p);
    console.log(`  [Hurtlegear] Listing page ${p}: ${url.slice(0, 80)}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (_) {
      await sleep(1000);
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }); } catch (_) {}
    }

    await sleep(1000);

    const items = await page.evaluate((baseHref) => {
      const results = [];

      // Scope the search to the main product listing grid.
      // Neto listing pages keep the grid in #results or a similar container;
      // related-product carousels and sidebars are explicitly excluded.
      const LISTING_ROOTS = [
        '#results', '#search-results', '.products-listing', '.product-listing',
        '.category-products', '[class*="product-list"]', 'main',
      ];
      let gridRoot = null;
      for (const sel of LISTING_ROOTS) {
        gridRoot = document.querySelector(sel);
        if (gridRoot) break;
      }
      if (!gridRoot) gridRoot = document.body;

      // Words that identify related/recommended/sidebar sections — any ancestor
      // containing these in its id or class causes the card to be skipped.
      const EXCLUDE_WORDS = [
        'related', 'recommended', 'sidebar', 'upsell', 'cross-sell',
        'also-bought', 'also-viewed', 'widget', 'suggestion', 'featured-product',
      ];
      const inExcludedSection = (el) => {
        let node = el.parentElement;
        while (node && node !== gridRoot) {
          const combined = ((node.id || '') + ' ' + (node.className || '')).toLowerCase();
          if (EXCLUDE_WORDS.some(w => combined.includes(w))) return true;
          node = node.parentElement;
        }
        return false;
      };

      gridRoot.querySelectorAll('a img[src*="/assets/thumb/"]').forEach(img => {
        const link = img.closest('a');
        if (!link) return;
        if (inExcludedSection(link)) return; // skip related/sidebar cards

        const href = link.getAttribute('href') || '';
        // Skip non-product hrefs (categories have trailing slash or multiple path segments)
        const clean = href.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
        if (!clean || clean.includes('#') || clean.split('/').filter(Boolean).length !== 1) return;

        // Walk up to find a price nearby
        let priceText = '';
        let container = link.parentElement;
        for (let depth = 0; depth < 5 && container; depth++) {
          const m = container.textContent.match(/(?:Now|NOW)\s*\$\s*([\d,]+\.?\d*)/i)
                  || container.textContent.match(/\$\s*([\d,]+\.?\d*)/);
          if (m) { priceText = m[1].replace(/,/g, ''); break; }
          container = container.parentElement;
        }

        const fullHref = href.startsWith('http') ? href : (baseHref + clean);
        results.push({
          href:     fullHref,
          title:    (img.getAttribute('alt') || link.textContent.trim()).replace(/\s+/g, ' ').trim(),
          price:    priceText,
          imageUrl: img.getAttribute('src') || '',
        });
      });

      return results;
    }, BASE);

    if (!items.length) {
      console.log(`  [Hurtlegear] No products found on page ${p} — stopping`);
      break;
    }

    let added = 0;
    for (const item of items) {
      if (seen.has(item.href)) continue;
      if (bl.length && !bl.some(b => item.title.toLowerCase().includes(b))) continue;
      if (!item.href || !item.title) continue;
      seen.set(item.href, item);
      added++;
      if (seen.size >= maxProducts) break;
    }

    console.log(`  [Hurtlegear] Page ${p}: ${items.length} found, ${added} new (total: ${seen.size})`);
    onProgress(`Scanning listings — ${seen.size} products...`, Math.min(10 + p * 5, 30));

    // Neto uses ?p=N — stop if this page was clearly short
    if (items.length < 8) break;
    await sleep(500);
  }

  return [...seen.values()];
}

// ── Product page fetcher ───────────────────────────────────────────────────────

async function fetchProductPages(page, items, onProgress, jobId) {
  const results = [];

  for (let i = 0; i < items.length; i++) {
    if (jobId && jobStore.isCancelled(jobId)) {
      console.log('[Hurtlegear] Cancelled');
      break;
    }

    const item = items[i];
    const ts   = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  [${i+1}/${items.length}] [${ts}] ${item.title.slice(0,60)}`);
    onProgress(`[${i+1}/${items.length}] ${item.title.slice(0,50)}`, 35 + Math.floor(((i+1)/items.length) * 55));

    // SKU is embedded in the listing thumbnail URL — use it to filter images on
    // the product detail page so related-product thumbnails are never included.
    const listingSku = skuFromImageUrl(item.imageUrl);

    try {
      await page.goto(item.href, { waitUntil: 'networkidle2', timeout: 45000 });
      await sleep(500);

      const detail = await page.evaluate((listingSku) => {
        const bodyText = document.body.textContent || '';

        // NOW price (sale) or standard price
        const nowM = bodyText.match(/NOW\s*\$\s*([\d,]+\.?\d*)/i);
        const wasM = bodyText.match(/WAS\s*\$\s*([\d,]+\.?\d*)/i);
        const anyM = bodyText.match(/\$\s*([\d,]+\.?\d*)/);
        const price = (nowM?.[1] || anyM?.[1] || '').replace(/,/g, '');
        const compareAtPrice = wasM?.[1]?.replace(/,/g, '') || null;

        // Stock
        const lower = bodyText.toLowerCase();
        const inStock   = lower.includes('in stock') && !lower.includes('out of stock');
        const qtyMatch  = bodyText.match(/in stock[^\d]*(\d+)\s*available/i);
        const stockQty  = qtyMatch ? parseInt(qtyMatch[1]) : (inStock ? 1 : 0);

        // Description — prefer the full Description tab (section.productdetails);
        // the [itemprop=description] span is only a short summary. Strip store
        // boilerplate before returning: the "Why Buy From Hurtle Gear" block and
        // anything else mentioning Hurtle Gear, embedded scripts/JSON, the
        // instructions-PDF link, and the "Bike Fitment" section.
        const descEl = document.querySelector(
          '#description section.productdetails, #product-description, .product-description, [itemprop="description"], .description-content'
        );
        let description = '';
        if (descEl) {
          const clone = descEl.cloneNode(true);
          clone.querySelectorAll('script, style, .hg-why-buy').forEach(el => el.remove());
          // "Bike Fitment:" heading and its content up to the next heading
          clone.querySelectorAll('h1,h2,h3,h4,h5').forEach(h => {
            if (!/bike fitment/i.test(h.textContent)) return;
            let el = h.nextElementSibling;
            while (el && !/^H[1-5]$/.test(el.tagName)) { const next = el.nextElementSibling; el.remove(); el = next; }
            h.remove();
          });
          // Paragraphs that are just an instructions/PDF link
          clone.querySelectorAll('a').forEach(a => {
            if (/instruction|\.pdf/i.test(a.href + ' ' + a.textContent)) (a.closest('p') || a).remove();
          });
          // Any remaining block mentioning the store — deepest first so a
          // wrapper isn't nuked for a mention already removed inside it
          Array.from(clone.querySelectorAll('div,section,p,ul,ol,h3,h4')).reverse().forEach(el => {
            if (/hurtle\s*gear/i.test(el.textContent)) el.remove();
          });
          description = clone.innerHTML.trim();
        }

        // SKU from data attributes or meta (may be more precise than the image-derived one)
        const skuEl  = document.querySelector('[itemprop="sku"], [data-product-sku], .product-sku');
        const skuText = skuEl?.textContent?.trim() || skuEl?.getAttribute('content') || listingSku;

        // Resolve the definitive SKU: prefer the page's own SKU element, fall back to
        // the listing thumbnail SKU. Neto embeds the SKU in every asset filename, so
        // we can use it to filter out related-product images reliably.
        const productSku = skuText || listingSku;

        // Collect full-size images whose filename contains the product's own SKU.
        // This is the only reliable way to exclude related-product thumbnails on Neto —
        // DOM scoping fails because Neto renders related products inside <main>.
        const allImgs = Array.from(
          document.querySelectorAll('img[src*="/assets/full/"], img[src*="/assets/thumb"]')
        ).map(img => img.src).filter(Boolean);

        // The same image is rendered as both /assets/full/ and /assets/thumbL/ —
        // normalise every asset URL to its full-size form, then dedupe ignoring
        // the cache-buster query, so each image is kept once at full resolution.
        const fullImgs = (productSku
          ? allImgs.filter(src => src.toLowerCase().includes(productSku.toLowerCase()))
          : allImgs // no SKU known — fall back to all assets images
        ).map(src => src.replace(/\/assets\/thumb[^/]*\//i, '/assets/full/'));

        const seen = new Set();
        const imgSrcs = [];
        for (const src of fullImgs) {
          const key = src.split('?')[0];
          if (!seen.has(key)) { seen.add(key); imgSrcs.push(src); }
        }

        return { price, compareAtPrice, inStock, stockQty, description, images: imgSrcs, skuText };
      }, listingSku);

      results.push({ ...item, ...detail });
      console.log(`  ✓ ${item.title.slice(0,50)} — $${detail.price} — ${detail.inStock ? 'In Stock' : 'Out of Stock'}`);

    } catch (e) {
      console.log(`  ✗ ${item.href.slice(-40)}: ${e.message.slice(0, 50)}`);
      results.push({ ...item, inStock: true, stockQty: 1 });
    }

    await sleep(300);
  }

  return results;
}

// ── Variant grouping ───────────────────────────────────────────────────────────

function groupVariants(rawProducts, brands) {
  const groups = new Map();

  for (const item of rawProducts) {
    const { parentTitle, size } = splitSize(item.title);
    const key = parentTitle.toLowerCase().trim();

    if (!groups.has(key)) {
      groups.set(key, { parentTitle, items: [], description: '', images: [] });
    }
    const g = groups.get(key);
    g.items.push({ ...item, size });
    if (item.description && !g.description) g.description = item.description;

    // Collect unique images — always in /assets/full/ form (the listing
    // fallback imageUrl is a /assets/thumb/ URL, upgrade it)
    const imgs = (item.images?.length ? item.images : (item.imageUrl ? [item.imageUrl] : []))
      .map(img => img.replace(/\/assets\/thumb[^/]*\//i, '/assets/full/'));
    for (const img of imgs) {
      if (!g.images.includes(img)) g.images.push(img);
    }
  }

  return [...groups.values()].map(g => normaliseProduct(g, brands));
}

function normaliseProduct(group, brands) {
  const firstItem = group.items[0];
  const slug = (firstItem?.href || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');

  const variants = group.items.map(item => {
    const sku = item.skuText || skuFromImageUrl(item.imageUrl) || skuFromImageUrl(item.images?.[0]);
    return {
      size:         item.size,
      sku,
      price:        parseFloat(item.price) || 0,
      compareAtPrice: item.compareAtPrice ? parseFloat(item.compareAtPrice) : null,
      available:    item.inStock ?? true,
      inventoryQty: item.stockQty ?? (item.inStock ? 1 : 0),
    };
  });

  const prices  = variants.map(v => v.price).filter(p => p > 0);
  const vendor  = brands.find(b => group.parentTitle.toLowerCase().includes(b.toLowerCase()))
                || group.parentTitle.split(' ')[0];

  return {
    sourceId:       slug || group.parentTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    handle:         slug || group.parentTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    title:          group.parentTitle,
    description:    group.description,
    vendor,
    productType:    '',
    images:         group.images,
    variants,
    priceMin:       prices.length ? Math.min(...prices) : 0,
    priceMax:       prices.length ? Math.max(...prices) : 0,
    sourceUrl:      firstItem?.href || '',
    sourcePlatform: 'hurtlegear',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
