/**
 * Gap Analysis
 * Compares competitor products against the host's Shopify catalogue.
 *
 * Matching priority:
 *  1. SKU match          — exact, most reliable
 *  2. SKU prefix match   — one SKU starts with the other (handles "PRN002406" vs "PRN002406-002408-52")
 *  3. Barcode match      — exact
 *  4. Handle match       — URL slug, exact normalised
 *  5. Exact title match  — normalised, exact
 *  6. Soft title match   — 75%+ significant-word overlap + model numbers must agree
 *                          Prevents "Monster 821" matching "Monster 950" while catching
 *                          phrasing differences like "Lever Set To Suit Ducati 1260" vs
 *                          "Ducati 1260 Folding Levers".
 */

// Words that carry no product identity — excluded from the soft-match word set.
const SOFT_STOP = new Set([
  'the','a','an','to','and','or','for','in','with','of','by','at','on',
  'suit','fits','compatible','inc','including','set','pair','via','per',
  'new','genuine','oem','aftermarket','replacement','universal',
]);

// Pre-process a title into the sets needed for soft matching.
function titleTokens(str) {
  const n    = normalise(str);
  const nums = new Set((n.match(/\d{3,}/g) || [])); // 3+ digit numbers (model numbers, years)
  const words = new Set(n.split(' ').filter(w => w.length > 2 && !SOFT_STOP.has(w)));
  return { nums, words };
}

// Returns true when two titles plausibly refer to the same product.
// Rules:
//  - Both titles must contribute at least 3 significant words
//  - Any 3+-digit numbers appearing in the shorter title must ALL appear in the longer
//    (prevents "1260" matching "1290", "821" matching "950")
//  - ≥75% of the shorter title's significant words must appear in the longer title
function softTitleMatch(cpTitle, hostTokensList) {
  const cp = titleTokens(cpTitle);
  if (cp.words.size < 3) return false;

  for (const ht of hostTokensList) {
    if (ht.words.size < 3) continue;

    // Number constraint — model numbers must agree
    if (cp.nums.size > 0 && ht.nums.size > 0) {
      const smaller = cp.nums.size <= ht.nums.size ? cp.nums : ht.nums;
      const larger  = cp.nums.size <= ht.nums.size ? ht.nums : cp.nums;
      if (![...smaller].every(n => larger.has(n))) continue;
    }

    // Word overlap — use the shorter title as reference
    const shorter = cp.words.size <= ht.words.size ? cp.words : ht.words;
    const longer  = cp.words.size <= ht.words.size ? ht.words : cp.words;
    const overlap = [...shorter].filter(w => longer.has(w)).length;
    if (overlap / shorter.size >= 0.75) return true;
  }

  return false;
}

