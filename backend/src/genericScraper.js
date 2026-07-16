/**
 * Generic Scraper — Universal Puppeteer-based product scraper
 *
 * Works on any ecommerce site without site-specific code. Called as the
 * fallback from scraper.js when no dedicated scraper matches.
 *
 * Detection layers (applied in order):
 *  1. In-browser platform fingerprinting (Shopify, WooCommerce, BigCommerce, Neto, Magento, …)
 *  2. JSON-LD Schema.org Product (works on ~70% of ecommerce sites)
 *  3. Platform-specific variant JSON (Shopify .json API, WooCommerce variations form)
 *  4. DOM heuristics: <select> options, swatch buttons, radio groups
 *  5. OpenGraph + h1 + price-pattern fallback
 *
 * Pagination detection:
 *  - "Load More" / "Show More" button click
 *  - Numbered: ?page=N, ?p=N, /page/N — follows <a rel="next"> or increments
 *  - Infinite scroll: scrollTo bottom, wait for new content
 *
 * Brand removal:
 *  - Strips site domain and name from description text (sentence-level)
 *  - Removes images whose URL contains the site domain or logo/banner keywords
 */

import puppeteer from 'puppeteer-core';
import axios     from 'axios';
import { jobStore } from './jobStore.js';

const MAX_PAGES_DEFAULT    = 10;
const MAX_PRODUCTS_DEFAULT = 20;

// ── Browser ───────────────────────────────────────────────────────────────────

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
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
  ];
  const proxyUrl = process.env.SCRAPER_PROXY;
  if (proxyUrl) args.push(`--proxy-server=${proxyUrl}`);
  return puppeteer.launch({ executablePath, headless: true, args, defaultViewport: { width: 1280, height: 900 } });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',  { get: () => [1, 2, 3] });
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en-US;q=0.9' });
  const proxyUrl = process.env.SCRAPER_PROXY;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      if (u.username) await page.authenticate({ username: u.username, password: decodeURIComponent(u.password) });
    } catch (_) {}
  }
  return page;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function scrapeGeneric(targetUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_DEFAULT;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_DEFAULT;

  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
  const startTime = Date.now();

  let origin, domain, siteName;
  try {
    const u = new URL(targetUrl);
    origin   = u.origin;
    domain   = u.hostname;
    siteName = domain.replace(/^www\./, '').split('.')[0];
  } catch (_) {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🌐  Generic Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${targetUrl}`);
  console.log(`  Site         : ${domain}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Max products : ${MAX_PRODUCTS} | Max pages: ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  onProgress(`Loading ${domain}…`, 5);

  let browser;
  try {
    browser = await openBrowser();
    const page = await newPage(browser);

    // Load the target URL
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (_) {
      try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 40000 }); } catch (_) {}
    }
    await sleep(1500);

    // Fingerprint the platform using in-browser context
    const platform = await detectPlatformInBrowser(page);
    console.log(`[Generic] Platform detected: ${platform}`);
    onProgress(`Platform: ${platform} — analysing page structure…`, 10);

    // Determine if we're on a listing page (category/brand/search) or a product detail page
    const pageType = await detectPageType(page, targetUrl);
    console.log(`[Generic] Page type: ${pageType}`);

    let productUrls = [];

    if (pageType === 'product') {
      // Scrape this single product directly
      productUrls = [targetUrl];
    } else {
      // Collect product URLs from the listing page (with pagination)
      onProgress('Extracting product cards from listing…', 15);
      productUrls = await collectProductUrls(page, targetUrl, origin, domain, platform, MAX_PRODUCTS, MAX_PAGES, onProgress, jobId);
      console.log(`[Generic] Collected ${productUrls.length} product URLs`);
    }

    if (!productUrls.length) throw new Error(`No products found at ${targetUrl}. Check URL and brand filters.`);

    // Scrape each product page
    onProgress(`Fetching ${productUrls.length} products…`, 30);
    const products = [];

    for (let i = 0; i < productUrls.length; i++) {
      if (jobId && jobStore.isCancelled(jobId)) { console.log('[Generic] Cancelled'); break; }

      const url = productUrls[i];
      const ts  = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      console.log(`  [${i+1}/${productUrls.length}] [${ts}] ${url}`);

      try {
        const product = await scrapeProductPage(page, url, platform, origin, domain, brands);
        if (product) {
          const clean = removeBranding(product, domain, siteName, brands);
          // Apply brand filter
          const bl = brands.map(b => b.toLowerCase());
          if (bl.length && !bl.some(b =>
            (clean.title || '').toLowerCase().includes(b) || (clean.vendor || '').toLowerCase().includes(b)
          )) {
            console.log(`    ⟳ Skipped (brand filter): ${clean.title}`);
          } else {
            products.push(clean);
            console.log(`    ✓ ${clean.title} — ${clean.variants.length} variant(s), $${clean.priceMin}–$${clean.priceMax}`);
          }
          onProgress(`[${i+1}/${productUrls.length}] ${clean.title}`, 30 + Math.floor(((i+1)/productUrls.length)*60));
        }
      } catch (e) {
        console.log(`    ✗ ${e.message.slice(0, 80)}`);
      }
      await sleep(300);
    }

    await browser.close();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalVariants = products.reduce((s, p) => s + (p.variants?.length || 0), 0);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅  Generic Scraper finished in ${elapsed}s`);
    console.log(`  Products : ${products.length}  |  Variants: ${totalVariants}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    return products;

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

