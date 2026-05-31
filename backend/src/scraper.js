/**
 * FREE TIER MODE: premium proxies disabled to save credits (1000/month limit)
 * Universal Competitor Scraper
 * Platforms: Shopify, Magento, WooCommerce, generic HTML
 * Routes blocked requests through ScraperAPI with premium residential proxies
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { inferProductType, generateTags } from './utils.js';
import { scrapeAMX }  from './amxScraper.js';
import { scrapeMCAS }       from './mcasScraper.js';
import { scrapeMotoheaven } from './motoheavenScraper.js';
import { scrapeBikebiz }    from './bikebizScraper.js';

const CONCURRENCY = 3;
const lim = pLimit(CONCURRENCY);

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control':   'no-cache',
  'Pragma':          'no-cache',
};

// ── ScraperAPI with premium settings ──────────────────────────────────────────

function scraperApiUrl(targetUrl, { render = false, premium = false } = {}) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return null;
  const params = new URLSearchParams({
    api_key:       key,
    url:           targetUrl,
    country_code:  'au',  // Re-enabled - user has paid plan
    device_type:   'desktop',
  });
  if (render)  params.set('render', 'true');
  if (premium) params.set('premium', 'true');  // residential IPs — harder to block
  return `https://api.scraperapi.com?${params}`;
}

async function smartGet(url, { acceptJson = false, render = false, premium = false, timeout = 25000 } = {}) {
  const headers = { ...BROWSER_HEADERS };
  if (acceptJson) headers['Accept'] = 'application/json, text/plain, */*';

  // Try direct first (free, fast)
  try {
    const r = await axios.get(url, { headers, timeout, validateStatus: s => true });
    if (r.status === 200) return r;
    if (![403, 407, 429, 503, 401].includes(r.status)) return r;
    console.log(`  ${url} → ${r.status} (direct blocked)`);
  } catch (e) {
    console.log(`  ${url} → direct failed: ${e.message.slice(0,50)}`);
  }

  // ScraperAPI fallback with premium residential proxies for stubborn sites
  const proxyUrl = scraperApiUrl(url, { render, premium });
  if (!proxyUrl) {
    console.log('  ⚠ No SCRAPERAPI_KEY — cannot bypass blocking');
    return null;
  }

  try {
    const r = await axios.get(proxyUrl, { headers, timeout: timeout + 30000, validateStatus: s => true });
    if (r.status === 200) {
      console.log(`  ✓ ScraperAPI succeeded (render=${render}, premium=${premium})`);
      return r;
    }
    
    // If still blocked — escalate to JS render + premium
    if (!render || !premium) {
      console.log(`  ${r.status} via proxy — retrying with render=true (JS execution)`);
      const r2 = await axios.get(scraperApiUrl(url, { render: true, premium: false }), {
        headers, timeout: timeout + 40000, validateStatus: s => true
      });
      if (r2.status === 200) console.log(`  ✓ Premium residential proxy worked`);
      return r2;
    }
    return r;
  } catch (e) {
    console.log(`  ScraperAPI error: ${e.message.slice(0,60)}`);
    return null;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function scrapeCompetitor(url, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const hasKey = !!process.env.SCRAPERAPI_KEY;

  onProgress(`Connecting to ${url}…`, 5);

  // AMX-specific scraper (heavily blocked Shopify store)
  // Don't normalize the URL - keep exact path for specific collections
  if (url.includes('amxsuperstores.com.au')) {
    console.log('[scraper] AMX detected — using dedicated scraper');
    onProgress('AMX detected - using optimized scraper...', 8);
    const products = await scrapeAMX(url, brands, onProgress, jobId, options);    
    if (!products.length) {
      throw new Error('No AMX products found. Check brand filters or ScraperAPI credits.');
    }

    onProgress(`Tagging ${products.length} AMX products…`, 90);
    return products.map(p => ({
      ...p,
      tags: generateTags(p, p.vendor || guessBrand(p.title, brands)),
      productType: p.productType || inferProductType(p.title, p.description || ''),
    }));
  }

  // MCAS — dedicated scraper
  if (url.includes('mcas.com.au')) {
    console.log('[scraper] MCAS detected — using dedicated scraper');
    onProgress('MCAS detected - using dedicated scraper...', 8);
    const products = await scrapeMCAS(url, brands, onProgress, jobId, options);
    if (!products.length) throw new Error('No MCAS products found. Check URL and brand filters.');
    return products.map(p => ({
      ...p,
      tags: generateTags(p, p.vendor || guessBrand(p.title, brands)),
      productType: p.productType || inferProductType(p.title, p.description || ''),
    }));
  }

  // Detect Motoheaven
  if (url.includes('motoheaven.com.au')) {
    console.log('[scraper] Motoheaven detected — using dedicated scraper');
    onProgress('Motoheaven detected - using dedicated scraper...', 8);
    const products = await scrapeMotoheaven(url, brands, onProgress, jobId, options);
    if (!products.length) throw new Error('No Motoheaven products found. Check URL and brand filters.');
    return products.map(p => ({
      ...p,
      tags: generateTags(p, p.vendor || guessBrand(p.title, brands)),
      productType: p.productType || inferProductType(p.title, p.description || ''),
    }));
  }

  // Detect Bikebiz
  if (url.includes('bikebiz.com.au')) {
    console.log('[scraper] Bikebiz detected — using dedicated scraper');
    onProgress('Bikebiz detected - using dedicated scraper...', 8);
    const products = await scrapeBikebiz(url, brands, onProgress, jobId, options);
    if (!products.length) throw new Error('No Bikebiz products found. Check URL and brand filters.');
    return products.map(p => ({
      ...p,
      tags: generateTags(p, p.vendor || guessBrand(p.title, brands)),
      productType: p.productType || inferProductType(p.title, p.description || ''),
    }));
  }

  // For non-AMX, non-MCAS sites, normalize to base domain
  const baseUrl = normaliseUrl(url);
  onProgress(`Platform: ${platform}`, 12);
  console.log(`[scraper] ${baseUrl} → ${platform}`);

  let products = [];

  switch (platform) {
    case 'shopify-api':
      products = await scrapeShopifyAPI(baseUrl, brands, onProgress);
      break;

    case 'shopify-blocked':
      products = await scrapeShopifyAPIviaProxy(baseUrl, brands, onProgress);
      if (!products.length) {
        onProgress('API blocked — crawling collection pages…', 30);
        products = await scrapeShopifyHTML(baseUrl, brands, onProgress);
      }
      break;

    case 'magento':
      products = await scrapeMagento(baseUrl, brands, onProgress);
      break;

    case 'woocommerce':
      products = await scrapeWooCommerce(baseUrl, brands, onProgress);
      break;

    default:
      products = await scrapeGenericSite(baseUrl, brands, onProgress);
  }

  if (!products.length) {
    const tip = hasKey
      ? 'No products found matching the brand filters. Try removing brand filters or check the site URL.'
      : 'Add SCRAPERAPI_KEY to .env to bypass site blocking.';
    throw new Error(`No products found at ${baseUrl}. ${tip}`);
  }

  onProgress(`Tagging ${products.length} products…`, 90);

  return products.map(p => ({
    ...p,
    tags:        generateTags(p, p.vendor || guessBrand(p.title, brands)),
    productType: p.productType || inferProductType(p.title, p.description || ''),
  }));
}

// ── Platform detection ────────────────────────────────────────────────────────

async function detectPlatform(baseUrl, onProgress) {
  onProgress('Detecting platform…', 8);

  // Try Shopify products.json
  try {
    const r = await axios.get(`${baseUrl}/products.json?limit=1`, {
      headers: BROWSER_HEADERS, timeout: 10000, validateStatus: s => true
    });
    if (r.status === 200 && r.data?.products) return 'shopify-api';
    if ([403, 401, 429, 503].includes(r.status)) {
      // Could be blocked Shopify — verify via proxy
      const r2 = await smartGet(`${baseUrl}/products.json?limit=1`, { acceptJson: true, premium: false, timeout: 20000 });
      if (r2?.status === 200 && r2?.data?.products) return 'shopify-api';
    }
  } catch (_) {}

  // Fetch homepage via premium proxy to fingerprint
  const home = await smartGet(baseUrl, { premium: false, render: false, timeout: 20000 });
  if (home?.status === 200) {
    const body = home.data || '';
    if (body.includes('cdn.shopify.com') || body.includes('Shopify.theme') || body.includes('myshopify.com')) {
      console.log('  Detected Shopify from homepage HTML');
      return 'shopify-blocked';
    }
    if (body.includes('Mage.Cookies') || body.includes('Magento') || body.includes('/catalog/product/') || body.includes('mage/')) {
      return 'magento';
    }
    if (body.includes('woocommerce') || body.includes('wp-content') || body.includes('add-to-cart')) {
      return 'woocommerce';
    }
    return 'generic';
  }

  console.log('  Platform detection inconclusive — defaulting to generic');
  return 'generic';
}

// ── Shopify: direct API ───────────────────────────────────────────────────────

async function scrapeShopifyAPI(baseUrl, brands, onProgress) {
  const all = [];
  for (const brand of (brands.length ? brands : [null])) {
    let page = 1;
    onProgress(`Fetching ${brand || 'all'} from Shopify API…`, 18);
    while (true) {
      const params = new URLSearchParams({ limit: '250', page: String(page) });
      if (brand) params.set('vendor', brand);
      try {
        const r = await axios.get(`${baseUrl}/products.json?${params}`, { headers: BROWSER_HEADERS, timeout: 25000 });
        const batch = r.data?.products || [];
        if (!batch.length) break;
        all.push(...batch.map(normaliseShopifyProduct));
        onProgress(`  ${all.length} products…`, Math.min(18 + page * 4, 44));
        if (batch.length < 250) break;
        page++;
        await sleep(400);
      } catch (_) { break; }
    }
  }
  return all;
}

// ── Shopify: via proxy ────────────────────────────────────────────────────────

async function scrapeShopifyAPIviaProxy(baseUrl, brands, onProgress) {
  const all = [];
  for (const brand of (brands.length ? brands : [null])) {
    let page = 1;
    onProgress(`Fetching ${brand || 'all'} via ScraperAPI…`, 18);
    while (true) {
      const params = new URLSearchParams({ limit: '250', page: String(page) });
      if (brand) params.set('vendor', brand);
      const r = await smartGet(`${baseUrl}/products.json?${params}`, { acceptJson: true, premium: false });
      if (!r || r.status !== 200) break;
      let batch = [];
      try { batch = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data)?.products || []; }
      catch (_) { break; }
      if (!batch.length) break;
      all.push(...batch.map(normaliseShopifyProduct));
      onProgress(`  ${all.length} products…`, Math.min(18 + page * 4, 44));
      if (batch.length < 250) break;
      page++;
      await sleep(800);
    }
  }
  return all;
}

