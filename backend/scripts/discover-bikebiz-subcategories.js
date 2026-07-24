/**
 * One-time script: discover subcategories for every BikeBiz brand via Puppeteer.
 * Reuses a single browser session. Saves after each brand — safe to interrupt and re-run.
 *
 * Usage: node backend/scripts/discover-bikebiz-subcategories.js
 */

import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const DOMAIN       = 'www.bikebiz.com.au';
const BASE_URL     = 'https://www.bikebiz.com.au';
const DELAY_MS     = 800;

function readCatalog()  { try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; } }
function saveCatalog(d) { fs.writeFileSync(CATALOG_FILE, JSON.stringify(d, null, 2)); }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }

async function openBrowser() {
  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  if (process.env.CHROME_PATH) chromePaths.unshift(process.env.CHROME_PATH);
  const executablePath = chromePaths.find(p => { try { return fs.existsSync(p); } catch(_) { return false; } });
  if (!executablePath) throw new Error('Chrome not found');
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  });
}

async function extractSubcategories(page, handle) {
  await page.goto('about:blank', { waitUntil: 'load', timeout: 15000 }).catch(() => {});
  await page.goto(`${BASE_URL}/brands/${handle}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2500);

  const extract = () => page.evaluate(() => {
    const links = document.querySelectorAll('#carousel a.carousel-item');
    const seen  = new Set();
    return Array.from(links).map(a => {
      const slug = a.href.split('/').filter(Boolean).pop();
      if (!slug || seen.has(slug)) return null;
      seen.add(slug);
      const label = a.querySelector('span')?.textContent.trim() || slug;
      return { label, filterParam: slug };
    }).filter(Boolean);
  });

  let result = await extract();
  if (result.length === 0) {
    await sleep(3000);
    result = await extract();
  }
  return result;
}

async function main() {
  const catalog = readCatalog();
  const brands  = catalog[DOMAIN]?.brands || [];

  if (!brands.length) {
    console.error(`No brands for ${DOMAIN} in site-catalog.json. Run discover-bikebiz-brands.js first.`);
    process.exit(1);
  }

  console.log(`\nDiscovering subcategories for ${brands.length} BikeBiz brands`);
  console.log('Progress saved after each brand — safe to Ctrl+C and re-run.\n');

  // Wipe existing subcategories so stale data is not skipped
  const wipe = readCatalog();
  if (wipe[DOMAIN]) { wipe[DOMAIN].subcategories = {}; saveCatalog(wipe); }

  const browser = await openBrowser();
  let page = await browser.newPage();
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

  console.log(`\nDone — ${done} discovered, ${skipped} already cached, ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
