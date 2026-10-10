#!/usr/bin/env node

/**
 * Update Service Worker Version
 * 
 * This script updates the VERSION and BUILD_ID in the service worker
 * to ensure proper cache invalidation on deployment.
 * 
 * Usage:
 *   node scripts/update-sw-version.js
 * 
 * This should be run as part of the build process:
 *   "build": "node scripts/update-sw-version.js && vite build"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SW_PATH = path.join(__dirname, '..', 'public', 'service-worker.js');
const PACKAGE_PATH = path.join(__dirname, '..', 'package.json');

// Read package.json to get version
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
const version = packageJson.version;

// Keep the identity stable for identical application bytes. A timestamp in the
// Service Worker made *every rebuild of the same commit* appear to be an update,
// causing a repeated "立即更新" prompt on iOS PWA.
const root = path.join(__dirname, '..');
const hash = crypto.createHash('sha256');
function fingerprint(relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) return;
  if (fs.statSync(fullPath).isDirectory()) {
    for (const file of fs.readdirSync(fullPath).sort()) fingerprint(path.join(relativePath, file));
    return;
  }
  let bytes = fs.readFileSync(fullPath);
  // Never hash the previously generated BUILD_ID: rebuilds must be idempotent.
  if (relativePath.replace(/\\/g, '/') === 'public/service-worker.js') {
    bytes = Buffer.from(bytes.toString('utf8').replace(
      /const BUILD_ID = ['"][^'"]+['"]/,
      'const BUILD_ID = "<stable-build-id>"'
    ));
  }
  hash.update(relativePath.replace(/\\/g, '/'));
  hash.update(bytes);
}
for (const item of ['src', 'public', 'scripts', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'vite.config.js']) {
  fingerprint(item);
}
const sourceHash = hash.digest('hex').slice(0, 16);
const commitSha = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || process.env.COMMIT_SHA;
const buildId = commitSha ? `${commitSha.slice(0, 12)}-${sourceHash}` : `source-${sourceHash}`;

// Read service worker file
let swContent = fs.readFileSync(SW_PATH, 'utf8');

function replaceRequired(source, pattern, replacement, markerName) {
  if (!pattern.test(source)) {
    throw new Error(`Unable to update service worker: missing ${markerName} marker in ${SW_PATH}`);
  }
  return source.replace(pattern, replacement);
}

swContent = replaceRequired(
  swContent,
  /const VERSION = ['"][^'"]+['"]/,
  `const VERSION = ${JSON.stringify(version)}`,
  'VERSION'
);
swContent = replaceRequired(
  swContent,
  /const BUILD_ID = ['"][^'"]+['"]/,
  `const BUILD_ID = ${JSON.stringify(buildId)}`,
  'BUILD_ID'
);

// Write back to file
fs.writeFileSync(SW_PATH, swContent, 'utf8');

console.log(`✅ Service Worker version updated:`);
console.log(`   VERSION: ${version}`);
console.log(`   BUILD_ID: ${buildId}`);