// ── Shopify: HTML crawl ───────────────────────────────────────────────────────

async function scrapeShopifyHTML(baseUrl, brands, onProgress) {
  const handles = new Set();

  for (const brand of (brands.length ? brands : [null])) {
    const slug = brand ? brand.toLowerCase().replace(/\s+/g, '-') : null;
    const urls = [
      slug ? `${baseUrl}/collections/${slug}` : null,
      slug ? `${baseUrl}/collections/all?filter.p.vendor=${encodeURIComponent(brand)}` : null,
      `${baseUrl}/collections/all`,
    ].filter(Boolean);

    for (const collUrl of urls) {
      for (let page = 1; page <= 30; page++) {
        const url = page > 1 ? `${collUrl}${collUrl.includes('?') ? '&' : '?'}page=${page}` : collUrl;
        const r   = await smartGet(url, { render: true, timeout: 60000 });  // Force JS + 60s timeout
        if (!r || r.status !== 200) {
          console.log(`  Collection page failed: ${url} → status ${r?.status || 'timeout'}`);
          break;
        }
        const $   = cheerio.load(r.data);
        let found = 0;
        
        // Debug: log total links found
        const totalLinks = $('a[href]').length;
        console.log(`  Page ${page}: ${totalLinks} total links found in HTML`);
        
        $('a[href]').each((_, el) => {
          const m = ($(el).attr('href') || '').match(/\/products\/([a-zA-Z0-9][a-zA-Z0-9\-]+)/);
          if (!m) return;
          const handle = m[1].toLowerCase();
          if (slug && !handle.includes(slug)) {
            const text = $(el).text().toLowerCase();
            if (brand && !text.includes(brand.toLowerCase())) return;
          }
          if (!handles.has(handle)) { handles.add(handle); found++; }
        });
        
        console.log(`  → Extracted ${found} new product handles (${handles.size} total)`);
        onProgress(`  ${handles.size} handles…`, Math.min(25 + Math.floor(handles.size / 5), 40));
        if (!found) break;
        await sleep(700);
      }
    }
  }

  if (!handles.size) return [];
  onProgress(`Fetching ${handles.size} product details…`, 42);

  const products = [];
  let done = 0;
  await Promise.all([...handles].map(handle => lim(async () => {
    const r = await smartGet(`${baseUrl}/products/${handle}.json`, { acceptJson: true, premium: false });
    if (r?.status === 200 && r.data?.product) products.push(normaliseShopifyProduct(r.data.product));
    if (++done % 10 === 0) onProgress(`  Fetched ${done}/${handles.size}…`, Math.min(42 + Math.floor(done / handles.size * 42), 84));
  })));

  const bl = brands.map(b => b.toLowerCase());
  return bl.length ? products.filter(p => bl.some(b =>
    (p.vendor || '').toLowerCase().includes(b) || (p.title || '').toLowerCase().startsWith(b)
  )) : products;
}

// ── Magento ───────────────────────────────────────────────────────────────────

async function scrapeMagento(baseUrl, brands, onProgress) {
  const productUrls = new Set();

  for (const brand of (brands.length ? brands : [null])) {
    const slug = brand ? brand.toLowerCase() : null;

    const seedUrls = [
      slug ? `${baseUrl}/brands/${slug}.html` : null,
      slug ? `${baseUrl}/brand/${slug}.html` : null,
      slug ? `${baseUrl}/catalogsearch/result/?q=${encodeURIComponent(brand)}` : null,
      `${baseUrl}/sitemap.xml`,
    ].filter(Boolean);

    for (const seedUrl of seedUrls) {
      onProgress(`Scanning ${seedUrl}…`, 15);

      if (seedUrl.includes('sitemap')) {
        const urls = await trySitemap(baseUrl, brands);
        urls.forEach(u => productUrls.add(u));
        if (productUrls.size) continue;
      }

      // Paginate through brand pages with JS rendering + premium proxies
      for (let page = 1; page <= 20; page++) {
        const url = page > 1 ? `${seedUrl}${seedUrl.includes('?') ? '&' : '?'}p=${page}` : seedUrl;
        const r   = await smartGet(url, { render: true, premium: false });  // FORCE render for Magento
        if (!r || r.status !== 200) break;

        const $   = cheerio.load(r.data);
        let found = 0;

        $('a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          const full = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
          if (isMagentoProductUrl(full, new URL(baseUrl).hostname)) {
            if (!productUrls.has(full)) { productUrls.add(full); found++; }
          }
        });

        onProgress(`  Found ${productUrls.size} products…`, Math.min(20 + Math.floor(productUrls.size / 10), 40));

        const hasNext = $('a.next, a[title="Next"], .pages-item-next a, a[rel="next"]').length > 0;
        if (!found || !hasNext) break;
        await sleep(1000);
      }

      if (productUrls.size > 0) break;
    }
  }

  if (!productUrls.size) return [];

  onProgress(`Scraping ${productUrls.size} Magento product pages…`, 42);
  const products = [];
  let done = 0;

  await Promise.all([...productUrls].slice(0, 300).map(url => lim(async () => {
    const p = await scrapeProductPage(url, brands, true);  // render=true for Magento
    if (p) products.push(p);
    if (++done % 10 === 0) onProgress(`  Scraped ${done}/${productUrls.size}…`, Math.min(42 + Math.floor(done / productUrls.size * 42), 84));
  })));

  return products;
}

