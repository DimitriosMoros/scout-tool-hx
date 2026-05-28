/**
 * Gap Analysis
 * Compares competitor products against the host's Shopify catalogue.
 *
 * Matching priority:
 *  1. SKU match          — most reliable
 *  2. Barcode match      — reliable
 *  3. Handle match       — reliable (URL slug)
 *  4. Exact title match  — normalised but exact, NO fuzzy
 *
 * Fuzzy title matching has been intentionally removed.
 * Helmet/apparel names are too similar (same brand, model, series)
 * for fuzzy matching to work — it causes false "Already stocked" results.
 */

export function gapAnalysis(competitorProducts, hostProducts, brands = []) {
  // Build fast lookup sets from host products
  const hostHandles  = new Set(hostProducts.map(p => normalise(p.handle)));
  const hostTitles   = new Set(hostProducts.map(p => normalise(p.title)));
  const hostSkus     = new Set(
    hostProducts.flatMap(p => (p.variants || []).map(v => (v.sku || '').toLowerCase().trim()).filter(Boolean))
  );
  const hostBarcodes = new Set(
    hostProducts.flatMap(p => (p.variants || []).map(v => (v.barcode || '').toLowerCase().trim()).filter(Boolean))
  );

  const missing = [];
  const matched = [];

  for (const cp of competitorProducts) {
    const handle     = normalise(cp.handle);
    const title      = normalise(cp.title);
    const cpSkus     = (cp.variants || []).map(v => (v.sku || '').toLowerCase().trim()).filter(Boolean);
    const cpBarcodes = (cp.variants || []).map(v => (v.barcode || '').toLowerCase().trim()).filter(Boolean);

    const matchedBySku     = cpSkus.some(s => s && hostSkus.has(s));
    const matchedByBarcode = cpBarcodes.some(b => b && hostBarcodes.has(b));
    const matchedByHandle  = handle && hostHandles.has(handle);
    const matchedByTitle   = title  && hostTitles.has(title);   // exact match only, no fuzzy

    if (matchedBySku || matchedByBarcode || matchedByHandle || matchedByTitle) {
      matched.push({
        ...cp,
        matchReason: matchedBySku     ? 'sku'
                   : matchedByBarcode ? 'barcode'
                   : matchedByHandle  ? 'handle'
                   : 'title',
      });
    } else {
      // Brand filter — only include if product belongs to a watched brand
      if (brands.length > 0) {
        const cpVendor = (cp.vendor || '').toLowerCase();
        const cpTitle  = (cp.title  || '').toLowerCase();
        const brandMatch = brands.some(b =>
          cpVendor.includes(b.toLowerCase()) || cpTitle.startsWith(b.toLowerCase())
        );
        if (!brandMatch) continue;
      }
      missing.push(cp);
    }
  }

  // Summary per brand — case-insensitive deduplication
  // Normalise all vendor names to their "best" form (prefer title-case from scraped data)
  const vendorMap = {}; // lowercase → canonical form
  for (const p of competitorProducts) {
    const v = (p.vendor || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    // Prefer the scraped vendor name (e.g. "Shoei") over filter input (e.g. "shoei")
    if (!vendorMap[key]) vendorMap[key] = v;
  }
  // Add brands filter as fallback if not already in map
  for (const b of (brands || [])) {
    const key = b.toLowerCase();
    if (!vendorMap[key]) vendorMap[key] = b;
  }

  const summary = {};
  for (const [bLower, canonical] of Object.entries(vendorMap)) {
    summary[canonical] = {
      total:   competitorProducts.filter(p => (p.vendor || '').toLowerCase() === bLower).length,
      missing: missing.filter(p => (p.vendor || '').toLowerCase() === bLower).length,
      matched: matched.filter(p => (p.vendor || '').toLowerCase() === bLower).length,
    };
  }

  // Variant gap detection disabled until selectedOptions confirmed working
  // const variantGaps = matched.filter(p => p.hasVariantGap);
  const variantGaps = [];

  return { missing, matched, summary, variantGaps };
}

/**
 * Find sizes the competitor has that the host product doesn't stock.
 * Returns array of { size, sku, price, available } for missing sizes.
 */
function findMissingSizes(competitorProduct, hostProduct) {
  if (!hostProduct) return [];

  const cpVariants   = competitorProduct.variants || [];
  const hostVariants = hostProduct.variants || [];

  if (!cpVariants.length || !hostVariants.length) return [];

  // Build set of normalised size labels from host variants
  // Host variants from Shopify GraphQL have option1 (added in shopify.js normaliseGraphQLProduct)
  // Competitor variants have v.size (from scraper)
  const hostSizes = new Set(
    hostVariants
      .map(v => normalise(v.option1 || v.size || v.title || ''))
      .filter(s => s && s !== 'default title' && s !== 'default')
  );

  // DEBUG: log first product comparison
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[VariantGap] "${competitorProduct.title}"`);
    console.log(`  Host sizes:       ${[...hostSizes].join(', ') || '(none)'}`);
    console.log(`  Competitor sizes: ${cpVariants.map(v => normalise(v.option1||v.size||'')).join(', ')}`);
  }

  // Also build set of host SKUs for cross-reference
  const hostSkus = new Set(
    hostVariants.map(v => (v.sku || '').toLowerCase().trim()).filter(Boolean)
  );

  // Find competitor variants whose size isn't in host AND whose SKU isn't in host
  const missing = cpVariants.filter(v => {
    const size = normalise(v.option1 || v.size || v.title || '');
    const sku  = (v.sku || '').toLowerCase().trim();
    if (!size || size === 'default' || size === 'default title') return false;
    // Skip if host already has this size or SKU
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

/**
 * Normalise a string for comparison:
 * lowercase, trim, strip punctuation/special chars, collapse spaces.
 * "Shoei X-SPR Pro Helmet – Proxy TC-11" → "shoei xspr pro helmet proxy tc11"
 */
function normalise(str) {
  return (str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')   // strip punctuation, dashes, slashes
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}