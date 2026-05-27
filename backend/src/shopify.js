/**
 * Shopify Admin REST API wrapper
 * - Read host store products (paginated)
 * - Create draft products from competitor data
 * - Auto-refreshes OAuth2 access token before expiry
 */

const API_VERSION = '2025-01';

// ── Token management — auto-refreshes on every server start ──────────────────
let _tokenCache = {
  token:     process.env.SHOPIFY_ACCESS_TOKEN || '',
  expiresAt: 0,
};

async function fetchFreshToken(shop) {
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const params = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'client_credentials',
  });

  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Token refresh ${r.status}: ${txt.slice(0, 200)}`);
  }

  const data = await r.json();
  return {
    token:     data.access_token,
    expiresAt: Date.now() + (data.expires_in || 86400) * 1000,
  };
}

async function getToken(shop) {
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return _tokenCache.token || process.env.SHOPIFY_ACCESS_TOKEN;
  }

  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 5 * 60 * 1000) {
    return _tokenCache.token;
  }

  console.log('[Shopify] Fetching fresh access token…');
  try {
    const result = await fetchFreshToken(shop);
    if (result) {
      _tokenCache = result;
      const expiresIn = Math.round((result.expiresAt - Date.now()) / 3600000);
      console.log(`[Shopify] ✓ Token ready — expires in ~${expiresIn}h`);
      return _tokenCache.token;
    }
  } catch (e) {
    console.error('[Shopify] Token fetch error:', e.message);
    console.error('[Shopify] Falling back to SHOPIFY_ACCESS_TOKEN from .env');
  }

  return process.env.SHOPIFY_ACCESS_TOKEN || _tokenCache.token;
}

export async function initToken(shop) {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  if (!clientId) {
    console.log('[Shopify] No CLIENT_ID — using static SHOPIFY_ACCESS_TOKEN');
    return;
  }
  console.log('[Shopify] Fetching access token on startup…');
  try {
    const result = await fetchFreshToken(shop);
    if (result) {
      _tokenCache = result;
      const expiresIn = Math.round((result.expiresAt - Date.now()) / 3600000);
      console.log(`[Shopify] ✓ Access token ready — expires in ~${expiresIn}h`);

      const refreshIn = result.expiresAt - Date.now() - 5 * 60 * 1000;
      if (refreshIn > 0) {
        setTimeout(() => {
          console.log('[Shopify] Scheduled token refresh firing…');
          initToken(shop);
        }, refreshIn);
        console.log(`[Shopify] Next refresh scheduled in ${Math.round(refreshIn / 3600000)}h`);
      }
    }
  } catch (e) {
    console.error('[Shopify] Startup token fetch failed:', e.message);
    console.error('[Shopify] Will use SHOPIFY_ACCESS_TOKEN from .env as fallback');
  }
}

async function shopifyRequest(shop, token, method, path, body = null) {
  const activeToken = await getToken(shop) || token;
  const url  = `https://${shop}/admin/api/${API_VERSION}/${path}`;
  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': activeToken,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  if (!r.ok) {
    const err = await r.text();
    console.error('Shopify API URL was:', url);
    console.error('Response:', r.status, err.slice(0, 300));
    throw new Error(`Shopify ${r.status}: ${err.slice(0, 200)}`);
  }
  return r.json();
}

export { getToken };

// ── Read host products via GraphQL ───────────────────────────────────────────
export async function getShopifyProducts(shop, token, { vendor, vendors } = {}) {
  const vendorList = vendors?.filter(Boolean).length ? vendors.filter(Boolean)
    : vendor ? [vendor]
    : [null];

  const allProducts = [];

  for (const v of vendorList) {
    const query_filter = v ? `vendor:'${v}'` : '';
    let cursor = null;
    let hasNext = true;
    let page = 0;
    const MAX_PAGES = 20;

    console.log(`[Shopify] Fetching products${v ? ` for vendor="${v}"` : ' (all vendors)'} via GraphQL`);

    while (hasNext && page < MAX_PAGES) {
      const gql = `{
        products(first: 250, ${query_filter ? `query: "${query_filter}",` : ''} ${cursor ? `after: "${cursor}",` : ''} ) {
          nodes {
            id
            title
            handle
            vendor
            productType
            tags
            variants(first: 100) {
              nodes {
                sku barcode price title
                selectedOptions { name value }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`;

      const activeToken = await getToken(shop) || token;
      const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': activeToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: gql }),
      });

      if (!r.ok) throw new Error(`Shopify GraphQL ${r.status}`);
      const data = await r.json();
      if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');

      const nodes = data?.data?.products?.nodes || [];
      allProducts.push(...nodes.map(normaliseGraphQLProduct));

      hasNext = data?.data?.products?.pageInfo?.hasNextPage || false;
      cursor  = data?.data?.products?.pageInfo?.endCursor   || null;
      page++;

      console.log(`  Page ${page}: ${nodes.length} products (${allProducts.length} total so far)`);
      if (!hasNext) break;
      await sleep(200);
    }

    if (page >= MAX_PAGES) {
      console.log(`  [!] Reached ${MAX_PAGES}-page cap for vendor="${v}" — using first ${allProducts.length} products`);
    }
  }

  console.log(`[Shopify] Total host products loaded: ${allProducts.length}`);
  return allProducts;
}

