/**
 * Shared utilities: tag generation, type inference, price extraction, HTML cleaning
 */

const TYPE_MAP = [
  { type: 'Road Helmet',      patterns: [/\bhelmet\b/i, /\blid\b/i] },
  { type: 'MX Helmet',        patterns: [/\bmx\b/i, /\bmotocross\b/i, /\boffroad helmet\b/i] },
  { type: 'Leather Jacket',   patterns: [/leather jacket/i] },
  { type: 'Textile Jacket',   patterns: [/\bjacket\b/i, /\bcoat\b/i] },
  { type: 'Riding Suit',      patterns: [/\bsuit\b/i, /\boverall\b/i, /\bcombi\b/i] },
  { type: 'Leather Gloves',   patterns: [/leather glove/i, /leather mitt/i] },
  { type: 'Riding Gloves',    patterns: [/\bglove/i, /\bmitt\b/i] },
  { type: 'Riding Boots',     patterns: [/\bboot/i] },
  { type: 'Riding Pants',     patterns: [/\bpant/i, /\btrouser/i, /\bjean/i, /\bchap/i] },
  { type: 'Crash Protection', patterns: [/crash protection/i, /crash guard/i, /frame slider/i, /engine guard/i, /\bslider\b/i, /\bbobbins?\b/i] },
  { type: 'Body Armour',      patterns: [/\barmou?r\b/i, /\bprotector\b/i, /\back protector\b/i, /\bchest protector\b/i] },
  { type: 'Rain Gear',        patterns: [/\brain gear\b/i, /waterproof suit/i, /wet weather/i, /\brain jacket\b/i, /\brain pant/i] },
  { type: 'Base Layer',       patterns: [/base layer/i, /\bthermal\b/i, /underlayer/i] },
  { type: 'Neck Brace',       patterns: [/neck brace/i, /neck support/i] },
  { type: 'Visor',            patterns: [/\bvisor\b/i, /\bshield\b/i, /\blens\b/i] },
  { type: 'Ear Plugs',        patterns: [/ear plug/i] },
  { type: 'Intercom',         patterns: [/\bintercom\b/i, /\bheadset\b/i, /\bcommunicat/i] },
  { type: 'Luggage',          patterns: [/\btank bag\b/i, /\btail pack\b/i, /\bpannier\b/i, /\bsaddle bag\b/i, /\bbungee\b/i] },
  { type: 'Paddock Stand',    patterns: [/paddock stand/i] },
  { type: 'Motorcycle Spool', patterns: [/\bspool\b/i, /\bbobbin\b/i] },
  { type: 'Chain Care',       patterns: [/chain lube/i, /chain wax/i, /chain clean/i, /chain spray/i, /chain oil/i] },
  { type: 'Tyre',             patterns: [/\btyre\b/i, /\btire\b/i] },
];

const CERT_PATTERNS = [
  { tag: 'Cert_ECE-22-06', re: /ECE[\s\-]?22\.?06/i },
  { tag: 'Cert_ECE-22-05', re: /ECE[\s\-]?22\.?05/i },
  { tag: 'Cert_FIM',       re: /\bFIM\b/ },
  { tag: 'Cert_DOT',       re: /\bDOT\b/ },
  { tag: 'Cert_SNELL',     re: /\bSNELL\b/i },
  { tag: 'Cert_AS-NZS',    re: /AS\/NZS/i },
  { tag: 'Cert_CE-L1',     re: /CE\s*Level\s*1|CE\s*[Ll]vl\s*1/i },
  { tag: 'Cert_CE-L2',     re: /CE\s*Level\s*2|CE\s*[Ll]vl\s*2/i },
];

const FEATURE_PATTERNS = [
  { tag: 'Feature_Pinlock',         re: /pinlock/i },
  { tag: 'Feature_Bluetooth',       re: /bluetooth|bt\b/i },
  { tag: 'Feature_Quick-Release',   re: /quick.?release|EQRS|emergency/i },
  { tag: 'Feature_Airbag',          re: /airbag|air.?bag/i },
  { tag: 'Feature_D3O',             re: /\bD3O\b/i },
  { tag: 'Feature_MIPS',            re: /\bMIPS\b/i },
  { tag: 'Feature_Waterproof',      re: /waterproof|water.?resistant|gore.?tex/i },
  { tag: 'Feature_Ventilated',      re: /ventilat|aero|airflow|vented/i },
  { tag: 'Feature_Removable-Liner', re: /removable.?liner|washable.?liner/i },
  { tag: 'Feature_Double-D-Ring',   re: /double.?d.?ring/i },
];

