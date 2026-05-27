/**
 * Bootstrap Updater — Competitor Scout
 *
 * Runs BEFORE the main app starts. Flow:
 *   1. Fetch version.json from GitHub
 *   2. Compare to local version
 *   3. If newer: download release zip, extract, replace files
 *   4. Spawn main app (index.js)
 *
 * Usage: node updater.js
 * The launcher scripts (launcher.bat / launcher.sh) call this instead of index.js directly.
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

// ── Config — update these to match your GitHub repo ─────────────────────────
const GITHUB_USER = 'DimitriosMoros';
const GITHUB_REPO = 'scout-tool-hx';     // ← change this if different
const VERSION_URL   = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/version.json`;
const RELEASES_BASE = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}/releases/download`;

// ── Files / folders to PRESERVE across updates (user data) ──────────────────
// These are never overwritten — they contain client-specific config/data.
const PRESERVE = [
  'backend/.env',
  'backend/data/competitors.json',
  'backend/data/watchlist.json',
  'backend/data/scan-history.json',
  'backend/data/scraped-products.json',
  'backend/data/draft-status.json',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[Updater] ${msg}`); }
function err(msg) { console.error(`[Updater] ✗ ${msg}`); }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'CompetitorScout-Updater' } }, res => {
      // Follow redirects (GitHub releases redirect to CDN)
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, { headers: { 'User-Agent': 'CompetitorScout-Updater' } }, res => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      const stream = createWriteStream(destPath);
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct = Math.round((downloaded / total) * 100);
          process.stdout.write(`\r[Updater] Downloading... ${pct}%`);
        }
      });
      res.pipe(stream);
      stream.on('finish', () => { process.stdout.write('\n'); resolve(); });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

function compareVersions(a, b) {
  // Returns: 1 if a > b, -1 if a < b, 0 if equal
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function getLocalVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch(_) { return '0.0.0'; }
}

function backupPreservedFiles(tmpDir) {
  const backed = {};
  for (const rel of PRESERVE) {
    const src = path.join(__dirname, rel);
    if (existsSync(src)) {
      const dest = path.join(tmpDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      backed[rel] = dest;
      log(`  Preserving ${rel}`);
    }
  }
  return backed;
}

function restorePreservedFiles(backed) {
  for (const [rel, src] of Object.entries(backed)) {
    const dest = path.join(__dirname, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    log(`  Restored ${rel}`);
  }
}

async function applyUpdate(version) {
  const zipUrl  = `${RELEASES_BASE}/v${version}/competitor-scout-v${version}.zip`;
  const tmpDir  = path.join(__dirname, '.update-tmp');
  const zipPath = path.join(tmpDir, 'update.zip');
  const extDir  = path.join(tmpDir, 'extracted');

  // Clean / create tmp dir
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(extDir, { recursive: true });

  try {
    // 1. Backup user data
    log('Backing up user data...');
    const backed = backupPreservedFiles(tmpDir);

    // 2. Download zip
    log(`Downloading v${version} from GitHub Releases...`);
    await downloadFile(zipUrl, zipPath);
    log(`Downloaded to ${zipPath}`);

    // 3. Extract zip (using built-in unzip or PowerShell on Windows)
    log('Extracting...');
    try {
      if (process.platform === 'win32') {
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extDir}' -Force"`, { stdio: 'pipe' });
      } else {
        execSync(`unzip -q "${zipPath}" -d "${extDir}"`, { stdio: 'pipe' });
      }
    } catch(e) {
      throw new Error(`Extraction failed: ${e.message}`);
    }

    // 4. Find extracted root (zip may contain a top-level folder)
    const entries = fs.readdirSync(extDir);
    const root = entries.length === 1 && fs.statSync(path.join(extDir, entries[0])).isDirectory()
      ? path.join(extDir, entries[0])
      : extDir;

    // 5. Copy new files over (except node_modules)
    log('Applying update...');
    const copyOpts = {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.update-tmp'),
    };
    cpSync(root, __dirname, copyOpts);

    // 6. Restore user data
    log('Restoring user data...');
    restorePreservedFiles(backed);

    // 7. Run npm install in case dependencies changed
    log('Installing dependencies...');
    try {
      execSync('npm install --production --no-audit --no-fund', {
        cwd: __dirname,
        stdio: 'pipe',
      });
    } catch(_) {
      log('npm install warning — continuing anyway');
    }

    log(`✓ Updated to v${version}`);
    return true;
  } finally {
    // Always clean up tmp dir
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
  }
}

function launchApp() {
  log('Starting Competitor Scout...');
  const mainScript = path.join(__dirname, 'backend', 'src', 'index.js');
  const child = spawn(process.execPath, [mainScript], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env },
    detached: false,
  });
  child.on('exit', code => process.exit(code || 0));
  child.on('error', e => { err(`Failed to start app: ${e.message}`); process.exit(1); });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const localVersion = getLocalVersion();
  log(`Current version: v${localVersion}`);

  // Check for --skip-update flag (useful for development)
  if (process.argv.includes('--skip-update')) {
    log('Skipping update check (--skip-update)');
    launchApp();
    return;
  }

  // Check for update with 8-second timeout
  let manifest;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 8000)
    );
    manifest = await Promise.race([fetchJson(VERSION_URL), timeout]);
    log(`Latest version: v${manifest.version}`);
  } catch(e) {
    err(`Could not check for updates: ${e.message}`);
    log('Starting app with current version...');
    launchApp();
    return;
  }

  const comparison = compareVersions(manifest.version, localVersion);
  if (comparison <= 0) {
    log('Already up to date.');
    launchApp();
    return;
  }

  // Update available
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║  Update available: v${manifest.version.padEnd(17)}║`);
  console.log(`  ║  ${(manifest.notes || 'Bug fixes and improvements').slice(0, 36).padEnd(36)}  ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);

  try {
    const updated = await applyUpdate(manifest.version);
    if (updated) {
      log('Restarting with new version...\n');
      // Spawn a fresh process with the updated code, then exit this one
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--skip-update'], {
        stdio: 'inherit',
        cwd: __dirname,
        detached: true,
      });
      child.unref();
      process.exit(0);
    }
  } catch(e) {
    err(`Update failed: ${e.message}`);
    log('Starting app with current version...');
    launchApp();
  }
}

main().catch(e => {
  err(`Unexpected error: ${e.message}`);
  launchApp();
});