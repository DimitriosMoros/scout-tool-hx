/**
 * Shared utilities: tag generation, type inference, price extraction, HTML cleaning
 */

const TYPE_MAP = [
  { type: 'Road Helmet',       patterns: [/\bhelmet\b/i, /\blid\b/i] },
  { type: 'MX Helmet',         patterns: [/\bmx\b/i, /\bmotocross\b/i, /\boffroad helmet\b/i] },
  { type: 'Leather Jacket',    patterns: [/leather jacket/i] },
  { type: 'Textile Jacket',    patterns: [/\bjacket\b/i, /\bcoat\b/i] },
  { type: 'Leather Gloves',    patterns: [/leather glove/i, /leather mitt/i] },
  { type: 'Riding Gloves',     patterns: [/\bglove/i, /\bmitt\b/i] },
  { type: 'Riding Boots',      patterns: [/\bboot/i] },
  { type: 'Riding Pants',      patterns: [/\bpant/i, /\btrouser/i, /\bjean/i, /\bchap/i] },
  { type: 'Body Armour',       patterns: [/\barmou?r\b/i, /\bprotector\b/i, /\back protector\b/i, /\bchest protector\b/i] },
  { type: 'Rain Gear',         patterns: [/\brain\b/i, /waterproof suit/i, /wet weather/i] },
  { type: 'Base Layer',        patterns: [/base layer/i, /\bthermal\b/i, /underlayer/i] },
  { type: 'Neck Brace',        patterns: [/neck brace/i, /neck support/i] },
  { type: 'Visor',             patterns: [/\bvisor\b/i, /\bshield\b/i, /\blens\b/i] },
  { type: 'Ear Plugs',         patterns: [/ear plug/i] },
  { type: 'Luggage',           patterns: [/\bbag\b/i, /\bluggage\b/i, /\bpannier/i, /\btank bag\b/i, /\btail pack\b/i] },
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
  { tag: 'Feature_Pinlock',        re: /pinlock/i },
  { tag: 'Feature_Bluetooth',      re: /bluetooth|bt\b/i },
  { tag: 'Feature_Quick-Release',  re: /quick.?release|EQRS|emergency/i },
  { tag: 'Feature_Airbag',         re: /airbag|air.?bag/i },
  { tag: 'Feature_D3O',            re: /\bD3O\b/i },
  { tag: 'Feature_MIPS',           re: /\bMIPS\b/i },
  { tag: 'Feature_Waterproof',     re: /waterproof|water.?resistant|gore.?tex/i },
  { tag: 'Feature_Ventilated',     re: /ventilat|aero|airflow|vented/i },
  { tag: 'Feature_Removable-Liner',re: /removable.?liner|washable.?liner/i },
  { tag: 'Feature_Double-D-Ring',  re: /double.?d.?ring/i },
];

const COLOUR_PATTERNS = [
  'Black', 'White', 'Red', 'Blue', 'Grey', 'Silver', 'Yellow',
  'Orange', 'Green', 'Pink', 'Gold', 'Matte Black', 'Matt Black',
  'Carbon', 'Fluo Yellow', 'Fluo Orange',
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
  const desc = product.description || '';
  const combined = `${title} ${desc}`.toLowerCase();

  // Simple brand + type tags (matches your Shopify format)
  if (brand) {
    // "Shoei" brand tag
    tags.add(brand);
    
    // Detect helmet type
    if (/helmet/i.test(combined)) {
      tags.add(`${brand} Helmet`);
      
      // More specific helmet types
      if (/road|street|sport/i.test(combined)) {
        tags.add(`${brand} Road Helmet`);
      } else if (/mx|motocross|off.?road/i.test(combined)) {
        tags.add(`${brand} MX Helmet`);
      }
    }
    
    // Jackets
    if (/jacket/i.test(combined)) {
      tags.add(`${brand} Jacket`);
    }
    
    // Gloves
    if (/glove/i.test(combined)) {
      tags.add(`${brand} Gloves`);
    }
    
    // Boots
    if (/boot/i.test(combined)) {
      tags.add(`${brand} Boots`);
    }
  }

  // Product type inference (for filtering)
  const type = inferProductType(title, desc);
  if (type && type !== 'Accessories') {
    tags.add(type);
  }

  // Simple status tag (if needed for filtering)
  // Uncomment if you want this:
  // tags.add('alphasale');

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