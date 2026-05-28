/**
 * Bikebiz Scraper
 *
 * Bikebiz is a Next.js + BigCommerce headless store with Cloudflare protection.
 * The product data comes from: https://live-api.bikebiz.com.au/graphql/
 *
 * Strategy:
 *  1. Load the collection page with Puppeteer to get session/auth context
 *  2. Intercept the GraphQL request to live-api.bikebiz.com.au/graphql/
 *  3. Replay the same GraphQL query (with brand filter) to get products directly
 *  4. Extract product URLs and fetch each product page for full detail
 */

import puppeteer from 'puppeteer-core';
import { jobStore } from './jobStore.js';

const BASE     = 'https://www.bikebiz.com.au';
const LIVE_API = 'https://live-api.bikebiz.com.au/graphql/';

const MAX_PAGES_PER_COLLECTION = 5;
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
    try { const u = new URL(proxyUrl); if (u.username) await page.authenticate({ username: u.username, password: decodeURIComponent(u.password) }); } catch(_) {}
  }
  return page;
}

// ── Main entry point ──────────────────────────────────────────────────────────
export async function scrapeBikebiz(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const MAX_PRODUCTS = options.maxProducts || MAX_PRODUCTS_TO_SCRAPE;
  const MAX_PAGES    = options.maxPages    || MAX_PAGES_PER_COLLECTION;

  const startTime = Date.now();
  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });

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

    // ── Step 1: Load page and capture GraphQL request headers + query ─────────
    onProgress('Loading Bikebiz collection page...', 8);
    const capturedRequest = await captureGraphQLRequest(page, baseUrl);

    if (!capturedRequest) {
      throw new Error('Could not capture Bikebiz GraphQL request. The page may not have loaded correctly.');
    }
    console.log(`[Bikebiz] ✓ Captured GraphQL request — headers ready`);

    // ── Step 2: Query GraphQL directly for products ───────────────────────────
    onProgress('Querying Bikebiz product catalogue...', 15);
    const productItems = await queryBikebizProducts(page, capturedRequest, brands, MAX_PRODUCTS, MAX_PAGES);

    if (!productItems.length) throw new Error('No products found. Check brand filters.');
    console.log(`[Bikebiz] Found ${productItems.length} products via GraphQL`);

    // ── Step 3: Fetch each product page for full details ──────────────────────
    onProgress(`Fetching ${productItems.length} product pages...`, 35);
    const products = await fetchProductPages(page, productItems, brands, onProgress, jobId, MAX_PRODUCTS);

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

// ── Capture GraphQL request from the collection page ─────────────────────────
async function captureGraphQLRequest(page, collectionUrl) {
  let captured = null;

  await page.setRequestInterception(true);

  page.on('request', req => req.continue());
  page.on('response', async res => {
    if (captured) return;
    const url = res.url();
    if (!url.includes('live-api.bikebiz.com.au/graphql')) return;
    try {
      const req     = res.request();
      const headers = req.headers();
      const postData = req.postData() || '';
      // Only capture requests that look like product/category queries
      if (postData.includes('product') || postData.includes('category') || postData.includes('search')) {
        const body = JSON.parse(postData);
        captured = { headers, body, url };
        console.log(`[Bikebiz] Captured GraphQL: op="${body.operationName || 'unknown'}"`);
      }
    } catch(_) {}
  });

  try {
    await page.goto(collectionUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000); // wait for all API calls to fire
  } catch(_) {}

  // Remove listeners
  page.removeAllListeners('request');
  page.removeAllListeners('response');
  await page.setRequestInterception(false);

  return captured;
}

// ── Query Bikebiz GraphQL for products ────────────────────────────────────────
async function queryBikebizProducts(page, capturedReq, brands, maxProducts, maxPages) {
  const items = [];
  const brandFilter = brands[0] || '';

  // Build a search/category query for the brand
  // We'll use the captured headers (auth tokens) but craft our own query
  const searchQuery = `
    query SearchProducts($filter: SearchProductsFiltersInput, $sort: ProductSortInput, $pageSize: Int, $currentPage: Int) {
      products(filter: $filter, sort: $sort, pageSize: $pageSize, currentPage: $currentPage) {
        total_count
        items {
          id
          name
          sku
          url_key
          url_suffix
          price_range {
            minimum_price {
              regular_price { value currency }
              final_price { value currency }
            }
          }
          description { html }
          short_description { html }
          media_gallery { url label disabled }
          ... on SimpleProduct {
            stock_status
          }
          ... on ConfigurableProduct {
            configurable_options {
              label
              values { label value_index }
            }
            variants {
              attributes { label value_index code }
              product {
                sku
                stock_status
                price_range {
                  minimum_price {
                    regular_price { value }
                    final_price { value }
                  }
                }
              }
            }
          }
        }
        page_info { current_page page_size total_pages }
      }
    }
  `;

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    if (items.length >= maxProducts) break;

    const variables = {
      filter: brandFilter ? { manufacturer: { eq: brandFilter }, category_url_path: { match: 'helmet' } }
                          : { category_url_path: { match: 'helmet' } },
      sort:     { name: 'ASC' },
      pageSize: Math.min(maxProducts, 20),
      currentPage: pageNum,
    };

    try {
      // Use page.evaluate to make the fetch with captured headers
      const result = await page.evaluate(async (apiUrl, headers, query, vars) => {
        try {
          const r = await fetch(apiUrl, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: vars }),
          });
          if (!r.ok) return { error: `HTTP ${r.status}` };
          return await r.json();
        } catch(e) { return { error: e.message }; }
      }, LIVE_API, capturedReq.headers, searchQuery, variables);

      if (result?.error) {
        console.log(`[Bikebiz] GraphQL error page ${pageNum}: ${result.error}`);
        // Try alternate approach: replay the original captured query with brand filter
        const altResult = await replayOriginalQuery(page, capturedReq, brandFilter, pageNum);
        if (altResult?.length) { items.push(...altResult); continue; }
        break;
      }

      const pageItems = result?.data?.products?.items || [];
      console.log(`[Bikebiz] GraphQL page ${pageNum}: ${pageItems.length} products`);
      items.push(...pageItems);

      const pageInfo = result?.data?.products?.page_info;
      if (!pageInfo || pageNum >= pageInfo.total_pages) break;

    } catch(e) {
      console.log(`[Bikebiz] GraphQL query error: ${e.message.slice(0, 80)}`);
      break;
    }
  }

  return items;
}

