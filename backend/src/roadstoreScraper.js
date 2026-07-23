/**
 * Road Store Scraper (roadstore.com.au)
 *
 * Road Store is on Neto/Maropost with a headless "BTV" theme:
 * - Listings are rendered client-side by SearchSpring (siteId hmjh5r).
 *   The public JSON API returns sku/name/brand/price/msrp/stock/url per item.
 * - Product pages are rendered by a <product-page> web component that pulls
 *   everything from https://products.btvtech.co/api/products/road/{SKU}/ppr
 *   (clean description HTML, full-res images, per-size child products with
 *   their own SKU, stock flag and quantity).
 * - Category pages embed their SearchSpring background filter in an inline
 *   App.config.river.bgFilters block (hierarchy is HTML-encoded + reversed).
 * - Colours are already separate products, so no colour-splitting is needed.
 *
 * Strategy — no Puppeteer required:
 *  1. Resolve the given URL to SearchSpring params (bgfilter from the category
 *     page HTML, filter.brand from the #/filter:brand:X hash and brand list)
 *  2. Page through the SearchSpring API to collect listing entries
 *  3. Fetch the PPR JSON for each SKU and normalise to the standard format
 */

import * as cheerio from 'cheerio';
import { jobStore } from './jobStore.js';

const BASE    = 'https://www.roadstore.com.au';
const SS_API  = 'https://hmjh5r.a.searchspring.io/api/search/search.json';
const PPR_API = 'https://products.btvtech.co/api/products/road';

const MAX_PAGES_DEFAULT    = 5;
const MAX_PRODUCTS_DEFAULT = 20;
const PER_PAGE             = 100;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9',
  'Referer': BASE + '/',
};

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function scrapeRoadstore(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_DEFAULT;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_DEFAULT;

  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
  const startTime = Date.now();

  onProgress('Starting Road Store scan...', 5);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  🏍️  Road Store Scraper started at ${startedAt}`);
  console.log(`  Target URL   : ${baseUrl}`);
  console.log(`  Target brands: ${brands.length ? brands.join(', ') : 'ALL'}`);
  console.log(`  Max products : ${MAX_PRODUCTS} | Max pages: ${MAX_PAGES}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Direct product URL → scrape just that one
  if (/\/p\//i.test(baseUrl)) {
    const products = await scrapeRoadstoreProduct(baseUrl);
    onProgress('Done', 95);
    return products;
  }

  onProgress('Resolving category filters...', 8);
  const { bgFilters, hashFilters } = await resolveFilters(baseUrl);

  onProgress('Scanning product listings...', 12);
  const listings = await crawlListings({ bgFilters, hashFilters, brands, MAX_PAGES, MAX_PRODUCTS, onProgress, jobId });
  console.log(`[Roadstore] Found ${listings.length} product entries from listings`);
  if (!listings.length) throw new Error('No products found. Check URL and brand filters.');

  onProgress(`Fetching ${listings.length} product details...`, 35);
  const products = await fetchProductDetails(listings, onProgress, jobId);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalVar   = products.reduce((s, p) => s + (p.variants?.length || 0), 0);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ✅  Road Store Scraper finished in ${elapsedSec}s`);
  console.log(`  Products : ${products.length} | Variants: ${totalVar}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  return products;
}

// ── URL → SearchSpring filter resolution ──────────────────────────────────────

