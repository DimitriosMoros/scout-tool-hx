/**
 * Van Demon Performance scraper (vandemonperformance.com.au)
 * Shopify store — uses public /collections/{handle}/products.json API.
 * No Puppeteer required.
 */

const BASE = 'https://vandemonperformance.com.au';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'en-AU,en-US;q=0.9',
};

// Motorcycle make collections — handle "aprilla" is their actual Shopify slug (typo on their site)
const MAKE_BRANDS = [
  { name: 'Aprilia',   handle: 'aprilla'   },
  { name: 'BMW',       handle: 'bmw'       },
  { name: 'Can-Am',    handle: 'can-am'    },
  { name: 'CFMOTO',    handle: 'cfmoto'    },
  { name: 'Ducati',    handle: 'ducati'    },
  { name: 'Honda',     handle: 'honda'     },
  { name: 'Husqvarna', handle: 'husqvarna' },
  { name: 'Italjet',   handle: 'italjet'   },
  { name: 'Kawasaki',  handle: 'kawasaki'  },
  { name: 'KTM',       handle: 'ktm'       },
  { name: 'MV Agusta', handle: 'mv-agusta' },
  { name: 'Suzuki',    handle: 'suzuki'    },
  { name: 'Triumph',   handle: 'triumph'   },
  { name: 'Yamaha',    handle: 'yamaha'    },
  { name: 'ZXMOTO',    handle: 'zxmoto'   },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

// ── Discovery ──────────────────────────────────────────────────────────────────

export async function discoverCompetitorBrands(baseUrl) {
  return MAKE_BRANDS;
}

export async function discoverCompetitorSubcategories(baseUrl, vendorHandle) {
  // Van Demon collections are flat per motorcycle make — no cross-brand subcategory filtering
  return [];
}

// ── Normalise Shopify product → internal format ────────────────────────────────

const VENDOR = 'Vandemon';

function normalizeProduct(p) {
  const variants = (p.variants || []).map(v => ({
    size:         v.title === 'Default Title' ? 'Default' : v.title,
    sku:          v.sku || '',
    price:        parseFloat(v.price) || 0,
    comparePrice: parseFloat(v.compare_at_price) || 0,
    available:    v.available !== false,
    inventoryQty: v.available ? 1 : 0,
  }));

  const prices   = variants.map(v => v.price).filter(x => x > 0);
  const priceMin = prices.length ? Math.min(...prices) : 0;
  const priceMax = prices.length ? Math.max(...prices) : 0;

  // Normalise to "Vandemon - {rest}" — strip any leading "Vandemon" or "Vandemon - " the site may already include
  const rawTitle  = (p.title || '').trim();
  const stripped  = rawTitle.replace(/^vandemon\s*[-–]?\s*/i, '').trim();
  const title     = `Vandemon - ${stripped}`;

  return {
    sourceId:       p.handle,
    handle:         p.handle,
    title,
    description:    p.body_html || '',
    vendor:         VENDOR,
    productType:    p.product_type || '',
    images:         (p.images || []).map(img => img.src).filter(Boolean),
    variants,
    priceMin,
    priceMax,
    sourceUrl:      `${BASE}/products/${p.handle}`,
    sourcePlatform: 'vandemon',
  };
}

// ── Main scraper ───────────────────────────────────────────────────────────────

export async function scrapeVandemon(baseUrl, brands = [], onProgress = () => {}, jobId = null, options = {}) {
  const maxProducts = options.maxProducts || 20;
  const skipIds     = options.skipIds || new Set();

  // Extract collection handle from URL — e.g. /collections/honda → honda
  const pathname = new URL(baseUrl).pathname;
  const parts    = pathname.split('/').filter(Boolean);
  const colIdx   = parts.indexOf('collections');
  const handle   = colIdx >= 0 && parts[colIdx + 1] ? parts[colIdx + 1] : 'all';

  const startedAt = new Date().toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'medium' });
  const startTime = Date.now();

  console.log('\n' + '━'.repeat(57));
  console.log(`  Van Demon Performance scraper — ${startedAt}`);
  console.log(`  Collection  : /collections/${handle}`);
  console.log(`  Max products: ${maxProducts}`);
  console.log('━'.repeat(57));

  onProgress(`Fetching Van Demon /collections/${handle}...`, 8);

  const allProducts = [];
  let page = 1;

  while (allProducts.length < maxProducts) {
    const url = `${BASE}/collections/${handle}/products.json?limit=250&page=${page}`;
    let data;
    try {
      data = await getJson(url);
    } catch (e) {
      console.warn(`[VanDemon] Page ${page} error: ${e.message}`);
      break;
    }

    const batch = data.products || [];
    if (!batch.length) break;

    for (const p of batch) {
      if (allProducts.length >= maxProducts) break;
      if (skipIds.has(p.handle)) continue;
      allProducts.push(p);
    }

    const pct = Math.min(10 + Math.round((allProducts.length / maxProducts) * 60), 70);
    onProgress(`Fetched ${allProducts.length} products...`, pct);

    if (batch.length < 250) break;
    page++;
    await sleep(300);
  }

  console.log(`[VanDemon] ${allProducts.length} raw products collected`);
  onProgress(`Normalizing ${allProducts.length} products...`, 80);

  const products      = allProducts.map(normalizeProduct);
  const totalVariants = products.reduce((s, p) => s + (p.variants?.length || 0), 0);
  const elapsed       = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`  Done in ${elapsed}s — ${products.length} products, ${totalVariants} variants`);
  console.log('━'.repeat(57) + '\n');

  onProgress(`Found ${products.length} Van Demon products`, 95);
  return products;
}