function normaliseGraphQLProduct(p) {
  return {
    id:          p.id?.replace('gid://shopify/Product/', '') || '',
    handle:      p.handle      || '',
    title:       p.title       || '',
    vendor:      p.vendor      || '',
    productType: p.productType || '',
    tags:        Array.isArray(p.tags) ? p.tags.join(', ') : (p.tags || ''),
    variants: (p.variants?.nodes || []).map(v => {
      const sizeOpt = v.selectedOptions?.find(o => /size|sizing/i.test(o.name)) || v.selectedOptions?.[0];
      return {
        sku:     v.sku     || '',
        barcode: v.barcode || '',
        price:   v.price   || '0',
        option1: sizeOpt?.value || v.title || '',
      };
    }),
  };
}

// ── Create draft products ─────────────────────────────────────────────────────
export async function createDraftProducts(shop, token, products) {
  const results = { created: [], failed: [] };

  for (const product of products) {
    try {
      const payload = buildShopifyPayload(product);
      console.log(`[Active] Creating: "${product.title}" — ${payload.variants.length} variant(s), vendor: "${payload.vendor}"`);
      const data = await shopifyRequest(shop, token, 'POST', 'products.json', { product: payload });
      const productId = data.product.id;
      console.log(`[Active] ✓ Created: "${data.product.title}" (id: ${productId})`);

      await publishToAllChannels(shop, token, productId);

      results.created.push({
        id:       productId,
        title:    data.product.title,
        handle:   data.product.handle,
        adminUrl: `https://${shop}/admin/products/${productId}`,
      });
      await sleep(600);
    } catch (err) {
      console.error(`[Draft] ✗ Failed: "${product.title}" — ${err.message}`);
      results.failed.push({ title: product.title, error: err.message });
    }
  }

  return results;
}

// ── Publish product to all sales channels ────────────────────────────────────
async function publishToAllChannels(shop, token, productId) {
  try {
    const activeToken = await getToken(shop) || token;
    const productGid  = `gid://shopify/Product/${productId}`;

    const chanData = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': activeToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ publications(first: 20) { edges { node { id name } } } }' }),
    }).then(r => r.json());

    const publications = chanData?.data?.publications?.edges?.map(e => e.node) || [];
    if (!publications.length) return;

    const mutation = `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`;

    let successCount = 0;
    for (const pub of publications) {
      try {
        const r = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': activeToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: mutation, variables: { id: productGid, input: [{ publicationId: pub.id }] } }),
        });
        const res    = await r.json();
        const errors = res?.data?.publishablePublish?.userErrors || [];
        if (errors.length) {
          console.log(`  [Channels] ⚠ ${pub.name}: ${errors[0].message}`);
        } else {
          console.log(`  [Channels] ✓ ${pub.name}`);
          successCount++;
        }
      } catch(e) {
        console.log(`  [Channels] ⚠ ${pub.name}: ${e.message.slice(0, 40)}`);
      }
      await sleep(100);
    }
    console.log(`  [Channels] ${successCount}/${publications.length} channels activated`);
  } catch(e) {
    console.log(`  [Channels] Error: ${e.message.slice(0, 60)}`);
  }
}