export function gapAnalysis(competitorProducts, hostProducts, brands = []) {
  // Build fast lookup sets from host products
  const hostHandles   = new Set(hostProducts.map(p => normalise(p.handle)));
  const hostTitles    = new Set(hostProducts.map(p => normalise(p.title)));
  const hostSkuList   = hostProducts.flatMap(p =>
    (p.variants || []).map(v => (v.sku || '').toLowerCase().trim()).filter(Boolean)
  );
  const hostSkus      = new Set(hostSkuList);
  const hostBarcodes  = new Set(
    hostProducts.flatMap(p => (p.variants || []).map(v => (v.barcode || '').toLowerCase().trim()).filter(Boolean))
  );
  // Pre-compute token sets for soft title matching (done once, reused per competitor product)
  const hostTokensList = hostProducts.map(p => titleTokens(p.title));

  const missing = [];
  const matched = [];

  for (const cp of competitorProducts) {
    const handle     = normalise(cp.handle);
    const title      = normalise(cp.title);
    const cpSkus     = (cp.variants || []).map(v => (v.sku || '').toLowerCase().trim()).filter(Boolean);
    const cpBarcodes = (cp.variants || []).map(v => (v.barcode || '').toLowerCase().trim()).filter(Boolean);

    // Normalise competitor vendor through alias map before comparison
    const normVendor = cp.vendor ? (VENDOR_ALIASES[cp.vendor.toLowerCase().trim()] || cp.vendor) : cp.vendor;

    const matchedBySku       = cpSkus.some(s => s && hostSkus.has(s));
    // SKU prefix: "PRN002406" matches "PRN002406-002408-52" and vice versa
    const matchedBySkuPrefix = !matchedBySku && cpSkus.some(cs =>
      cs && hostSkuList.some(hs => hs && (hs.startsWith(cs) || cs.startsWith(hs)))
    );
    const matchedByBarcode   = cpBarcodes.some(b => b && hostBarcodes.has(b));
    const matchedByHandle    = handle && hostHandles.has(handle);
    const matchedByTitle     = title  && hostTitles.has(title);
    const matchedBySoftTitle = !matchedByTitle && !matchedByHandle && !matchedBySku && !matchedBySkuPrefix && !matchedByBarcode
                               && softTitleMatch(cp.title, hostTokensList);

    if (matchedBySku || matchedBySkuPrefix || matchedByBarcode || matchedByHandle || matchedByTitle || matchedBySoftTitle) {
      matched.push({
        ...cp,
        matchReason: matchedBySku        ? 'sku'
                   : matchedBySkuPrefix  ? 'sku-prefix'
                   : matchedByBarcode    ? 'barcode'
                   : matchedByHandle     ? 'handle'
                   : matchedByTitle      ? 'title'
                   : 'title-soft',
      });
    } else {
      // Brand filter — only include if product belongs to a watched brand
      if (brands.length > 0) {
        const cpVendor = (normVendor || cp.vendor || '').toLowerCase();
        const cpTitle  = (cp.title  || '').toLowerCase();
        const brandMatch = brands.some(b => {
          const bl = b.toLowerCase();
          // Bidirectional prefix check so "Evotech Performance" (brand) matches competitor
          // vendor "Evotech", and "Evotech" (brand) matches competitor vendor "Evotech Performance"
          return cpVendor.includes(bl) || bl.includes(cpVendor) ||
                 cpTitle.startsWith(bl) || cpTitle.startsWith(cpVendor);
        });
        if (!brandMatch) continue;
      }
      missing.push(cp);
    }
  }

  // Summary per brand — case-insensitive deduplication
  const vendorMap = {};
  for (const p of competitorProducts) {
    const v = (p.vendor || '').trim();
    if (!v) continue;
    const aliased = VENDOR_ALIASES[v.toLowerCase()] || v;
    const key = aliased.toLowerCase();
    if (!vendorMap[key]) vendorMap[key] = aliased;
  }
  for (const b of (brands || [])) {
    const key = normaliseVendor(b);
    if (!vendorMap[key]) vendorMap[key] = VENDOR_ALIASES[b.toLowerCase()] || b;
  }

  const summary = {};
  for (const [bLower, canonical] of Object.entries(vendorMap)) {
    summary[canonical] = {
      total:   competitorProducts.filter(p => (VENDOR_ALIASES[(p.vendor||'').toLowerCase()]||p.vendor||'').toLowerCase() === bLower).length,
      missing: missing.filter(p => (VENDOR_ALIASES[(p.vendor||'').toLowerCase()]||p.vendor||'').toLowerCase() === bLower).length,
      matched: matched.filter(p => (VENDOR_ALIASES[(p.vendor||'').toLowerCase()]||p.vendor||'').toLowerCase() === bLower).length,
    };
  }

  const variantGaps = [];

  return { missing, matched, summary, variantGaps };
}

function findMissingSizes(competitorProduct, hostProduct) {
  if (!hostProduct) return [];

  const cpVariants   = competitorProduct.variants || [];
  const hostVariants = hostProduct.variants || [];

  if (!cpVariants.length || !hostVariants.length) return [];

  const hostSizes = new Set(
    hostVariants
      .map(v => normalise(v.option1 || v.size || v.title || ''))
      .filter(s => s && s !== 'default title' && s !== 'default')
  );

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[VariantGap] "${competitorProduct.title}"`);
    console.log(`  Host sizes:       ${[...hostSizes].join(', ') || '(none)'}`);
    console.log(`  Competitor sizes: ${cpVariants.map(v => normalise(v.option1||v.size||'')).join(', ')}`);
  }

  const hostSkus = new Set(
    hostVariants.map(v => (v.sku || '').toLowerCase().trim()).filter(Boolean)
  );

  const missing = cpVariants.filter(v => {
    const size = normalise(v.option1 || v.size || v.title || '');
    const sku  = (v.sku || '').toLowerCase().trim();
    if (!size || size === 'default' || size === 'default title') return false;
    if (size && hostSizes.has(size)) return false;
    if (sku  && hostSkus.has(sku))   return false;
    return true;
  });

  return missing.map(v => ({
    size:      v.option1 || v.size || v.title || '',
    sku:       v.sku     || '',
    price:     v.price   || 0,
    available: v.available !== false,
  }));
}

// Vendor aliases — maps competitor vendor names to your Shopify vendor names
// Add more entries here as you discover mismatches
const VENDOR_ALIASES = {
  'quad':      'quadlock',
  'quad lock': 'quadlock',
};

function normaliseVendor(vendor) {
  const v = (vendor || '').toLowerCase().trim();
  return VENDOR_ALIASES[v] || v;
}

function normalise(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}