/**
 * Bootstrap Updater — Competitor Scout
 *
 * Runs BEFORE the main app starts. Flow:
 *   1. Fetch latest-version.json from GitHub (raw)
 *   2. Compare to local version in package.json
 *   3. If newer: download GitHub auto-generated source zip
 *   4. Extract, copy files over (preserving .env and data)
 *   5. Launch main app
 *
 * Usage: node updater.js
 * Called from START.bat before launching the app.
 */

import https from 'https';
import http from 'http';
import fs, { createWriteStream, existsSync, readFileSync, mkdirSync, rmSync, cpSync } from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────────
const GITHUB_USER    = 'DimitriosMoros';
const GITHUB_REPO    = 'scout-tool-hx';
const VERSION_URL =
"https://raw.githubusercontent.com/DimitriosMoros/scout-tool-hx/main/latest-version.json";
// ── Files to PRESERVE across updates (never overwritten) ─────────────────────
const PRESERVE = [
  'backend/.env',
  'backend/data/competitors.json',
  'backend/data/watchlist.json',
  'backend/data/scan-history.json',
  'backend/data/scraped-products.json',
  'backend/data/draft-status.json',
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function log(msg)  { console.log(`[Updater] ${msg}`); }
function warn(msg) { console.warn(`[Updater] ⚠ ${msg}`); }

function fetch(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const req = get(url, { headers: { 'User-Agent': `${GITHUB_REPO}-updater` } }, res => {
      // Follow redirects — GitHub archive zips redirect to CDN
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return fetch(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} — ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

async function fetchJson(url) {
  const buf = await fetch(url);
  return JSON.parse(buf.toString('utf8'));
}

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const req = get(url, { headers: { 'User-Agent': `${GITHUB_REPO}-updater` } }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0');
      let downloaded = 0;
      const stream = createWriteStream(destPath);
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total > 0) {
          const pct  = Math.round((downloaded / total) * 100);
          const mb   = (downloaded / 1024 / 1024).toFixed(1);
          const tmb  = (total / 1024 / 1024).toFixed(1);
          process.stdout.write(`\r[Updater] Downloading... ${pct}% (${mb}/${tmb} MB)`);
        }
      });
      res.pipe(stream);
      stream.on('finish', () => { process.stdout.write('\n'); resolve(); });
      stream.on('error', reject);
    });
    req.on('error', reject);
  });
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
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

function backupPreserved(tmpDir) {
  const backed = {};
  for (const rel of PRESERVE) {
    const src = path.join(__dirname, rel);
    if (existsSync(src)) {
      const dest = path.join(tmpDir, 'preserved', rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      backed[rel] = dest;
      log(`  Preserved: ${rel}`);
    }
  }
  return backed;
}

function restorePreserved(backed) {
  for (const [rel, src] of Object.entries(backed)) {
    const dest = path.join(__dirname, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    log(`  Restored:  ${rel}`);
  }
}

async function applyUpdate(manifest) {
  const { version, url } = manifest;
  const tmpDir  = path.join(__dirname, '.update-tmp');
  const zipPath = path.join(tmpDir, 'source.zip');
  const extDir  = path.join(tmpDir, 'extracted');

  // Clean slate
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(extDir, { recursive: true });

  try {
    // 1. Backup user data
    log('Backing up user data...');
    const backed = backupPreserved(tmpDir);

    // 2. Download the zip
    log(`Downloading v${version}...`);
    await downloadFile(url, zipPath);

    // 3. Extract
    log('Extracting...');
    if (process.platform === 'win32') {
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extDir}' -Force"`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(`unzip -q "${zipPath}" -d "${extDir}"`, { stdio: 'pipe' });
    }

    // 4. Find the extracted root folder
    // GitHub auto-zip extracts to: scout-tool-hx-1.0.1/  (repo-name-version)
    // We need to step into that folder to get the actual files
    const entries = fs.readdirSync(extDir);
    const root = entries.length === 1 && fs.statSync(path.join(extDir, entries[0])).isDirectory()
      ? path.join(extDir, entries[0])   // step into the auto-named folder
      : extDir;

    log(`Extracted root: ${path.basename(root)}`);

    // 5. Copy new files over — skip node_modules, .env, data, and tmp dir
    log('Applying new files...');
    cpSync(root, __dirname, {
      recursive: true,
      filter: src => {
        const rel = path.relative(root, src);
        if (!rel) return true; // root itself
        if (rel.startsWith('node_modules'))  return false;
        if (rel.startsWith('backend/node_modules')) return false;
        if (rel.startsWith('.update-tmp'))   return false;
        if (rel === 'backend/.env')          return false;
        if (rel.startsWith('backend/data/')) return false;
        return true;
      },
    });

    // 6. Restore user data (in case any got clobbered)
    log('Restoring user data...');
    restorePreserved(backed);

    // 7. Update package.json version to match manifest
    try {
      const pkgPath = path.join(__dirname, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.version = version;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch(_) {}

    // 8. npm install in case dependencies changed
    log('Checking dependencies...');
    try {
      execSync('npm install --production --no-audit --no-fund', {
        cwd: __dirname,
        stdio: 'pipe',
        timeout: 60000,
      });
    } catch(_) { warn('npm install had warnings — continuing'); }

    log(`✓ Successfully updated to v${version}`);
    return true;

  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch(_) {}
  }
}

function launchApp() {
  const mainScript = path.join(__dirname, 'backend', 'src', 'index.js');
  if (!existsSync(mainScript)) {
    console.error(`[Updater] Cannot find app at: ${mainScript}`);
    process.exit(1);
  }
  log('Starting Competitor Scout...\n');
  const child = spawn(process.execPath, [mainScript], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env },
  });
  child.on('exit', code => process.exit(code || 0));
  child.on('error', e => { console.error(`[Updater] Failed to start: ${e.message}`); process.exit(1); });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const localVersion = getLocalVersion();

  console.log('');
  log(`Current version : v${localVersion}`);

  if (process.argv.includes('--skip-update')) {
    log('Skipping update check.');
    launchApp();
    return;
  }

  // Fetch manifest with timeout
  let manifest;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timed out after 8s')), 8000)
    );
    manifest = await Promise.race([fetchJson(VERSION_URL), timeout]);
    log(`Latest version  : v${manifest.version}`);
  } catch(e) {
    warn(`Could not check for updates (${e.message})`);
    log('Starting with current version...');
    launchApp();
    return;
  }

  if (compareVersions(manifest.version, localVersion) <= 0) {
    log('Already up to date.\n');
    launchApp();
    return;
  }

  // Update available
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log(`  ║  Update available: v${manifest.version.padEnd(21)}║`);
  console.log(`  ║  ${(manifest.notes || 'Bug fixes and improvements').slice(0, 40).padEnd(40)}  ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  try {
    await applyUpdate(manifest);

    // Relaunch with updated code
    log('Restarting with updated version...\n');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--skip-update'], {
      stdio: 'inherit',
      cwd: __dirname,
      detached: true,
    });
    child.unref();
    process.exit(0);

  } catch(e) {
    warn(`Update failed: ${e.message}`);
    log('Starting with current version...');
    launchApp();
  }
}

main().catch(e => {
  console.error(`[Updater] Fatal: ${e.message}`);
  launchApp();
});