// ── Platform fingerprinting (runs in browser context) ─────────────────────────
// Checks window globals and HTML markers set by known platforms.

function detectPlatformInBrowser(page) {
  return page.evaluate(() => {
    // Shopify
    if (window.Shopify || window.ShopifyAnalytics || window.ShopifyXr) return 'shopify';
    // WooCommerce
    if (window.woocommerce_params || window.wc_cart_params || window.wc_add_to_cart_params) return 'woocommerce';
    // BigCommerce
    if (window.BCData || window.BCAF || window.Bigcommerce) return 'bigcommerce';
    // Magento
    if (window.Mage || window.MagentoCatalogProductConfigurable || document.querySelector('[data-mage-init]')) return 'magento';
    // PrestaShop
    if (window.prestashop) return 'prestashop';
    // Neto/Maropost
    if (document.querySelector('a[href*="/_myacct"]') || document.querySelector('link[href*="netostatic"]')) return 'neto';
    // Squarespace
    if (window.SQUARESPACE_RAWTEMPLATE || document.querySelector('meta[generator*="Squarespace"]')) return 'squarespace';

    // HTML-body markers
    const html = document.documentElement.innerHTML;
    if (/cdn\.shopify\.com|myshopify\.com|Shopify\.theme/.test(html)) return 'shopify';
    if (/wp-content\/plugins\/woocommerce|woocommerce-/.test(html))   return 'woocommerce';
    if (/\/pub\/static\/|Magento_Ui|mage\//.test(html))               return 'magento';

    return 'generic';
  });
}

// ── Page type detection ───────────────────────────────────────────────────────
// Returns 'listing', 'product', or 'unknown'.

async function detectPageType(page, url) {
  // URL path hints are the fastest signal
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (_) { return url; } })();

  const PRODUCT_PATHS = ['/products/', '/product/', '/item/', '/pd/', '/p/'];
  const LISTING_PATHS = ['/collections/', '/categories/', '/category/', '/brands/', '/brand/', '/search', '/shop', '/c/'];

  if (PRODUCT_PATHS.some(p => path.includes(p))) return 'product';
  if (LISTING_PATHS.some(p => path.includes(p))) return 'listing';

  // DOM-based detection
  return page.evaluate(() => {
    // Product signals
    const hasJsonLdProduct = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).some(s => {
      try {
        const d = JSON.parse(s.textContent);
        return d['@type'] === 'Product' || (Array.isArray(d) && d.some(x => x?.['@type'] === 'Product'));
      } catch (_) { return false; }
    });

    const addToCartEl = document.querySelector(
      'button[name="add"], [name="add-to-cart"], form[action*="cart/add"], .add_to_cart_button, [data-testid*="add-to-cart"]'
    ) || Array.from(document.querySelectorAll('button')).find(
      b => /add\s+to\s+(cart|bag)|buy\s+now/i.test(b.textContent)
    );

    // Listing signals: 4+ product cards (anchor + image + price in ancestor)
    const cardCount = Array.from(document.querySelectorAll('a img')).filter(img => {
      const a = img.closest('a');
      if (!a) return false;
      let el = a.parentElement;
      for (let i = 0; i < 6 && el; i++) {
        if (/\$[\d,]+/.test(el.textContent)) return true;
        el = el.parentElement;
      }
      return false;
    }).length;

    if (hasJsonLdProduct || addToCartEl) return 'product';
    if (cardCount >= 4) return 'listing';
    return 'unknown';
  });
}

// ── Collect product URLs from a listing/category/brand page ───────────────────

async function collectProductUrls(page, startUrl, origin, domain, platform, maxProducts, maxPages, onProgress, jobId) {
  const seen = new Set();

  function merge(cards) {
    for (const card of cards) {
      if (card.href && !seen.has(card.href)) seen.add(card.href);
    }
  }

  merge(await extractCards(page, origin, domain));
  console.log(`[Generic] After initial load: ${seen.size} product URLs`);
  onProgress(`Found ${seen.size} products — paginating…`, 18);

  for (let pageNum = 1; pageNum < maxPages && seen.size < maxProducts; pageNum++) {
    if (jobId && jobStore.isCancelled(jobId)) break;

    const before = seen.size;
    const advanced = await advancePage(page, pageNum, origin, domain);
    if (!advanced) break;

    merge(await extractCards(page, origin, domain));
    console.log(`[Generic] After page ${pageNum + 1}: ${seen.size} URLs (${seen.size - before} new)`);
    onProgress(`Page ${pageNum + 1} — ${seen.size} products…`, 18 + pageNum * 2);

    if (seen.size === before) break; // no new content
  }

  return [...seen].slice(0, maxProducts);
}

// Extract product card links from the current page DOM.
// Finds <a> elements that: (1) contain an <img>, (2) have a price in the surrounding context,
// (3) link to the same origin with a non-navigation path.
function extractCards(page, origin, domain) {
  return page.evaluate((origin, domain) => {
    const results = [];
    const seen    = new Set();

    const SKIP_PATHS = /\/(cart|checkout|account|login|register|contact|about|blog|news|sitemap|cdn|assets|media|static|search|tag)\b/i;

    for (const img of document.querySelectorAll('a img, [class*="product"] a, [class*="item"] a')) {
      // Walk up to find the closest anchor
      let anchor = img.tagName === 'A' ? img : img.closest('a');
      if (!anchor || !anchor.href) {
        if (img.tagName !== 'IMG') continue; // was a non-anchor product div
        continue;
      }

      let href;
      try {
        const u = new URL(anchor.href);
        if (u.hostname !== domain && !u.hostname.endsWith('.' + domain)) continue;
        if (SKIP_PATHS.test(u.pathname)) continue;
        // Must have at least 1 path segment beyond root
        if (u.pathname === '/' || u.pathname === '') continue;
        href = u.origin + u.pathname; // strip query string and hash
      } catch (_) { continue; }

      if (seen.has(href)) continue;

      // Confirm price exists somewhere in the card's ancestor (up to 8 levels)
      let priceText = '';
      let titleText = img.alt?.trim() || '';
      let thumbUrl  = img.src || img.dataset?.src || '';

      let el = anchor.parentElement;
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        const t = el.textContent;
        if (!priceText) {
          const m = t.match(/\$\s*[\d,]+\.?\d{0,2}/);
          if (m) priceText = m[0].replace(/\s/g, '');
        }
        if (!titleText) {
          const h = el.querySelector('h1,h2,h3,h4,[class*="title"],[class*="name"],[class*="heading"]');
          if (h) titleText = h.textContent.trim();
        }
        if (priceText && titleText) break;
        el = el.parentElement;
      }

      // Require either a price or a meaningful title (product images in nav have neither)
      if (!priceText && !titleText) continue;

      seen.add(href);
      results.push({ href, name: titleText, priceText, thumbUrl });
    }

    return results;
  }, origin, domain);
}

// Advance to the next page. Tries (in order): Load More button → <a rel="next"> →
// URL ?page=N increment → infinite scroll. Returns true if page content changed.
async function advancePage(page, pageNum, origin, domain) {
  // 1. "Load More" / "Show More" button
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a')).find(el => {
      if (!el.offsetParent) return false; // hidden
      return /load\s*more|show\s*more|view\s*more|next\s*page/i.test(el.textContent);
    });
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (clicked) {
    await sleep(3000);
    return true;
  }

  // 2. Follow <a rel="next"> or build numbered URL
  const nextUrl = await page.evaluate((pageNum) => {
    const nextLink = document.querySelector('a[rel="next"], .pagination .next a, [class*="pagination"] a[class*="next"]');
    if (nextLink?.href) return nextLink.href;

    const u = new URL(location.href);

    if (u.searchParams.has('page')) {
      u.searchParams.set('page', String(pageNum + 1));
      return u.href;
    }
    if (u.searchParams.has('p')) {
      u.searchParams.set('p', String(pageNum + 1));
      return u.href;
    }
    if (/\/page\/(\d+)/.test(u.pathname)) {
      return u.href.replace(/\/page\/\d+/, `/page/${pageNum + 1}`);
    }
    return null;
  }, pageNum);

  if (nextUrl) {
    try {
      await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(1000);
      return true;
    } catch (_) { return false; }
  }

  // 3. Infinite scroll — scroll and wait for DOM to grow
  const beforeHeight = await page.evaluate(() => document.body.scrollHeight);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(3000);
  const afterHeight = await page.evaluate(() => document.body.scrollHeight);
  return afterHeight > beforeHeight;
}

// ── Scrape a single product page ──────────────────────────────────────────────

async function scrapeProductPage(page, url, platform, origin, domain, brands) {
  // For Shopify: try the product JSON API first — gives the most complete variant data
  if (platform === 'shopify') {
    const shopifyProduct = await tryShopifyJsonApi(url, origin);
    if (shopifyProduct) return shopifyProduct;
  }

  // Navigate to the product page
  const currentUrl = page.url();
  if (currentUrl !== url) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (_) {
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (_) {}
    }
    await sleep(800);
  }

  // Extract product data from the page
  const raw = await page.evaluate((platform) => {
    // ── JSON-LD (most reliable across all platforms) ─────────────────────────
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d      = JSON.parse(script.textContent);
        const schemas = Array.isArray(d) ? d : [d];
        const product = schemas.find(s => s?.['@type'] === 'Product');
        if (product) return { source: 'jsonld', data: product };
      } catch (_) {}
    }

    // ── Shopify: window.ShopifyAnalytics or script#ProductJson ───────────────
    if (platform === 'shopify') {
      try {
        const meta = window.ShopifyAnalytics?.meta?.product;
        if (meta) return { source: 'shopify_analytics', data: meta };
      } catch (_) {}

      for (const script of document.querySelectorAll('script[type="application/json"]')) {
        if (!/(product|ProductJson)/i.test(script.id + script.className)) continue;
        try {
          const d = JSON.parse(script.textContent);
          if (d.variants || d.options) return { source: 'shopify_json', data: d };
        } catch (_) {}
      }
    }

    // ── WooCommerce: variations form ─────────────────────────────────────────
    if (platform === 'woocommerce') {
      const form = document.querySelector('form.variations_form, form[data-product_variations]');
      if (form) {
        try {
          const vars = JSON.parse(form.dataset.productVariations || '[]');
          if (vars.length) return { source: 'woocommerce', data: { formVars: vars, formId: form.dataset.productId } };
        } catch (_) {}
      }
    }

    // ── OpenGraph + DOM fallback ─────────────────────────────────────────────
    const og = attr => document.querySelector(`meta[property="${attr}"]`)?.content?.trim() || '';
    const title     = og('og:title') || document.querySelector('h1')?.textContent?.trim() || '';
    const image     = og('og:image');
    const desc      = og('og:description') || document.querySelector('[itemprop="description"]')?.textContent?.trim() || '';
    const priceOg   = og('product:price:amount') || document.querySelector('[itemprop="price"]')?.content?.trim() || '';
    const sku       = document.querySelector('[itemprop="sku"]')?.content?.trim() ||
                      document.querySelector('[class*="sku"],[data-testid*="sku"]')?.textContent?.replace(/sku:?\s*/i,'').trim() || '';

    // Collect images from the product gallery area
    const galleryImgs = Array.from(document.querySelectorAll(
      '[class*="gallery"] img, [class*="product-image"] img, [class*="product__image"] img, [class*="swiper"] img'
    )).map(i => i.src || i.dataset?.src).filter(Boolean);

    return {
      source: 'dom',
      data: { title, image, desc, priceOg, sku, galleryImgs },
    };
  }, platform);

  // Normalise raw data into standard product shape
  let product = normaliseRaw(raw, url, brands);
  if (!product?.title) return null;

  // Variant extraction (separate pass — needs DOM interaction)
  const variants = await extractVariants(page, platform, product.priceMin);
  if (variants.length) product.variants = variants;

  // Gather all available product images from the page
  const pageImages = await extractProductImages(page, domain);
  if (pageImages.length > product.images.length) product.images = pageImages;

  return product;
}

// Shopify product JSON API — fastest path for full variant+inventory data
async function tryShopifyJsonApi(productUrl, origin) {
  try {
    const path   = new URL(productUrl).pathname.replace(/\/$/, '');
    const handle = path.split('/').pop();
    const apiUrl = `${origin}/products/${handle}.json`;

    const r = await axios.get(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 10000,
      validateStatus: s => true,
    });

    if (r.status !== 200 || !r.data?.product) return null;
    const p = r.data.product;

    const variants = (p.variants || []).map(v => ({
      size:        v.option1 || v.title || 'Default',
      sku:         v.sku || '',
      price:       parseFloat(v.price) || 0,
      compareAt:   parseFloat(v.compare_at_price) || null,
      available:   v.available !== false,
      inventoryQty: v.inventory_quantity ?? (v.available ? 1 : 0),
    }));

    const prices  = variants.map(v => v.price).filter(x => x > 0);
    const images  = (p.images || []).map(i => i.src).filter(Boolean);
    const options = (p.options || []).map(o => ({ name: o.name, values: o.values }));

    return {
      sourceId:       String(p.id),
      handle:         p.handle || handle,
      title:          p.title  || '',
      description:    p.body_html || '',
      vendor:         p.vendor || '',
      productType:    p.product_type || '',
      images,
      variants,
      options,
      priceMin:       prices.length ? Math.min(...prices) : 0,
      priceMax:       prices.length ? Math.max(...prices) : 0,
      sourceUrl:      productUrl,
      sourcePlatform: 'shopify',
    };
  } catch (_) { return null; }
}

// ── Variant extraction (runs in browser context) ──────────────────────────────
// Tries multiple strategies in order of reliability. Returns [] if nothing found
// (caller keeps the default variant from normaliseRaw).