async function resolveFilters(rawUrl) {
  const bgFilters   = {};   // field → value (background filter, e.g. category)
  const hashFilters = [];   // [field, value] pairs from the #/filter:… hash

  let u;
  try { u = new URL(rawUrl); } catch { u = new URL(BASE + '/'); }

  // #/filter:brand:Bell/filter:adult_size:M — SearchSpring hash format
  // Searchspring encodes values as $25XX (double-%): replace $25 → % then URL-decode
  const hash = decodeURIComponent(u.hash || '');
  for (const m of hash.matchAll(/filter:([a-z0-9_]+):([^/]+)/gi)) {
    const decoded = decodeURIComponent(m[2].replace(/\$25/g, '%'));
    hashFilters.push([m[1], decoded]);
  }

  // Category/brand pages embed their background filter in an inline config:
  //   bgFilters: { "categories": "Full Face Helmets&gt;Motorcycle Helmets&gt;$PARAM:reverse-me" }
  // The hierarchy is listed leaf-first and must be reversed + '>'-joined.
  if (/^\/(category|brand)\//i.test(u.pathname)) {
    try {
      const res  = await fetch(u.origin + u.pathname, { headers: { ...HEADERS, Accept: 'text/html' } });
      const html = await res.text();
      const block = html.match(/bgFilters\s*:\s*\{([\s\S]*?)\}/);
      if (block) {
        for (const m of block[1].matchAll(/"([a-z0-9_]+)"\s*:\s*"([^"]*)"/gi)) {
          const field = m[1];
          let value   = m[2].replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          let parts   = value.split('>').map(s => s.trim()).filter(Boolean);
          if (parts.includes('$PARAM:reverse-me')) {
            parts = parts.filter(p => !p.startsWith('$PARAM')).reverse();
          }
          if (parts.length) bgFilters[field] = parts.join('>');
        }
      }
    } catch (e) {
      console.log(`[Roadstore] Could not read category filters (${e.message}) — scanning whole store`);
    }
  }

  if (Object.keys(bgFilters).length) console.log('[Roadstore] Background filters:', JSON.stringify(bgFilters));
  if (hashFilters.length)            console.log('[Roadstore] URL hash filters :', JSON.stringify(hashFilters));
  return { bgFilters, hashFilters };
}

function buildSearchUrl({ bgFilters, hashFilters, brandValues, page }) {
  const p = new URLSearchParams({
    siteId: 'hmjh5r',
    resultsFormat: 'native',
    resultsPerPage: String(PER_PAGE),
    page: String(page),
  });
  for (const [field, value] of Object.entries(bgFilters)) p.append(`bgfilter.${field}`, value);
  for (const [field, value] of hashFilters)               p.append(`filter.${field}`, value);
  for (const b of brandValues)                            p.append('filter.brand', b);
  return `${SS_API}?${p.toString()}`;
}

// Brand filters are exact-match on facet values ("Bell", not "bell") — map the
// user's brand strings onto the store's facet spelling before filtering.
async function mapBrandValues(bgFilters, hashFilters, brands) {
  if (!brands.length) return [];
  try {
    const data   = await getJson(buildSearchUrl({ bgFilters, hashFilters, brandValues: [], page: 1 }));
    const values = (data.facets || []).find(f => f.field === 'brand')?.values?.map(v => v.value) || [];
    return brands.map(b => values.find(v => v.toLowerCase() === b.toLowerCase().trim()) || b);
  } catch {
    return brands;
  }
}

// ── Listing crawl (SearchSpring API) ──────────────────────────────────────────

async function crawlListings({ bgFilters, hashFilters, brands, MAX_PAGES, MAX_PRODUCTS, onProgress, jobId }) {
  const brandValues = await mapBrandValues(bgFilters, hashFilters, brands);
  const listings = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (jobId && jobStore.isCancelled(jobId)) { console.log('[Roadstore] Cancelled'); break; }

    const data    = await getJson(buildSearchUrl({ bgFilters, hashFilters, brandValues, page }));
    const results = data.results || [];
    const total   = data.pagination?.totalResults ?? results.length;
    console.log(`  [Roadstore] Listing page ${page}: ${results.length} items (total: ${total})`);

    for (const r of results) {
      if (listings.length >= MAX_PRODUCTS) break;
      if (!r.sku) continue;
      listings.push({
        sku:      r.sku,
        title:    r.name || '',
        brand:    r.brand || '',
        url:      r.url || `${BASE}/p/${r.sku}`,
        price:    parseFloat(r.price) || 0,
        msrp:     parseFloat(r.msrp)  || 0,
        inStock:  r.ss_stock === 'In Stock',
        thumbUrl: r.imageUrl || '',
      });
    }

    onProgress(`Found ${listings.length} products...`, Math.min(12 + page * 4, 32));
    if (listings.length >= MAX_PRODUCTS) break;
    if (page >= (data.pagination?.totalPages || 1)) break;
  }

  return listings.slice(0, MAX_PRODUCTS);
}

// ── Product details (PPR API) ─────────────────────────────────────────────────

async function fetchProductDetails(listings, onProgress, jobId) {
  const products = [];

  for (let i = 0; i < listings.length; i++) {
    if (jobId && jobStore.isCancelled(jobId)) { console.log('[Roadstore] Cancelled'); break; }
    const item = listings[i];
    const time = new Date().toLocaleTimeString('en-AU');
    console.log(`  [${i + 1}/${listings.length}] [${time}] ${item.title.slice(0, 60)}`);

    try {
      const ppr = await getJson(`${PPR_API}/${encodeURIComponent(item.sku)}/ppr`);
      const product = normaliseProduct(ppr, item);
      products.push(product);
      const stock = product.variants.some(v => v.available) ? 'In Stock' : 'Out of Stock';
      console.log(`  ✓ ${product.title.slice(0, 50)} — $${product.priceMin} — ${stock}`);
    } catch (e) {
      console.log(`  ✗ ${item.sku}: ${e.message} — using listing data only`);
      products.push(normaliseFromListing(item));
    }

    onProgress(`Scraped ${i + 1}/${listings.length} products...`,
               35 + Math.round(((i + 1) / listings.length) * 55));
    await sleep(200);
  }

  return products;
}

// The PPR description is the clean product copy (the page's editor-copy block),
// but strip any element that mentions the store itself, plus scripts/styles.
function cleanDescription(html) {
  if (!html) return '';
  const $ = cheerio.load(html, null, false);
  $('script, style, iframe').remove();
  $('p, li, h1, h2, h3, h4, h5, h6, div, a').each((_, el) => {
    if (/road\s*store/i.test($(el).text())) $(el).remove();
  });
  $('ul, ol').each((_, el) => { if (!$(el).children().length) $(el).remove(); });
  return $.html().trim();
}

function pickPrice(pricing) {
  if (!pricing) return { price: 0, compareAtPrice: null };
  const rrp   = parseFloat(pricing.rrp) || 0;
  let   price = parseFloat(pricing.price) || 0;
  if (pricing.in_promo && parseFloat(pricing.promo_price) > 0) price = parseFloat(pricing.promo_price);
  return { price, compareAtPrice: rrp > price ? rrp : null };
}

function sizeFromChild(childName, parentName) {
  // Child names are "<parent name> - <size>"
  const suffix = childName.startsWith(parentName)
    ? childName.slice(parentName.length).replace(/^[\s-]+/, '').trim()
    : (childName.match(/ - ([^-]+)$/)?.[1] || '').trim();
  return suffix || 'Default';
}

function normaliseProduct(ppr, listing) {
  const title  = ppr.name || listing.title;
  const relUrl = ppr.url || listing.url || '';
  const slug   = (relUrl.split('/').filter(Boolean)[1] || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const children = ppr.options?.child_products || [];
  let variants;
  if (children.length) {
    variants = children.map(c => {
      const { price, compareAtPrice } = pickPrice(c.pricing);
      return {
        size:           sizeFromChild(c.name || '', title),
        sku:            c.sku || '',
        price,
        compareAtPrice,
        available:      !!c.instock,
        inventoryQty:   c.qty ?? (c.instock ? 1 : 0),
      };
    });
    // Keep the size order the store shows (specifics sortOrder), not child order
    const order = (ppr.options?.specifics?.[0]?.options || []).map(o => o.name);
    if (order.length) {
      variants.sort((a, b) => {
        const ai = order.indexOf(a.size), bi = order.indexOf(b.size);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
    }
  } else {
    const { price, compareAtPrice } = pickPrice(ppr.pricing);
    variants = [{
      size: 'Default', sku: ppr.sku || listing.sku, price, compareAtPrice,
      available: !!ppr.instock, inventoryQty: ppr.qty ?? (ppr.instock ? 1 : 0),
    }];
  }

  const seen   = new Set();
  const images = (ppr.media?.images || [])
    .map(img => img.full || img.thumb || '')
    .filter(src => {
      const key = src.split('?')[0];
      if (!src || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(src => src.startsWith('http') ? src : BASE + src);

  const prices = variants.map(v => v.price).filter(p => p > 0);

  return {
    sourceId:       ppr.sku || listing.sku,
    handle:         slug,
    title,
    description:    cleanDescription(ppr.description),
    vendor:         ppr.brand?.name || listing.brand || title.split(' ')[0],
    productType:    '',
    images:         images.length ? images : (listing.thumbUrl ? [listing.thumbUrl.replace('/assets/thumb/', '/assets/full/')] : []),
    variants,
    priceMin:       prices.length ? Math.min(...prices) : 0,
    priceMax:       prices.length ? Math.max(...prices) : 0,
    sourceUrl:      relUrl.startsWith('http') ? relUrl : BASE + relUrl,
    sourcePlatform: 'roadstore',
  };
}

function normaliseFromListing(item) {
  const slug = (item.url.split('/').filter(Boolean).slice(-2)[0] || item.title)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    sourceId:       item.sku,
    handle:         slug,
    title:          item.title,
    description:    '',
    vendor:         item.brand || item.title.split(' ')[0],
    productType:    '',
    images:         item.thumbUrl ? [item.thumbUrl.replace('/assets/thumb/', '/assets/full/')] : [],
    variants:       [{
      size: 'Default', sku: item.sku, price: item.price,
      compareAtPrice: item.msrp > item.price ? item.msrp : null,
      available: item.inStock, inventoryQty: item.inStock ? 1 : 0,
    }],
    priceMin:       item.price,
    priceMax:       item.price,
    sourceUrl:      item.url.startsWith('http') ? item.url : BASE + item.url,
    sourcePlatform: 'roadstore',
  };
}

// ── Single product (watchlist rescrape) ───────────────────────────────────────

export async function scrapeRoadstoreProduct(url) {
  // Product URLs are /p/<Slug>/<SKU> — the SKU is the last path segment
  const sku = new URL(url, BASE).pathname.split('/').filter(Boolean).pop();
  if (!sku) throw new Error('Could not extract SKU from Road Store URL');
  const ppr = await getJson(`${PPR_API}/${encodeURIComponent(sku)}/ppr`);
  return [normaliseProduct(ppr, { sku, title: ppr.name || sku, brand: '', url, price: 0, msrp: 0, inStock: !!ppr.instock, thumbUrl: '' })];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Brand discovery ───────────────────────────────────────────────────────────
// Uses the SearchSpring facet API — no browser required.

export async function discoverCompetitorBrands(baseUrl) {
  const data = await getJson(
    `${SS_API}?siteId=hmjh5r&resultsFormat=native&resultsPerPage=0`
  );
  const brandFacet = (data.facets || []).find(f => f.field === 'brand');
  const values     = brandFacet?.values || [];
  if (!values.length) throw new Error('No brand facet in SearchSpring response');

  const brands = values.map(v => {
    const name   = v.value || '';
    const handle = name.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return { name, handle };
  });

  console.log(`[Discovery Roadstore] Found ${brands.length} brands via SearchSpring API`);
  return brands.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Subcategory discovery ─────────────────────────────────────────────────────
// AngularJS renders the #filter-brand_category list client-side — Puppeteer needed.
// The filterParam is the raw hash fragment (e.g. #/filter:brand_category:...).

export async function discoverCompetitorSubcategories(baseUrl, vendorHandle) {
  const { existsSync } = await import('fs');
  const origin = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`).origin;
  const url    = `${origin}/brand/${vendorHandle}/`;

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA && (process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  let executablePath = null;
  for (const p of chromePaths) { if (existsSync(p)) { executablePath = p; break; } }
  if (!executablePath) { console.log('[Discovery Roadstore] Chrome not found'); return []; }

  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(2000); // let AngularJS render the facets

    const extract = () => page.evaluate(() => {
      // Exclude filtered-link (AngularJS history) and filtered-current (active span)
      const links = document.querySelectorAll(
        '#filter-brand_category li:not(.filtered-link):not(.filtered-current) a'
      );
      const seen = new Set();
      return Array.from(links).map(a => {
        const hash  = '#' + a.href.split('#').slice(1).join('#');
        const label = a.getAttribute('title') || a.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
        if (!hash.includes('filter:brand_category:')) return null;
        if (seen.has(hash)) return null;
        seen.add(hash);
        return { label, filterParam: hash };
      }).filter(Boolean);
    });

    let subcategories = await extract();
    if (subcategories.length === 0) {
      await sleep(3500);
      subcategories = await extract();
    }

    console.log(`[Discovery Roadstore] ${subcategories.length} subcategories for ${vendorHandle}`);
    return subcategories;
  } catch (e) {
    console.log(`[Discovery Roadstore] Puppeteer failed: ${e.message.slice(0, 80)}`);
    return [];
  } finally {
    await browser.close().catch(() => {});
  }
}
