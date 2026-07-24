/**
 * One-time script: populate site-catalog.json with Van Demon Performance brands.
 * Van Demon is a Shopify store — brands are hardcoded motorcycle make collections.
 * No browser required.
 *
 * Usage: node backend/scripts/discover-vandemon-brands.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverCompetitorBrands } from '../src/vandemonScraper.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const DOMAIN       = 'vandemonperformance.com.au';
const BASE_URL     = 'https://vandemonperformance.com.au';

function readCatalog()  { try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; } }
function saveCatalog(d) { fs.writeFileSync(CATALOG_FILE, JSON.stringify(d, null, 2)); }

async function main() {
  console.log('\nDiscovering Van Demon Performance brands...');
  const brands = await discoverCompetitorBrands(BASE_URL);
  console.log(`Found ${brands.length} brands`);

  const catalog = readCatalog();
  if (!catalog[DOMAIN]) catalog[DOMAIN] = {};
  catalog[DOMAIN].brands      = brands;
  catalog[DOMAIN].lastChecked = new Date().toISOString();
  saveCatalog(catalog);

  console.log('\nSaved to site-catalog.json:');
  brands.forEach(b => console.log(`  ${b.name} (${b.handle})`));
}

main().catch(err => { console.error(err); process.exit(1); });
