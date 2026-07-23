/**
 * One-time script: discover subcategories for every MCAS brand via Puppeteer.
 * Reuses a single browser session. Saves after each brand — safe to interrupt and re-run.
 *
 * Usage: node backend/scripts/discover-mcas-subcategories.js
 */

import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const DOMAIN       = 'www.mcas.com.au';
const BASE_URL     = 'https://www.mcas.com.au';
const DELAY_MS     = 800;

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

async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  return page;
}

async function extractSubcategories(page, handle) {
  // Load brand page with "All Categories" expanded — same as clicking the button in browser
  const url = `${BASE_URL}/brand/${handle}/?filters%5Bcategory1%5D%5B0%5D%5B0%5D=All%20Products`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500); // let Findify widget finish rendering

  return page.evaluate(() => {
    const items = document.querySelectorAll(
      '.findify-components--category-facet__nested .findify-components--category-facet__content'
    );
    return Array.from(items).map(el => {
      // Text is a direct text node — SVG child (the arrow) must be excluded
      const label = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join('').trim();
      return label;
    }).filter(Boolean);
  });
}

async function main() {
  const catalog = readCatalog();
  const brands  = catalog[DOMAIN]?.brands || [];

  if (!brands.length) {
    console.error(`No brands for ${DOMAIN} in site-catalog.json. Run discover-mcas-brands.js first.`);
    process.exit(1);
  }

  console.log(`\nDiscovering subcategories for ${brands.length} brands on ${DOMAIN}`);
  console.log('Progress saved after each brand — safe to Ctrl+C and re-run.\n');

  // Wipe previously stored subcategories (old API-based data was wrong)
  const fresh = readCatalog();
  if (fresh[DOMAIN]) { fresh[DOMAIN].subcategories = {}; saveCatalog(fresh); }

  const browser = await openBrowser();
  let page = await newPage(browser);
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
        const labels = await extractSubcategories(page, handle);

        // filterParam mirrors the URL pattern: filters[category1][0][0]={label}
        const subcategories = labels.map(label => ({
          label,
          filterParam: `filters[category1][0][0]=${label}`,
        }));

        const cat = readCatalog();
        const existing = cat[DOMAIN]?.subcategories || {};
        cat[DOMAIN].subcategories = { ...existing, [cacheKey]: subcategories };
        saveCatalog(cat);

        process.stdout.write(`${subcategories.length} subcategories\n`);
        done++;
      } catch (err) {
        process.stdout.write(`FAILED — ${err.message.slice(0, 80)}\n`);
        failed++;
        try { await page.close(); } catch(_) {}
        try { page = await newPage(browser); } catch(_) {}
      }

      await sleep(DELAY_MS);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\n✓ Done — ${done} discovered, ${skipped} already cached, ${failed} failed`);
}

main().catch(err => { console.error(err); process.exit(1); });
