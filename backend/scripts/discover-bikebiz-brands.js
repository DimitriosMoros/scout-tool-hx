/**
 * One-time script: discover all BikeBiz brands via Puppeteer.
 * Saves results to site-catalog.json under www.bikebiz.com.au.
 *
 * Usage: node backend/scripts/discover-bikebiz-brands.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverCompetitorBrands } from '../src/bikebizScraper.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const DOMAIN       = 'www.bikebiz.com.au';
const BASE_URL     = 'https://www.bikebiz.com.au';

function readCatalog()  { try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; } }
function saveCatalog(d) { fs.writeFileSync(CATALOG_FILE, JSON.stringify(d, null, 2)); }

async function main() {
  console.log('\nDiscovering BikeBiz brands…');
  const brands = await discoverCompetitorBrands(BASE_URL);
  console.log(`Found ${brands.length} brands`);

  const catalog = readCatalog();
  if (!catalog[DOMAIN]) catalog[DOMAIN] = {};
  catalog[DOMAIN].brands      = brands;
  catalog[DOMAIN].lastChecked = new Date().toISOString();
  saveCatalog(catalog);

  console.log(`\nSaved to site-catalog.json:`);
  brands.forEach(b => console.log(`  ${b.name} (${b.handle})`));
}

main().catch(err => { console.error(err); process.exit(1); });