async function extractVariants(page, platform, basePrice) {
  const variants = await page.evaluate((platform, basePrice) => {
    // ── 1. Shopify: ShopifyAnalytics.meta ────────────────────────────────────
    if (platform === 'shopify') {
      try {
        const mv = window.ShopifyAnalytics?.meta?.product?.variants;
        if (mv?.length) {
          return mv.map(v => ({
            size:        v.option1 || v.title || 'Default',
            sku:         v.sku || '',
            price:       (parseFloat(v.price) || 0) / 100, // cents → dollars
            available:   v.available !== false,
            inventoryQty: v.inventory_quantity ?? (v.available ? 1 : 0),
          }));
        }
      } catch (_) {}

      // Shopify: look for product JSON in <script> tags
      for (const script of document.querySelectorAll('script')) {
        if (!/\bvariants\b/.test(script.textContent)) continue;
        try {
          // Try to find embedded JSON object containing variants array
          const match = script.textContent.match(/"variants"\s*:\s*(\[[\s\S]*?\])/);
          if (match) {
            const variants = JSON.parse(match[1]);
            if (variants.length && variants[0].price !== undefined) {
              return variants.map(v => ({
                size:        v.option1 || v.title || 'Default',
                sku:         v.sku  || '',
                price:       parseFloat(v.price) > 100 ? parseFloat(v.price) / 100 : parseFloat(v.price) || basePrice,
                available:   v.available !== false,
                inventoryQty: v.inventory_quantity ?? 1,
              }));
            }
          }
        } catch (_) {}
      }
    }

    // ── 2. WooCommerce: data-product_variations on form ──────────────────────
    if (platform === 'woocommerce') {
      const form = document.querySelector('form.variations_form, form[data-product_variations]');
      if (form) {
        try {
          const wv = JSON.parse(form.dataset.productVariations || '[]');
          if (wv.length) {
            return wv.map(v => ({
              size:        Object.values(v.attributes || {}).filter(Boolean).join(' / ') || 'Default',
              sku:         v.sku || '',
              price:       parseFloat(v.display_price) || basePrice,
              available:   v.is_in_stock !== false,
              inventoryQty: v.max_qty || (v.is_in_stock ? 1 : 0),
            }));
          }
        } catch (_) {}
      }
    }

    // ── 3. BigCommerce: window.BCData or __remixContext ──────────────────────
    if (platform === 'bigcommerce') {
      try {
        const ctx = window.__remixContext || window.__NEXT_DATA__?.props;
        const walk = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 10) return null;
          if (obj.variants?.length && obj.name) return obj;
          for (const v of Object.values(obj)) { const f = walk(v, depth + 1); if (f) return f; }
          return null;
        };
        const prod = walk(ctx);
        if (prod?.variants?.length) {
          return prod.variants.map(v => ({
            size:        (v.option_values || []).map(o => o.label).join(' / ') || v.sku || 'Default',
            sku:         v.sku || '',
            price:       parseFloat(v.calculated_price || v.price || basePrice) || basePrice,
            available:   v.inventory_level > 0 || v.inventory_level === undefined,
            inventoryQty: v.inventory_level ?? 1,
          }));
        }
      } catch (_) {}
    }

    // ── 4. Generic: <select> elements near the product form ──────────────────
    const productForm = document.querySelector(
      'form[action*="cart"], form[action*="checkout"], form.product-form, #product-form'
    );
    const searchRoot = productForm || document.body;

    const selects = Array.from(searchRoot.querySelectorAll('select')).filter(s => {
      const id = (s.id + s.name + s.className).toLowerCase();
      return /size|option|variant|colour|color|width|length|style/i.test(id) ||
             s.closest('[class*="variant"], [class*="option"], [class*="size"]');
    });

    if (selects.length) {
      // Build all variants from option combinations
      const optionGroups = selects.map(sel =>
        Array.from(sel.querySelectorAll('option'))
          .filter(o => o.value && !/^\s*$|select|choose|pick/i.test(o.textContent))
          .map(o => o.textContent.trim())
      ).filter(g => g.length);

      if (optionGroups.length === 1) {
        return optionGroups[0].map(label => ({
          size: label, sku: '', price: basePrice, available: true, inventoryQty: 1,
        }));
      }
      // Multiple dimensions: use first group as size, flatten
      if (optionGroups[0]?.length) {
        return optionGroups[0].map(label => ({
          size: label, sku: '', price: basePrice, available: true, inventoryQty: 1,
        }));
      }
    }

    // ── 5. Generic: button/swatch size selectors ─────────────────────────────
    const swatchContainers = document.querySelectorAll(
      '[class*="swatch"], [class*="size-option"], [class*="variant-option"], [class*="product-option"]'
    );

    for (const container of swatchContainers) {
      const buttons = Array.from(container.querySelectorAll('button, span[data-value], li[data-value]'))
        .filter(b => {
          const t = b.textContent?.trim();
          return t && t.length <= 15 && !/add|cart|buy|wishlist/i.test(t);
        });
      if (buttons.length >= 2) {
        const seen = new Set();
        const result = [];
        for (const btn of buttons) {
          const label = (btn.dataset.value || btn.dataset.size || btn.textContent?.trim() || '').trim();
          if (label && !seen.has(label)) {
            seen.add(label);
            result.push({
              size:        label,
              sku:         btn.dataset.sku || '',
              price:       parseFloat(btn.dataset.price) || basePrice,
              available:   !btn.disabled && !btn.classList.contains('disabled') && !btn.classList.contains('sold-out'),
              inventoryQty: (btn.disabled || btn.classList.contains('sold-out')) ? 0 : 1,
            });
          }
        }
        if (result.length) return result;
      }
    }

    // ── 6. Radio button groups ────────────────────────────────────────────────
    const radioGroups = {};
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      const name = radio.name || 'default';
      if (/size|option|variant|colour|color/i.test(name)) {
        if (!radioGroups[name]) radioGroups[name] = [];
        const label = document.querySelector(`label[for="${radio.id}"]`)?.textContent?.trim() || radio.value;
        if (label) radioGroups[name].push({ label, available: !radio.disabled });
      }
    }
    const radioGroupValues = Object.values(radioGroups);
    if (radioGroupValues.length) {
      return radioGroupValues[0].map(r => ({
        size:        r.label,
        sku:         '',
        price:       basePrice,
        available:   r.available,
        inventoryQty: r.available ? 1 : 0,
      }));
    }

    return [];
  }, platform, basePrice);

  return variants;
}

