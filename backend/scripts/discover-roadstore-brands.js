/**
 * One-time script: discover all Road Store brands via SearchSpring API.
 * Fast — no browser needed. Saves to site-catalog.json.
 *
 * Usage: node backend/scripts/discover-roadstore-brands.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const DOMAIN       = 'www.roadstore.com.au';
const SS_API       = 'https://hmjh5r.a.searchspring.io/api/search/search.json';

function readCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; }
}

function saveCatalog(data) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2));
}

async function main() {
  console.log(`\nDiscovering Road Store brands via SearchSpring API...`);

  const res  = await fetch(`${SS_API}?siteId=hmjh5r&resultsFormat=native&resultsPerPage=0`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  const brandFacet = (data.facets || []).find(f => f.field === 'brand');
  const values     = brandFacet?.values || [];
  if (!values.length) throw new Error('No brand facet in response');

  const brands = values.map(v => {
    const name   = v.value || '';
    const handle = name.toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return { name, handle };
  }).sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Found ${brands.length} brands`);

  const catalog = readCatalog();
  if (!catalog[DOMAIN]) catalog[DOMAIN] = {};
  catalog[DOMAIN].brands      = brands;
  catalog[DOMAIN].lastChecked = new Date().toISOString();
  if (!catalog[DOMAIN].subcategories) catalog[DOMAIN].subcategories = {};
  saveCatalog(catalog);

  console.log(`\n✓ Saved ${brands.length} brands to site-catalog.json`);
  console.log('Now run: node backend/scripts/discover-roadstore-subcategories.js');
}

main().catch(err => { console.error(err); process.exit(1); });
