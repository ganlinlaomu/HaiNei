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

const SW_PATH = path.join(__dirname, '..', 'public', 'service-worker.js');
const PACKAGE_PATH = path.join(__dirname, '..', 'package.json');

// Read package.json to get version
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
const version = packageJson.version;

// Cloudflare Pages exposes CF_PAGES_COMMIT_SHA. Include it for traceability and
// retain the timestamp so redeploying the same commit is also byte-distinct.
const commitSha = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || process.env.COMMIT_SHA;
const buildTimestamp = new Date().toISOString();
const buildId = commitSha ? `${commitSha.slice(0, 12)}-${buildTimestamp}` : buildTimestamp;

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