function isMagentoProductUrl(url, domain) {
  if (!url.includes(domain)) return false;
  try { if (new URL(url).searchParams.size > 3) return false; } catch (_) {}
  return (url.endsWith('.html') && !/(category|brand|collection|search|cart|checkout|account|blog|cms)/i.test(url)) ||
         /\/p\/\d+/.test(url) || /\/product\//.test(url);
}

// ── WooCommerce ───────────────────────────────────────────────────────────────

async function scrapeWooCommerce(baseUrl, brands, onProgress) {
  const productUrls = new Set();

  for (const brand of (brands.length ? brands : [null])) {
    const slug = brand ? brand.toLowerCase().replace(/\s+/g, '-') : null;
    const urls = [
      slug ? `${baseUrl}/product-category/${slug}` : null,
      slug ? `${baseUrl}/product-tag/${slug}` : null,
      slug ? `${baseUrl}/?s=${encodeURIComponent(brand)}&post_type=product` : null,
      `${baseUrl}/shop`,
    ].filter(Boolean);

    for (const collUrl of urls) {
      for (let page = 1; page <= 20; page++) {
        const url = page > 1 ? `${collUrl}/page/${page}` : collUrl;
        const r   = await smartGet(url, { render: true });  // Force JS rendering for Shopify
        if (!r || r.status !== 200) break;
        const $   = cheerio.load(r.data);
        let found = 0;
        $('a.woocommerce-loop-product__link, .product a[href*="/product/"], .products a[href]').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (href.includes('/product/') && !productUrls.has(href)) { productUrls.add(href); found++; }
        });
        onProgress(`  ${productUrls.size} products…`, Math.min(20 + Math.floor(productUrls.size / 5), 40));
        if (!found) break;
        await sleep(600);
      }
    }
  }

  if (!productUrls.size) return [];

  onProgress(`Scraping ${productUrls.size} product pages…`, 42);
  const products = [];
  let done = 0;
  await Promise.all([...productUrls].slice(0, 300).map(url => lim(async () => {
    const p = await scrapeProductPage(url, brands, false);
    if (p) products.push(p);
    if (++done % 10 === 0) onProgress(`  Scraped ${done}/${productUrls.size}…`, Math.min(42 + Math.floor(done / productUrls.size * 42), 84));
  })));

  return products;
}

