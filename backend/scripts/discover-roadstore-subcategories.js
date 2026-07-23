/**
 * One-time script: discover subcategories for every Road Store brand via Puppeteer.
 * Reuses a single browser session. Saves after each brand — safe to interrupt and re-run.
 *
 * Usage: node backend/scripts/discover-roadstore-subcategories.js
 */

import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const DOMAIN       = 'www.roadstore.com.au';
const BASE_URL     = 'https://www.roadstore.com.au';
const DELAY_MS     = 600;

function readCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; }
}

function saveCatalog(data) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function openBrowser() {
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  const executablePath = chromePaths.find(p => { try { return fs.existsSync(p); } catch(_) { return false; } });
  if (!executablePath) throw new Error('Chrome not found');
  return puppeteer.launch({
    executablePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });
}

async function extractSubcategories(page, handle) {
  const url = `${BASE_URL}/brand/${handle}/`;

  // Navigate via about:blank first to clear AngularJS filter state from previous brand
  await page.goto('about:blank', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  const extract = () => page.evaluate(() => {
    // Exclude filtered-link (history items from previous nav) and filtered-current (active span)
    const links = document.querySelectorAll(
      '#filter-brand_category li:not(.filtered-link):not(.filtered-current) a'
    );
    const seen = new Set();
    return Array.from(links).map(a => {
      const hash  = '#' + a.href.split('#').slice(1).join('#');
      const label = (a.getAttribute('title') || a.textContent.replace(/\s*\(\d+\)\s*$/, '').trim());
      if (!hash.includes('filter:brand_category:')) return null;
      if (seen.has(hash)) return null; // deduplicate (mobile + desktop sidebar both render the list)
      seen.add(hash);
      return { label, filterParam: hash };
    }).filter(Boolean);
  });

  let result = await extract();

  // Retry once with extra wait if nothing came back (page may still be hydrating)
  if (result.length === 0) {
    await sleep(3500);
    result = await extract();
  }

  return result;
}

async function main() {
  const catalog = readCatalog();
  const brands  = catalog[DOMAIN]?.brands || [];

  if (!brands.length) {
    console.error(`No brands for ${DOMAIN} in site-catalog.json. Run discover-roadstore-brands.js first.`);
    process.exit(1);
  }

  console.log(`\nDiscovering subcategories for ${brands.length} Road Store brands`);
  console.log('Progress saved after each brand — safe to Ctrl+C and re-run.\n');

  // Wipe all previously stored Road Store subcategories so bad data is not skipped
  const wipe = readCatalog();
  if (wipe[DOMAIN]) { wipe[DOMAIN].subcategories = {}; saveCatalog(wipe); }

  const browser = await openBrowser();
  let page      = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  let done = 0, skipped = 0, failed = 0;

  try {
    for (const brand of brands) {
      const { name, handle } = brand;
      const cacheKey = handle.toLowerCase();

      const current    = readCatalog();
      const alreadyHas = current[DOMAIN]?.subcategories?.[cacheKey];
      if (alreadyHas?.length > 0) {
        skipped++;
        process.stdout.write(`[skip] ${name}\n`);
        continue;
      }

      process.stdout.write(`[${done + skipped + failed + 1}/${brands.length}] ${name} ... `);

      try {
        const subcategories = await extractSubcategories(page, handle);

        const cat      = readCatalog();
        const existing = cat[DOMAIN]?.subcategories || {};
        cat[DOMAIN].subcategories = { ...existing, [cacheKey]: subcategories };
        saveCatalog(cat);

        process.stdout.write(`${subcategories.length} subcategories\n`);
        done++;
      } catch (err) {
        process.stdout.write(`FAILED — ${err.message.slice(0, 80)}\n`);
        failed++;
        try { await page.close(); } catch(_) {}
        try {
          page = await browser.newPage();
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        } catch(_) {}
      }

      await sleep(DELAY_MS);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n✓ Done — ${done} discovered, ${skipped} already cached, ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