// ── Replay the original captured query with brand filter ──────────────────────
async function replayOriginalQuery(page, capturedReq, brand, pageNum) {
  try {
    const body = JSON.parse(JSON.stringify(capturedReq.body)); // deep clone
    // Inject brand filter into variables if possible
    if (body.variables) {
      if (body.variables.filters) body.variables.filters.brand = [brand];
      if (body.variables.pageSize) body.variables.pageSize = 20;
      if (body.variables.currentPage !== undefined) body.variables.currentPage = pageNum;
    }

    const result = await page.evaluate(async (apiUrl, headers, bodyStr) => {
      try {
        const r = await fetch(apiUrl, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: bodyStr,
        });
        if (!r.ok) return { error: `HTTP ${r.status}` };
        return await r.json();
      } catch(e) { return { error: e.message }; }
    }, LIVE_API, capturedReq.headers, JSON.stringify(body));

    // Try to extract items from any shape of response
    const data = result?.data;
    if (!data) return [];
    const products = data.products?.items || data.categoryList?.[0]?.products?.items ||
                     data.category?.products?.items || data.search?.products?.items || [];
    return products.filter(p => !brand || (p.name || '').toLowerCase().includes(brand.toLowerCase()));
  } catch(_) { return []; }
}

// ── Fetch individual product pages ────────────────────────────────────────────
async function fetchProductPages(page, items, brands, onProgress, jobId, maxProducts) {
  const products = [];
  const toFetch  = items.slice(0, maxProducts);

  for (let i = 0; i < toFetch.length; i++) {
    if (jobId && jobStore.isCancelled(jobId)) { console.log(`[Bikebiz] Cancelled`); break; }

    const item = toFetch[i];
    const slug = item.url_key || item.sku || '';
    const url  = slug ? `${BASE}/${slug}${item.url_suffix || ''}` : '';
    const ts   = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    console.log(`  [${i+1}/${toFetch.length}] [${ts}] ${item.name || slug}`);

    try {
      const p = normaliseGraphQLProduct(item, url, brands);
      if (p) {
        products.push(p);
        console.log(`  [${i+1}/${toFetch.length}] ✓ ${p.title} (${p.variants.length} variants)`);
        onProgress(`[${i+1}/${toFetch.length}] ${p.title}`, 35 + Math.floor(((i+1)/toFetch.length)*55));
      }
    } catch(e) {
      console.log(`    ✗ Error: ${e.message.slice(0,60)}`);
    }
    await sleep(100);
  }
  return products;
}

// ── Normalise BigCommerce GraphQL product ─────────────────────────────────────
function normaliseGraphQLProduct(item, url, brands) {
  if (!item?.name) return null;

  const regularPrice = item.price_range?.minimum_price?.regular_price?.value || 0;
  const finalPrice   = item.price_range?.minimum_price?.final_price?.value   || 0;
  // Use regular price as listing price (compare_at), not sale price
  const listPrice    = regularPrice > finalPrice ? regularPrice : finalPrice;

  // Variants from configurable product
  let variants = [];
  if (item.variants?.length) {
    variants = item.variants.map(v => {
      const sizeAttr = v.attributes?.find(a => a.code === 'size' || a.code === 'clothing_size') || v.attributes?.[0];
      const varReg   = v.product?.price_range?.minimum_price?.regular_price?.value || listPrice;
      const varFinal = v.product?.price_range?.minimum_price?.final_price?.value   || listPrice;
      return {
        size:        sizeAttr?.label || 'Default',
        sku:         v.product?.sku  || item.sku || '',
        price:       varReg > varFinal ? varReg : varFinal,
        available:   v.product?.stock_status !== 'OUT_OF_STOCK',
        inventoryQty: v.product?.stock_status === 'OUT_OF_STOCK' ? 0 : 1,
      };
    });
  } else {
    variants = [{
      size:        'Default',
      sku:         item.sku || '',
      price:       listPrice,
      available:   item.stock_status !== 'OUT_OF_STOCK',
      inventoryQty: item.stock_status === 'OUT_OF_STOCK' ? 0 : 1,
    }];
  }

  const images = (item.media_gallery || [])
    .filter(m => !m.disabled && m.url)
    .map(m => m.url);

  const vendor = brands.find(b => (item.name || '').toLowerCase().includes(b.toLowerCase()))
    || item.name?.split(' ')[0] || '';

  const prices = variants.map(v => v.price).filter(p => p > 0);

  return {
    sourceId:     String(item.id || item.sku || url),
    handle:       item.url_key || url.split('/').pop() || 'unknown',
    title:        item.name,
    description:  item.description?.html || item.short_description?.html || '',
    vendor,
    productType:  'Road Helmet',
    images,
    variants,
    priceMin:     prices.length ? Math.min(...prices) : 0,
    priceMax:     prices.length ? Math.max(...prices) : 0,
    sourceUrl:    url || `${BASE}/${item.url_key}`,
    sourcePlatform: 'bikebiz',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }