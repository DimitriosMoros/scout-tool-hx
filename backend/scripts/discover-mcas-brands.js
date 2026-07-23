/**
 * One-time script: discover all brands on MCAS and save to site-catalog.json.
 * Run this before discover-mcas-subcategories.js.
 *
 * Usage: node backend/scripts/discover-mcas-brands.js
 */

import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, '..', 'data', 'site-catalog.json');
const BASE_URL     = 'https://www.mcas.com.au';
const DOMAIN       = 'www.mcas.com.au';

function readCatalog() {
  try { return JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')); } catch(_) { return {}; }
}

function saveCatalog(data) {
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractBrands(html) {
  const $ = cheerio.load(html);
  const brands = [];
  const seen   = new Set();

  $('a[href]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const clean = href.split('?')[0];
    // MCAS brand URLs: /brand/{handle}/ (singular, trailing slash optional)
    const m = clean.match(/\/brand\/([a-z0-9][a-z0-9-]*)\/?$/i);
    if (!m) return;
    const handle = m[1].toLowerCase();
    if (seen.has(handle)) return;
    seen.add(handle);

    // Try text content, then image alt, then capitalise the handle as fallback
    const name = $(el).text().replace(/\s+/g, ' ').trim()
      || $(el).find('img').attr('alt')?.trim()
      || handle.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    brands.push({ name, handle });
  });

  return brands;
}

async function main() {
  const brandsUrl = `${BASE_URL}/brands/`;
  console.log(`\nDiscovering MCAS brands from ${brandsUrl}\n`);

  const chromePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ];
  const executablePath = chromePaths.find(p => { try { return fs.existsSync(p); } catch(_) { return false; } });
  if (!executablePath) { console.error('Chrome not found'); process.exit(1); }

  const browser = await puppeteer.launch({
    executablePath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 900 },
  });

  let brands = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(brandsUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Scroll repeatedly to trigger lazy-load of all brand cards
    let prevCount = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(1200);
      const count = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/brand/"]').length
      );
      process.stdout.write(`\r  Scrolling... ${count} brand links loaded`);
      if (count === prevCount && attempt > 2) break;
      prevCount = count;
    }
    console.log('');

    brands = extractBrands(await page.content());
  } finally {
    await browser.close().catch(() => {});
  }

  if (!brands.length) {
    console.error('No brands found — the /brands/ page structure may have changed');
    process.exit(1);
  }

  brands.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`Found ${brands.length} brands`);

  const catalog = readCatalog();
  if (!catalog[DOMAIN]) catalog[DOMAIN] = {};
  catalog[DOMAIN].brands      = brands;
  catalog[DOMAIN].lastChecked = new Date().toISOString();
  if (!catalog[DOMAIN].subcategories) catalog[DOMAIN].subcategories = {};
  saveCatalog(catalog);

  console.log(`\n✓ Saved ${brands.length} brands to site-catalog.json`);
  console.log('Now run: node backend/scripts/discover-mcas-subcategories.js');
}

main().catch(err => { console.error(err); process.exit(1); });