// ── Clean description — strips ALL URLs and competitor references ─────────────
function cleanDescription(html) {
  if (!html) return '';
  let c = html;

  // Remove entire AMX boilerplate sections
  c = c.replace(/(<h[1-6][^>]*>\s*)?Shop\s+Now\s+at\s+AMX[\s\S]*/gi, '');
  c = c.replace(/(<h[1-6][^>]*>\s*)?About\s+AMX[\s\S]*/gi, '');
  c = c.replace(/<(?:p|div)[^>]*>[\s\S]*?(?:amx\s+never\s+fails|shop\s+now\s+at\s+amx|amx\s+delivers|free\s+shipping\s+on\s+orders)[\s\S]*?<\/(?:p|div)>/gi, '');

  // Strip ALL anchor tags — keep link text, remove the tag
  c = c.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // Strip ALL URLs — http/https and bare www. links
  c = c.replace(/https?:\/\/[^\s"<)'\]]+/gi, '');
  c = c.replace(/www\.[a-zA-Z0-9][^\s"<)'\]]+/gi, '');

  // Strip iframes
  c = c.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  // Strip MCAS SKU list paragraphs: (HE0310EDAD-p , HE0310EDADL...)
  c = c.replace(/<p[^>]*>\s*\([A-Z0-9\s,\-p\.]+\)\s*<\/p>/gi, '');

  // Strip image disclaimers
  c = c.replace(/<p[^>]*>[^<]*please note[^<]*images shown[^<]*<\/p>/gi, '');
  c = c.replace(/<p[^>]*>[^<]*images shown[^<]*display use only[^<]*<\/p>/gi, '');

  // Clean up empty tags
  c = c
    .replace(/<p[^>]*>\s*<\/p>/gi, '')
    .replace(/<h[1-6]>\s*<\/h[1-6]>/gi, '')
    .trim();

  return c;
}

// ── Build Shopify product payload ─────────────────────────────────────────────
function buildShopifyPayload(product) {
  const images = (product.images || [])
    .filter(src => src && typeof src === 'string' && src.startsWith('http'))
    .slice(0, 20)
    .map(src => ({ src }));

  const rawVariants = product.variants || [];

  // ── Deduplicate SKUs across variants ─────────────────────────────────────
  // If a SKU appears on more than one variant it means the scraper couldn't
  // uniquely identify that variant (e.g. click didn't update the SKU).
  // Blank out duplicates so they don't get uploaded with the wrong SKU.
  const seenSkus = new Set();

  const seen = new Set();
  const variants = rawVariants
    .map(v => {
      const size  = (v.option1 || v.size || '').toString().trim();
      const price = parseFloat(v.price || 0);

      // Deduplicate SKUs — blank if already seen
      const rawSku = (v.sku || '').trim();
      let sku = rawSku;
      if (sku && seenSkus.has(sku)) {
        sku = ''; // duplicate — this variant didn't get its own unique SKU
      } else if (sku) {
        seenSkus.add(sku);
      }

      const variant = {
        price:                price > 0 ? price.toFixed(2) : '0.00',
        inventory_management: 'shopify',  // track inventory in Shopify
        inventory_policy:     'deny',     // stop selling when out of stock
      };

      if (size && size !== 'Default Title') variant.option1 = size;
      if (sku)                              variant.sku     = sku;
      if (v.barcode && String(v.barcode).trim()) variant.barcode = String(v.barcode).trim();
      if (v.compareAtPrice) variant.compare_at_price = parseFloat(v.compareAtPrice).toFixed(2);

      return variant;
    })
    .filter(v => {
      // Deduplicate by option1
      const key = v.option1 || '__default__';
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const hasSizes = variants.some(v => v.option1);

  if (!hasSizes) {
    // No real sizes — single default variant, no option1
    const first = variants[0] || {};
    const defaultVariant = {
      price:                first.price || '0.00',
      inventory_management: 'shopify',
      inventory_policy:     'deny',
    };
    if (first.sku)     defaultVariant.sku     = first.sku;
    if (first.barcode) defaultVariant.barcode = first.barcode;
    variants.length = 0;
    variants.push(defaultVariant);
  }

  const opt1Values = hasSizes
    ? [...new Set(variants.map(v => v.option1).filter(Boolean))]
    : [];
  const options = opt1Values.length > 0
    ? [{ name: 'Size', values: opt1Values }]
    : [];

  const tags = [...new Set(
    (product.tags || '').split(',').map(t => t.trim()).filter(Boolean)
  )].join(', ');

  return {
    title:           String(product.title || 'Untitled').trim(),
    body_html:       cleanDescription(product.description || ''),
    vendor:          String(product.vendor || '').trim(),
    product_type:    String(product.productType || '').trim(),
    tags,
    status:          'active',
    published_scope: 'global',
    images,
    variants,
    ...(options.length ? { options } : {}),
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }