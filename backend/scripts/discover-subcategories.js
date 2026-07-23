/**
 * One-time script: discover subcategories for every Motoheaven brand.
 * Reuses a single browser session across all brands for speed.
 * Saves progress to site-catalog.json after each brand — safe to re-run if interrupted.
 *
 * Usage: node --experimental-vm-modules backend/scripts/discover-subcategories.js
 *    or: cd backend && node scripts/discover-subcategories.js
 */

import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const BASE_URL     = 'https://motoheaven.com.au';
const DOMAIN       = 'motoheaven.com.au';
const DELAY_MS     = 1500; // between brands

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

// ── Subcategory extraction ────────────────────────────────────────────────────

async function extractSubcategories(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  return page.evaluate(() => {
    const best = new Map();

    document.querySelectorAll('input[data-filter-item-input]').forEach(input => {
      const name   = input.name || '';
      const filter = input.dataset.filter || '';
      if (!name.includes('sub_category') && !filter.includes('sub_category')) return;

      const param = filter || `${name}=${input.value}`;
      if (!param) return;
      if (best.get(param)?.hasLabel) return;

      const li = input.closest('[data-filter-list-item]') || input.closest('li');

      let labelText = li?.querySelector('.filter-item__label')?.textContent?.trim() || '';
      if (!labelText) {
        const idParts = (input.id || '').split('--');
        if (idParts.length >= 3) {
          try { labelText = decodeURIComponent(idParts[2]); } catch(_) { labelText = idParts[2]; }
        }
      }
      if (!labelText) {
        labelText = (li?.dataset?.itemLabel || '').replace(/(?:^|\s|-)(\S)/g, m => m.toUpperCase());
      }

      if (labelText) {
        best.set(param, { label: labelText, filterParam: param, hasLabel: true });
      } else if (!best.has(param)) {
        best.set(param, { label: input.value, filterParam: param, hasLabel: false });
      }
    });

    return Array.from(best.values()).map(({ label, filterParam }) => ({ label, filterParam }));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const catalog = readCatalog();
  const brands  = catalog[DOMAIN]?.brands || [];

  if (!brands.length) {
    console.error('No brands found in site-catalog.json');
    process.exit(1);
  }

  console.log(`\nDiscovering subcategories for ${brands.length} brands on ${DOMAIN}`);
  console.log('Progress is saved after each brand — safe to Ctrl+C and re-run.\n');

  const browser = await openBrowser();
  const page    = await newPage(browser);

  let done = 0, skipped = 0, failed = 0;

  try {
    for (const brand of brands) {
      const { name, handle } = brand;
      const cacheKey = handle.toLowerCase();

      // Re-read catalog each iteration so we pick up saves from previous iterations
      const current    = readCatalog();
      const alreadyHas = current[DOMAIN]?.subcategories?.[cacheKey];

      if (alreadyHas) {
        skipped++;
        process.stdout.write(`[skip] ${name}\n`);
        continue;
      }

      const url = `${BASE_URL}/collections/${handle}`;
      process.stdout.write(`[${done + skipped + failed + 1}/${brands.length}] ${name} ... `);

      try {
        const subcategories = await extractSubcategories(page, url);

        // Save immediately
        const fresh = readCatalog();
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
        try {
          const freshPage = await newPage(browser);
          Object.assign(page, freshPage);
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