// Collect all product images from the page (gallery, zoom, carousel etc.)
function extractProductImages(page, domain) {
  return page.evaluate((domain) => {
    const seen = new Set();
    const imgs = [];

    const candidates = [
      ...document.querySelectorAll('[class*="gallery"] img, [class*="product-image"] img, [class*="product__image"] img'),
      ...document.querySelectorAll('[class*="swiper"] img, [class*="carousel"] img, [class*="slider"] img'),
      ...document.querySelectorAll('img[src*="product"], img[src*="cdn"]'),
    ];

    for (const img of candidates) {
      const src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
      if (!src || src.startsWith('data:') || seen.has(src)) continue;
      if (/logo|banner|header|footer|icon|sprite|favicon|avatar/i.test(src)) continue;
      seen.add(src);
      imgs.push(src);
    }

    return imgs;
  }, domain);
}

// ── Normalise raw extracted data into standard product shape ──────────────────

function normaliseRaw(raw, url, brands) {
  const { source, data } = raw;
  let title = '', description = '', sku = '', images = [], priceMin = 0, priceMax = 0, vendor = '';

  if (source === 'jsonld') {
    const offers = Array.isArray(data.offers) ? data.offers : (data.offers ? [data.offers] : []);
    const prices = offers.map(o => parseFloat(o.price) || 0).filter(x => x > 0);

    title       = data.name || '';
    description = data.description || '';
    sku         = data.sku || data.productID || '';
    vendor      = data.brand?.name || data.brand || '';

    const ldImgs = Array.isArray(data.image) ? data.image : (data.image ? [data.image] : []);
    images = ldImgs.map(i => (typeof i === 'string' ? i : i?.url || '')).filter(Boolean);

    priceMin = prices.length ? Math.min(...prices) : 0;
    priceMax = prices.length ? Math.max(...prices) : priceMin;

  } else if (source === 'shopify_analytics') {
    title       = data.title || '';
    vendor      = data.vendor || '';
    sku         = data.sku   || '';
    images      = data.images || [];
    const prices = (data.variants || []).map(v => (parseFloat(v.price) || 0) / 100).filter(x => x > 0);
    priceMin = prices.length ? Math.min(...prices) : 0;
    priceMax = prices.length ? Math.max(...prices) : priceMin;

  } else if (source === 'shopify_json') {
    title       = data.title || '';
    description = data.description || data.body_html || '';
    vendor      = data.vendor || '';
    images      = (data.images || []).map(i => i.src || i).filter(Boolean);
    const prices = (data.variants || []).map(v => parseFloat(v.price) || 0).filter(x => x > 0);
    priceMin = prices.length ? Math.min(...prices) : 0;
    priceMax = prices.length ? Math.max(...prices) : priceMin;

  } else if (source === 'woocommerce') {
    const wv   = data.formVars || [];
    const prices = wv.map(v => parseFloat(v.display_price) || 0).filter(x => x > 0);
    title    = wv[0]?.name || '';
    priceMin = prices.length ? Math.min(...prices) : 0;
    priceMax = prices.length ? Math.max(...prices) : priceMin;

  } else {
    // DOM fallback
    title       = data.title || '';
    description = data.desc  || '';
    sku         = data.sku   || '';
    images      = data.galleryImgs || (data.image ? [data.image] : []);
    priceMin    = parseFloat((data.priceOg || '').replace(/[^0-9.]/g, '')) || 0;
    priceMax    = priceMin;
  }

  if (!title) return null;

  if (!vendor && brands.length) {
    vendor = brands.find(b => title.toLowerCase().includes(b.toLowerCase())) || '';
  }

  const path   = (() => { try { return new URL(url).pathname; } catch (_) { return url; } })();
  const handle = path.split('/').filter(Boolean).pop()?.replace(/\.html?$/, '') || 'product';

  return {
    sourceId:       sku || handle,
    handle,
    title,
    description,
    vendor,
    productType:    '',
    images:         images.filter(Boolean),
    variants:       [{ size: 'Default', sku, price: priceMin, available: true, inventoryQty: 1 }],
    priceMin,
    priceMax,
    sourceUrl:      url,
    sourcePlatform: 'generic',
  };
}

