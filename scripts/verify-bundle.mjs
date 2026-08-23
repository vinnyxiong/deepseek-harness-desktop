#!/usr/bin/env node
// Verify the local dsh-bundle artifact:
//   - dsh-bundle.tar.gz exists, is non-empty, is a valid gzip tar archive
//   - dsh-bundle.manifest.json exists and parses
//   - manifest schema/version/triple/digest are well-formed
//   - manifest digest matches the tarball's sha256
//   - dsh-bundle.version matches manifest.version
//   - tarball contains the expected dsh entry points and no AppleDouble files
//
// Exits non-zero with a descriptive message on failure.

import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, closeSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const EXPECTED_TRIPLE = 'linux-x64-gnu';
const EXPECTED_SCHEMA = 'dsh-remote-bundle';
const EXPECTED_SCHEMA_VERSION = 1;

function fail(msg) {
  console.error(`bundle verify failed: ${msg}`);
  process.exit(1);
}

function sha256(filePath) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(65536);
  const fd = openSync(filePath, 'r');
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function listTar(filePath) {
  return execFileSync('tar', ['-tzf', filePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map(s => s.trim()).filter(Boolean);
}

const bundle = join(root, 'dsh-bundle.tar.gz');
const manifestPath = join(root, 'dsh-bundle.manifest.json');
const versionPath = join(root, 'dsh-bundle.version');

if (!existsSync(bundle)) fail(`${bundle} does not exist`);
const st = statSync(bundle);
if (!st.isFile() || st.size === 0) fail(`${bundle} is empty or not a regular file`);

// Validate tar.
let entries;
try {
  execFileSync('tar', ['-tzf', bundle], { stdio: 'ignore' });
  entries = listTar(bundle);
} catch (e) {
  fail(`tarball is not a valid gzip tar archive: ${e.message}`);
}

if (!existsSync(manifestPath)) fail(`${manifestPath} does not exist`);
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) {
  fail(`manifest parse failed: ${e.message}`);
}

if (manifest.schema !== EXPECTED_SCHEMA) fail(`schema mismatch: ${manifest.schema} (expected ${EXPECTED_SCHEMA})`);
if (manifest.schemaVersion !== EXPECTED_SCHEMA_VERSION) fail(`schemaVersion mismatch: ${manifest.schemaVersion} (expected ${EXPECTED_SCHEMA_VERSION})`);
if (manifest.triple !== EXPECTED_TRIPLE) fail(`triple mismatch: ${manifest.triple} (expected ${EXPECTED_TRIPLE})`);
if (manifest.platform !== 'linux' || manifest.arch !== 'x64' || manifest.libc !== 'gnu') {
  fail(`platform/arch/libc mismatch: ${manifest.platform}/${manifest.arch}/${manifest.libc}`);
}
if (!manifest.version || typeof manifest.version !== 'string') fail('manifest.version missing or not a string');
if (!/^sha256:[0-9a-f]{64}$/.test(manifest.digest || '')) fail(`manifest.digest malformed: ${manifest.digest}`);

const digest = sha256(bundle);
if (`sha256:${digest}` !== manifest.digest) {
  fail(`digest mismatch: file is sha256:${digest}, manifest says ${manifest.digest}`);
}

if (existsSync(versionPath)) {
  const v = readFileSync(versionPath, 'utf8').trim();
  if (v !== manifest.version) fail(`version file (${v}) does not match manifest.version (${manifest.version})`);
}

// Required runtime entries (tar entries may be prefixed with "./" or not).
const hasBinEntry = entries.some(e => e === '.bin/dsh' || e === './.bin/dsh' || e.endsWith('/.bin/dsh'));
const hasPkgEntry = entries.some(e => e === 'package.json' || e === './package.json' || e === '@deepseek-ai/dsh/package.json' || e === './@deepseek-ai/dsh/package.json');

if (!hasBinEntry) fail('required entry missing from tarball: .bin/dsh');
if (!hasPkgEntry) fail('required entry missing from tarball: @deepseek-ai/dsh/package.json');

// AppleDouble / .DS_Store must be excluded.
const bad = entries.filter(e => {
  const base = e.split('/').pop();
  return base.startsWith('._') || base === '.DS_Store';
});
if (bad.length > 0) fail(`tarball contains excluded files (AppleDouble/.DS_Store): ${bad.slice(0, 5).join(', ')}`);

console.log(`bundle verified: ${manifest.triple} v${manifest.version}, ${(st.size / 1024 / 1024).toFixed(1)} MB, digest ${manifest.digest.slice(0, 20)}...`);
