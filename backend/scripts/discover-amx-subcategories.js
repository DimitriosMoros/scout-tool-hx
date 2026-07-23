/**
 * One-time script: discover subcategories for every AMX brand.
 * Reuses a single browser session across all brands for speed.
 * Saves progress to site-catalog.json after each brand — safe to re-run if interrupted.
 *
 * Usage: node backend/scripts/discover-amx-subcategories.js
 */

import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const BASE_URL     = 'https://www.amxsuperstores.com.au';
const DOMAIN       = 'www.amxsuperstores.com.au';
const DELAY_MS     = 1200; // between brands

// ── Helpers ───────────────────────────────────────────────────────────────────

function readCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; }
}

function saveCatalog(data) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Browser ───────────────────────────────────────────────────────────────────

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
    executablePath,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3] });
  });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}

// ── Category extraction ───────────────────────────────────────────────────────

async function extractSubcategories(page, brandUrl) {
  await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.categories-filter__list .categories-filter__category span'))
      .map(s => s.textContent.trim()).filter(Boolean)
  );

  // AMX URL format: ?categories={slug}  e.g. "Adventure Helmets" → categories=adventure-helmets
  return labels.map(label => ({
    label,
    filterParam: `categories=${label.toLowerCase().replace(/\s+/g, '-')}`,
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const catalog = readCatalog();
  const brands  = catalog[DOMAIN]?.brands || [];

  if (!brands.length) {
    console.error(`No brands found for ${DOMAIN} in site-catalog.json`);
    console.error('Run brand discovery first via the UI (Reload all vendors).');
    process.exit(1);
  }

  console.log(`\nDiscovering subcategories for ${brands.length} brands on ${DOMAIN}`);
  console.log('Progress is saved after each brand — safe to Ctrl+C and re-run.\n');

  const browser = await openBrowser();
  let   page    = await newPage(browser);

  let done = 0, skipped = 0, failed = 0;

  try {
    for (const brand of brands) {
      const { name, handle } = brand;
      const cacheKey = handle.toLowerCase();

      // Re-read catalog each iteration to pick up saves from previous iterations
      const current    = readCatalog();
      const alreadyHas = current[DOMAIN]?.subcategories?.[cacheKey];

      if (alreadyHas?.length > 0) {
        skipped++;
        process.stdout.write(`[skip] ${name}\n`);
        continue;
      }

      const url = `${BASE_URL}/brands/${handle}`;
      process.stdout.write(`[${done + skipped + failed + 1}/${brands.length}] ${name} ... `);

      try {
        const subcategories = await extractSubcategories(page, url);

        const fresh    = readCatalog();
        const existing = fresh[DOMAIN]?.subcategories || {};
        fresh[DOMAIN].subcategories = { ...existing, [cacheKey]: subcategories };
        saveCatalog(fresh);

        process.stdout.write(`${subcategories.length} subcategories\n`);
        done++;
      } catch (err) {
        process.stdout.write(`FAILED — ${err.message.slice(0, 80)}\n`);
        failed++;

        // Reopen page if it crashed
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