// ── Brand removal ─────────────────────────────────────────────────────────────
// Strips site name/domain from text fields and removes branded images.

function removeBranding(product, domain, siteName, brands) {
  const terms = [...new Set([
    domain.toLowerCase(),
    domain.replace(/^www\./, '').toLowerCase(),
    siteName.toLowerCase(),
  ])].filter(t => t.length > 2);

  // Description: remove sentences containing the site name
  if (product.description) {
    const stripped = product.description.replace(/<[^>]+>/g, ' '); // strip HTML tags
    product.description = stripped
      .split(/(?<=[.!?])\s+|[\n\r]+/)
      .filter(sentence => !terms.some(t => sentence.toLowerCase().includes(t)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Images: remove any from the competitor's own CDN or with logo/banner patterns
  product.images = (product.images || []).filter(imgUrl => {
    if (!imgUrl) return false;
    const lower = imgUrl.toLowerCase();
    if (terms.some(t => lower.includes(t))) return false;
    if (/logo|banner|header|footer|favicon|icon|sprite|avatar/i.test(lower)) return false;
    return true;
  });

  // Title: strip the site name if it appears (e.g. "Buy at AMX")
  for (const term of terms) {
    if (product.title?.toLowerCase().includes(term)) {
      product.title = product.title
        .replace(new RegExp(`\\b${term}\\b`, 'gi'), '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  return product;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