const COLOUR_PATTERNS = [
  'Black', 'White', 'Red', 'Blue', 'Grey', 'Silver', 'Yellow',
  'Orange', 'Green', 'Pink', 'Gold', 'Matte Black', 'Matt Black',
  'Carbon', 'Fluo Yellow', 'Fluo Orange',
];

const HELMET_STYLE_PATTERNS = [
  { tag: 'Style_Full-Face',   re: /full.?face/i },
  { tag: 'Style_Open-Face',   re: /open.?face|three.?quarter|3.?quarter/i },
  { tag: 'Style_Modular',     re: /modular|flip.?up|flip.?front/i },
  { tag: 'Style_Adventure',   re: /adventure|adv\b|dual.?sport/i },
  { tag: 'Style_Off-Road',    re: /off.?road|motocross|\bmx\b|enduro/i },
  { tag: 'Style_Half-Face',   re: /half.?face|half.?helmet/i },
];

// Common motorcycle makes — adds Make_Kawasaki style tags for fitment-specific products
export const MOTO_MAKES = [
  'Kawasaki', 'Honda', 'Yamaha', 'Suzuki', 'Ducati', 'BMW', 'KTM', 'Triumph',
  'Harley-Davidson', 'Royal Enfield', 'Aprilia', 'MV Agusta', 'Husqvarna',
  'Indian', 'Benelli', 'CFMoto',
];

const MATERIAL_PATTERNS = [
  { tag: 'Material_Leather',  re: /\bleather\b/i },
  { tag: 'Material_Textile',  re: /\btextile\b|\bfabric\b/i },
  { tag: 'Material_Mesh',     re: /\bmesh\b/i },
  { tag: 'Material_Gore-Tex', re: /gore.?tex/i },
  { tag: 'Material_Denim',    re: /\bdenim\b/i },
  { tag: 'Material_Kevlar',   re: /\bkevlar\b/i },
];

export function inferProductType(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  for (const { type, patterns } of TYPE_MAP) {
    if (patterns.some(re => re.test(combined))) return type;
  }
  return 'Accessories';
}

export function generateTags(product, brand) {
  const tags = new Set();
  const title = product.title || '';
  // Strip HTML before text analysis so description tags don't fire on markup
  const desc  = (product.description || '').replace(/<[^>]+>/g, ' ');
  const combined = `${title} ${desc}`;
  const productType = product.productType || inferProductType(title, desc);

  // ── Brand ──────────────────────────────────────────────────────────────────
  if (brand) {
    tags.add(brand);
    // For multi-word brands like "Evotech Performance", also add the short form "Evotech"
    // so Shopify collections filtering on the short name still match.
    const brandShort = brand.split(/\s+/)[0];
    if (brandShort !== brand) tags.add(brandShort);
  }

  // ── Product type ───────────────────────────────────────────────────────────
  if (productType && productType !== 'Accessories') tags.add(productType);

  // ── Brand + short-type combo (drives Shopify automated collections) ────────
  if (brand && productType && productType !== 'Accessories') {
    const typeShort = productType.split(' ').pop(); // "Road Helmet" → "Helmet"
    tags.add(`${brand} ${typeShort}`);
  }

  // ── Helmet style sub-type ──────────────────────────────────────────────────
  if (/helmet/i.test(combined)) {
    for (const { tag, re } of HELMET_STYLE_PATTERNS) {
      if (re.test(combined)) tags.add(tag);
    }
  }

  // ── Material (title-only to avoid false positives in long descriptions) ────
  for (const { tag, re } of MATERIAL_PATTERNS) {
    if (re.test(title)) tags.add(tag);
  }

  // ── Certifications ─────────────────────────────────────────────────────────
  for (const { tag, re } of CERT_PATTERNS) {
    if (re.test(combined)) tags.add(tag);
  }

  // ── Features ───────────────────────────────────────────────────────────────
  for (const { tag, re } of FEATURE_PATTERNS) {
    if (re.test(combined)) tags.add(tag);
  }

  // ── Colours ────────────────────────────────────────────────────────────────
  for (const colour of COLOUR_PATTERNS) {
    const re = new RegExp(`\\b${colour.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (re.test(combined)) tags.add(`Colour_${colour.replace(/\s+/g, '-')}`);
  }

  // ── SKU / part number ──────────────────────────────────────────────────────
  const sku = (product.variants?.[0]?.sku || product.sourceId || '').trim();
  if (sku && sku.length >= 3 && !/^\d+$/.test(sku) && !/^[a-z-]+$/.test(sku)) {
    tags.add(sku);
  }

  // ── MAKE_, MODEL_, YEAR_ ───────────────────────────────────────────────────
  // Words in the title that mark the end of the model name and start of product type.
  const MODEL_STOP_RE = /\b(crash|protection|frame|slider|guard|tail|bracket|kit|cover|tidy|paddock|stand|spool|bobbins?|ring|plug|bar|end|cap|mirror|bung|axle|lever|pad|disc|protector|armou?r|helmet|jacket|glove|boot|pant|visor|shield|accessory|accessories|fender|eliminator|hugger|radiator|fairing|cowl|clutch|brake|cable|filter|chain|sprocket|exhaust|muffler|rearset|peg|windscreen|screen|comfort|seat|saddle|mount|clamp|bolt|screw|engine|rear|front|upper|lower|left|right)\b/i;

  const escapedBrand = brand ? brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const titleNoBrand = brand
    ? title.replace(new RegExp(`\\b${escapedBrand}\\b`, 'gi'), ' ')
    : title;

  for (const make of MOTO_MAKES) {
    // Allow "Harley-Davidson" to also match "Harley Davidson" (hyphen ↔ space)
    const escapedMake = make.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[\\-\\s]');
    const makeRe = new RegExp(`\\b${escapedMake}\\b`, 'i');
    if (!makeRe.test(titleNoBrand)) continue;

    tags.add(`MAKE_${make}`);

    // Extract model name: words immediately after the make, stopping at product-type words
    const makeMatch = titleNoBrand.match(makeRe);
    const makeEnd   = titleNoBrand.indexOf(makeMatch[0]) + makeMatch[0].length;
    const afterMake = titleNoBrand.slice(makeEnd).trim();
    const stopIdx   = afterMake.search(MODEL_STOP_RE);
    // Years belong in YEAR_ tags, not the model name — including shorthand
    // forms like "'17 -'20": "MT-09 '17 -'20 Radiator Guard" → MODEL_MT-09,
    // "Street Triple 765 RS 2023 Paddock Stand..." → MODEL_Street Triple 765 RS
    const modelStr  = (stopIdx > 0 ? afterMake.slice(0, stopIdx) : afterMake)
      .replace(/\b(19|20)\d{2}\b/g, ' ')
      .replace(/['’]\d{2}\b/g, ' ')
      .replace(/['’]/g, ' ')
      .replace(/\s[-–\/]+(\s|$)/g, ' ')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (modelStr.length >= 2 && modelStr.length <= 40) tags.add(`MODEL_${modelStr}`);
  }

  // Alphanumeric model codes not already covered above (helmet models, accessory codes, etc.)
  for (const word of titleNoBrand.split(/\s+/)) {
    if (word.length >= 2 && /[A-Za-z]/.test(word) && /\d/.test(word)) {
      if (![...tags].some(t => t.startsWith('MODEL_') && t.includes(word))) {
        tags.add(`MODEL_${word}`);
      }
    }
  }

  // Year tags — expand ranges like "(2020 - 2025)" or shorthand "'17 -'20"
  // into individual YEAR_ tags. Ranges are checked across title + description;
  // single years in title only (to avoid false positives from generic text in
  // long descriptions).
  const yearRangeRe = /(?:\b(20\d{2})|['’](\d{2}))\s*(?:[-–\/]|to)\s*(?:(20\d{2})|['’](\d{2}))\b/gi;
  const singleYearRe = /(?:\b(20\d{2})|['’](\d{2}))\b/g;
  const yearSet = new Set();
  let ym;
  while ((ym = yearRangeRe.exec(combined)) !== null) {
    const start = ym[1] ? parseInt(ym[1]) : 2000 + parseInt(ym[2]);
    const end   = ym[3] ? parseInt(ym[3]) : 2000 + parseInt(ym[4]);
    if (end > start && end - start <= 20) {
      for (let y = start; y <= end; y++) yearSet.add(y);
    }
  }
  if (yearSet.size === 0) {
    while ((ym = singleYearRe.exec(title)) !== null) {
      const y = ym[1] ? parseInt(ym[1]) : 2000 + parseInt(ym[2]);
      if (y >= 2005 && y <= 2030) yearSet.add(y);
    }
  }
  for (const y of yearSet) tags.add(`YEAR_${y}`);

  return [...tags].join(', ');
}

export function cleanHtml(html = '') {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

export function extractPrice(text = '') {
  const m = text.replace(/,/g, '').match(/\d+(\.\d{1,2})?/);
  return m ? parseFloat(m[0]) : 0;
}