// ── Generic site ──────────────────────────────────────────────────────────────

async function scrapeGenericSite(baseUrl, brands, onProgress) {
  onProgress('Scanning sitemap…', 14);
  let urls = await trySitemap(baseUrl, brands);

  if (!urls.length) {
    onProgress('Crawling category pages…', 20);
    urls = await crawlForProductUrls(baseUrl, brands);
  }

  if (!urls.length) return [];

  onProgress(`Scraping ${urls.length} pages…`, 30);
  const products = [];
  let done = 0;
  await Promise.all(urls.slice(0, 400).map(url => lim(async () => {
    const p = await scrapeProductPage(url, brands, false);
    if (p) products.push(p);
    if (++done % 10 === 0) onProgress(`  ${done}/${urls.length}…`, 30 + Math.floor(done / urls.length * 54));
  })));
  return products;
}

async function trySitemap(baseUrl, brands) {
  const urls = [];
  const bl   = brands.map(b => b.toLowerCase());

  for (const sUrl of [`${baseUrl}/sitemap.xml`, `${baseUrl}/sitemap_index.xml`]) {
    const r = await smartGet(sUrl);
    if (!r || r.status !== 200) continue;
    const $ = cheerio.load(r.data, { xmlMode: true });

    for (const sub of $('sitemap loc').map((_, el) => $(el).text()).get().filter(u => /product/i.test(u))) {
      const r2 = await smartGet(sub);
      if (!r2 || r2.status !== 200) continue;
      cheerio.load(r2.data, { xmlMode: true })('url loc').each((_, el) => {
        const u = cheerio.load(r2.data, { xmlMode: true })(el).text();
        if (isProductUrl(u) && matchesBrands(u, bl)) urls.push(u);
      });
    }

    $('url loc').each((_, el) => {
      const u = $(el).text();
      if (isProductUrl(u) && matchesBrands(u, bl)) urls.push(u);
    });

    if (urls.length) break;
  }
  return urls;
}

async function crawlForProductUrls(baseUrl, brands) {
  const found = new Set();
  const domain = new URL(baseUrl).hostname;
  const bl = brands.map(b => b.toLowerCase());

  const r = await smartGet(baseUrl, { premium: false });
  if (!r || r.status !== 200) return [];
  const $ = cheerio.load(r.data);
  const seeds = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().toLowerCase();
    const full = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
    if (!full.includes(domain)) return;
    if (/\/(collection|category|brand|products|shop|gear|helmet|jacket|glove|boot)/i.test(href)) {
      if (!bl.length || bl.some(b => text.includes(b) || href.toLowerCase().includes(b))) seeds.add(full);
    }
  });

  for (const seed of [...seeds].slice(0, 15)) {
    const r2 = await smartGet(seed);
    if (!r2 || r2.status !== 200) continue;
    cheerio.load(r2.data)('a[href]').each((_, el) => {
      const href = cheerio.load(r2.data)(el).attr('href') || '';
      const full = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
      if (isProductUrl(full, domain) && matchesBrands(full, bl)) found.add(full);
    });
    await sleep(500);
  }
  return [...found];
}

// ── Product page scraper ──────────────────────────────────────────────────────

async function scrapeProductPage(url, brands, magento = false) {
  const r = await smartGet(url, { render: magento, premium: false });  // Magento needs render
  if (!r || r.status !== 200) return null;
  const $ = cheerio.load(r.data);

  // JSON-LD structured data
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(script).html() || '{}');
      const p    = Array.isArray(data) ? data.find(d => d['@type'] === 'Product') :
                   data['@type'] === 'Product' ? data : null;
      if (p) return normaliseLdProduct(p, url, brands);
    } catch (_) {}
  }

  // Open Graph fallback
  const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!title) return null;
  const image = $('meta[property="og:image"]').attr('content') || '';
  const price = $('meta[property="product:price:amount"]').attr('content') ||
                $('[itemprop="price"]').attr('content') || '';
  const brand = brands.find(b => title.toLowerCase().includes(b.toLowerCase())) || '';

  return {
    sourceId: url, handle: urlToHandle(url), title,
    description: $('meta[property="og:description"]').attr('content') || '',
    vendor: brand, productType: '', tags: '',
    images: image ? [image] : [],
    variants: price ? [{ price, sku: '', option1: 'Default Title' }] : [],
    priceMin: parseFloat(price) || 0, priceMax: parseFloat(price) || 0,
    sourceUrl: url, sourcePlatform: 'generic',
  };
}

// ── Normalisers ───────────────────────────────────────────────────────────────

function normaliseShopifyProduct(p) {
  const variants = p.variants || [];
  const prices   = variants.map(v => parseFloat(v.price) || 0).filter(x => x > 0);
  return {
    sourceId: String(p.id), handle: p.handle || '', title: p.title || '',
    description: p.body_html || '', vendor: p.vendor || '',
    productType: p.product_type || '',
    tags: Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
    images: (p.images || []).map(i => i.src).filter(Boolean),
    variants: variants.map(v => ({
      id: String(v.id), sku: v.sku || '', barcode: v.barcode || '',
      price: v.price || '0', compareAtPrice: v.compare_at_price || null,
      weight: v.weight || 0, weightUnit: v.weight_unit || 'kg',
      inventoryQty: v.inventory_quantity ?? 0,
      option1: v.option1 || 'Default Title', option2: v.option2 || null, option3: v.option3 || null,
    })),
    options: (p.options || []).map(o => ({ name: o.name, values: o.values })),
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    sourceUrl: null, sourcePlatform: 'shopify',
  };
}

function normaliseLdProduct(ld, url, brands) {
  const offers = Array.isArray(ld.offers) ? ld.offers : [ld.offers].filter(Boolean);
  const prices = offers.map(o => parseFloat(o.price) || 0).filter(x => x > 0);
  const images = [];
  if (ld.image) (Array.isArray(ld.image) ? ld.image : [ld.image])
    .forEach(img => images.push(typeof img === 'string' ? img : (img.url || '')));
  return {
    sourceId: ld.productID || ld.sku || url, handle: urlToHandle(url),
    title: ld.name || '', description: ld.description || '',
    vendor: ld.brand?.name || brands.find(b => (ld.name||'').toLowerCase().includes(b.toLowerCase())) || '',
    productType: ld.category || '', tags: '', images: images.filter(Boolean),
    variants: offers.map((o, i) => ({
      price: String(o.price || 0), sku: ld.sku || o.sku || '',
      option1: o.name || (i === 0 ? 'Default Title' : `Option ${i+1}`),
    })),
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    sourceUrl: url, sourcePlatform: 'generic',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normaliseUrl(url) {
  url = url.trim();
  if (!url.startsWith('http')) url = `https://${url}`;
  try {
    // Strip to origin — remove paths, query params
    return new URL(url).origin;
  } catch (_) {
    return url.replace(/\/$/, '');
  }
}

function urlToHandle(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[parts.length - 1].replace('.html', '') || 'product';
  } catch (_) { return url.replace(/[^a-z0-9]+/gi, '-').toLowerCase(); }
}

function isProductUrl(url, domain) {
  if (domain && !url.includes(domain)) return false;
  return /\/products?\/[a-z0-9][a-z0-9\-]+/i.test(url) ||
         /\/(item|p|pd)\//.test(url) ||
         (url.endsWith('.html') && !/\/(category|brand|tag|search|blog|page)/i.test(url));
}

function matchesBrands(url, bl) {
  if (!bl.length) return true;
  return bl.some(b => url.toLowerCase().includes(b));
}

function guessBrand(title, brands) {
  if (!title || !brands?.length) return '';
  return brands.find(b => title.toLowerCase().startsWith(b.toLowerCase())) || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }