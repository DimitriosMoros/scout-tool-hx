/**
 * Excel export — matches Evotech KTM_2026 template + Matrixify compatible
 *
 * Format rules:
 * - 30 columns (product + variant + sales channels)
 * - Single sheet "Sheet1"
 * - Header: Arial 11pt bold, fill #E2EFDA (light green)
 * - Data: Arial 11pt, no borders, no freeze panes, no autofilter
 * - ID column: always empty (Shopify assigns on import)
 * - Option1 Name: "Size" on first row of product (if product has sizes)
 * - Option1 Value: size label on each variant row
 * - Body HTML: first row only, stripped of ALL URLs and competitor references
 * - Image Src: one per row
 * - Variant columns: only on variant rows, never repeated on image-only rows
 */

import ExcelJS from 'exceljs';

const COLUMNS = [
  { key: 'ID',              header: 'ID',                                     width: 14 },
  { key: 'Handle',          header: 'Handle',                                 width: 42 },
  { key: 'Title',           header: 'Title',                                  width: 42 },
  { key: 'Body HTML',       header: 'Body HTML',                              width: 70 },
  { key: 'Vendor',          header: 'Vendor',                                 width: 18 },
  { key: 'Type',            header: 'Type',                                   width: 24 },
  { key: 'Tags',            header: 'Tags',                                   width: 55 },
  { key: 'Option1 Name',    header: 'Option1 Name',                           width: 16 },
  { key: 'Option1 Value',   header: 'Option1 Value',                          width: 16 },
  { key: 'Image Src',       header: 'Image Src',                              width: 55 },
  { key: 'Variant ID',      header: 'Variant ID',                             width: 16 },
  { key: 'Variant SKU',     header: 'Variant SKU',                            width: 20 },
  { key: 'Variant Barcode', header: 'Variant Barcode',                        width: 20 },
  { key: 'Variant Weight',  header: 'Variant Weight',                         width: 14 },
  { key: 'Variant Weight Unit', header: 'Variant Weight Unit',                width: 18 },
  { key: 'Variant Price',   header: 'Variant Price',                          width: 14 },
  { key: 'Variant Inventory Qty',     header: 'Variant Inventory Qty',        width: 20 },
  { key: 'Variant Inventory Tracker', header: 'Variant Inventory Tracker',    width: 24 },
  { key: 'Variant Inventory Policy',  header: 'Variant Inventory Policy',     width: 22 },
  { key: 'Inventory On Hand: Evotech Warehouse', header: 'Inventory On Hand: Evotech Warehouse', width: 32 },
  { key: 'Variant HS Code',           header: 'Variant HS Code',              width: 18 },
  { key: 'Variant Country of Origin', header: 'Variant Country of Origin',    width: 24 },
  { key: 'Template Suffix',           header: 'Template Suffix',              width: 16 },
  { key: 'Published',                 header: 'Published',                    width: 12 },
  { key: 'Online Store',              header: 'Online Store',                 width: 16 },
  { key: 'Point of Sale',             header: 'Point of Sale',                width: 16 },
  { key: 'Google & YouTube',          header: 'Google & YouTube',             width: 18 },
  { key: 'Facebook & Instagram',      header: 'Facebook & Instagram',         width: 22 },
  { key: 'Shop',                      header: 'Shop',                         width: 10 },
  { key: 'Inbox',                     header: 'Inbox',                        width: 10 },
];

// ── Competitor section patterns — strips entire boilerplate blocks ─────────────
const SECTION_PATTERNS = [
  /(<h[1-6][^>]*>)?Shop\s+Now\s+at\s+AMX[\s\S]*/gi,
  /(<h[1-6][^>]*>)?About\s+AMX[\s\S]*/gi,
  /<[^>]+>About\s+[A-Z][a-zA-Z]+<\/[^>]+>[\s\S]{0,2000}AMX[\s\S]*/gi,
  /<p[^>]*>[^<]*(?:amx|AMX|amxsuperstores)[^<]*<\/p>/gi,
  /<(?:p|div)[^>]*>[\s\S]*?(?:shop\s+now\s+at\s+amx|amx\s+never\s+fails|amx\s+delivers|stores\s+in\s+queensland[\s\S]*?amx)[\s\S]*?<\/(?:p|div)>/gi,
];

// ── Clean description — strips ALL URLs and competitor references ──────────────
function cleanDescription(html) {
  if (!html) return '';
  let c = html;

  // Strip entire AMX boilerplate sections first
  for (const pattern of SECTION_PATTERNS) {
    c = c.replace(pattern, '');
  }

  // Strip ALL anchor tags — keep link text, remove the tag and href
  c = c.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // Strip ALL URLs — http/https and bare www. links
  c = c.replace(/https?:\/\/[^\s"<)'\]]+/gi, '');
  c = c.replace(/www\.[a-zA-Z0-9][^\s"<)'\]]+/gi, '');

  // Strip iframes
  c = c.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  // Strip remaining competitor name mentions
  c = c.replace(/amx\s*superstores?\.com\.au/gi, '');
  c = c.replace(/mcas\.com\.au/gi, '');
  c = c.replace(/motorcycle\s+accessories\s+supermarket/gi, '');

  // Strip MCAS SKU list paragraphs: (HE0310EDAD-p , HE0310EDADL...)
  c = c.replace(/<p[^>]*>\s*\([A-Z0-9\s,\-p\.]+\)\s*<\/p>/gi, '');

  // Strip image disclaimers
  c = c.replace(/<p[^>]*>[^<]*please note[^<]*images shown[^<]*<\/p>/gi, '');
  c = c.replace(/<p[^>]*>[^<]*images shown[^<]*display use only[^<]*<\/p>/gi, '');

  // Clean up empty tags and excess whitespace
  c = c
    .replace(/<p[^>]*>\s*<\/p>/gi, '')
    .replace(/<h[1-6]>\s*<\/h[1-6]>/gi, '')
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '<br>')
    .replace(/\s{3,}/g, ' ')
    .trim();

  return c;
}

// ── Strip competitor name from tags ───────────────────────────────────────────
function cleanTags(tags, competitorName) {
  if (!tags) return '';
  const competitorWords = (competitorName || '').toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(
    tags.split(',')
      .map(t => t.trim())
      .filter(t => {
        if (!t) return false;
        const tl = t.toLowerCase();
        if (competitorWords.some(w => w.length > 2 && tl === w)) return false;
        if (/amxsuperstores?/i.test(t)) return false;
        if (/mcas\.com/i.test(t)) return false;
        return true;
      })
  )].join(', ');
}

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
const HEADER_FONT = { name: 'Arial', bold: true, size: 11 };
const DATA_FONT   = { name: 'Arial', size: 11 };

export async function exportToExcel(products, competitorName = 'Competitor') {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Competitor Scout';
  wb.created = new Date();

  const ws = wb.addWorksheet('Sheet1');
  ws.columns = COLUMNS.map(c => ({ key: c.key, width: c.width }));

  // Header row
  const headerRow = ws.addRow(COLUMNS.map(c => c.header));
  headerRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
  });

  // Data rows
  for (const product of products) {
    const images      = (product.images || []).filter(Boolean);
    const variants    = (product.variants || []);
    const description = cleanDescription(product.description);
    const tags        = cleanTags(product.tags, competitorName);

    // Does this product have real named sizes (S/M/L/XL etc.)?
    const hasSizes = variants.some(v => (v.size || v.option1 || '').trim());

    const maxRows = Math.max(images.length, variants.length, 1);

    for (let i = 0; i < maxRows; i++) {
      const variant    = variants[i] || null;
      const imageSrc   = images[i]   || '';
      const isFirst    = i === 0;
      const hasVariant = variant !== null;

      const sizeLabel = hasVariant
        ? (variant.size || variant.option1 || '').trim()
        : '';

      const row = ws.addRow([
        '',                          // A: ID — always empty
        product.handle      || '',   // B: Handle
        product.title       || '',   // C: Title
        isFirst ? description : '',  // D: Body HTML — first row only, cleaned
        product.vendor      || '',   // E: Vendor
        product.productType || '',   // F: Type
        tags,                        // G: Tags

        // H: Option1 Name
        hasSizes && isFirst ? 'Size' : '',

        // I: Option1 Value
        hasSizes && hasVariant ? sizeLabel : '',

        imageSrc,                    // J: Image Src

        hasVariant ? (variant.id      || '') : '',   // K: Variant ID
        hasVariant ? (variant.sku     || '') : '',   // L: Variant SKU
        hasVariant ? (variant.barcode || '') : '',   // M: Variant Barcode
        hasVariant ? (variant.weight  || '') : '',   // N: Variant Weight
        hasVariant ? (variant.weightUnit || '') : '', // O: Variant Weight Unit

        // P: Variant Price
        hasVariant && variant.price !== undefined && variant.price !== ''
          ? parseFloat(variant.price) || ''
          : '',

        // Q: Variant Inventory Qty
        hasVariant && variant.inventoryQty !== undefined
          ? variant.inventoryQty
          : '',

        hasVariant ? 'shopify' : '', // R: Variant Inventory Tracker
        hasVariant ? 'deny'    : '', // S: Variant Inventory Policy

        '', // T: Inventory On Hand: Evotech Warehouse
        '', // U: Variant HS Code
        '', // V: Variant Country of Origin
        '', // W: Template Suffix

        // Sales channels — TRUE on first row only
        isFirst ? 'TRUE' : '', // X: Published
        isFirst ? 'TRUE' : '', // Y: Online Store
        isFirst ? 'TRUE' : '', // Z: Point of Sale
        isFirst ? 'TRUE' : '', // AA: Google & YouTube
        isFirst ? 'TRUE' : '', // AB: Facebook & Instagram
        isFirst ? 'TRUE' : '', // AC: Shop
        isFirst ? 'TRUE' : '', // AD: Inbox
      ]);

      row.eachCell(cell => {
        cell.font = DATA_FONT;
        // Wrap text in Body HTML and Image Src columns
        if (['Body HTML', 'Image Src', 'Tags', 'Source URL'].includes(cell._column?.key)) {
          cell.alignment = { wrapText: true, vertical: 'top' };
        }
      });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return buffer;
}