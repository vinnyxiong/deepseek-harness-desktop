#!/usr/bin/env node
// Fetch a pre-built dsh-bundle (linux-x64-gnu) for embedding into a non-Linux
// (macOS / Windows) desktop package.
//
// Priority order:
//   1. DSH_BUNDLE_DIR   – directory already containing dsh-bundle.tar.gz + manifest
//   2. --from <file>    – tarball on local disk (manifest expected alongside it)
//   3. GitHub Actions artifact download via GITHUB_RUN_ID / artifact name
//   4. Error with instructions
//
// Usage:
//   node scripts/fetch-remote-bundle.mjs [--from <path>] [--force]

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, copyFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { assertBundleNatives } = createRequire(import.meta.url)('./build-dsh-bundle.cjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const BUNDLE = 'dsh-bundle.tar.gz';
const VERSION = 'dsh-bundle.version';
const MANIFEST = 'dsh-bundle.manifest.json';

function parseArgs(argv) {
  const args = { force: false, from: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--from') args.from = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function sha256(path) {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(65536);
  const fd = openSync(path, 'r');
  try {
    let n;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

function copyBundleFromDir(sourceDir, { force }) {
  // Fetching from the repo root is a no-op copy that only rewrites the manifest
  // to match whatever tarball already sits there -- which is how a locally built
  // macOS bundle ends up wearing a linux-x64-gnu manifest.
  if (resolve(sourceDir) === root) {
    throw new Error(
      `Refusing to fetch ${BUNDLE} from the repo root (${root}): there is nothing to fetch, ` +
      'and the manifest would simply be relabelled to match the tarball already present. ' +
      'Point DSH_BUNDLE_DIR at a directory holding a bundle built on a Linux x64 glibc host.'
    );
  }

  const srcBundle = join(sourceDir, BUNDLE);
  const srcManifest = join(sourceDir, MANIFEST);
  const srcVersion = join(sourceDir, VERSION);

  if (!existsSync(srcBundle)) throw new Error(`Bundle not found at ${srcBundle}`);
  if (!existsSync(srcManifest)) throw new Error(`Manifest not found at ${srcManifest}`);

  let manifest;
  try { manifest = JSON.parse(readFileSync(srcManifest, 'utf8')); } catch (e) {
    throw new Error(`Failed to parse manifest at ${srcManifest}: ${e.message}`);
  }

  if (manifest.triple !== 'linux-x64-gnu') {
    throw new Error(`Refusing to embed bundle for triple ${manifest.triple}; expected linux-x64-gnu`);
  }

  // The manifest is just a label: a stale tarball left in the source directory
  // (say, one built on this macOS host before the build-host guard existed)
  // still claims linux-x64-gnu and would be embedded, digest and all. Check the
  // tarball itself for the linux native modules before trusting it.
  assertBundleNatives(srcBundle);

  // Verify digest matches the file. When the user explicitly provides a local
  // bundle (DSH_BUNDLE_DIR or --from), auto-correct the manifest if the digest
  // doesn't match — the bundle file is the source of truth.
  const digest = `sha256:${sha256(srcBundle)}`;
  if (digest !== manifest.digest) {
    console.warn(`Bundle digest mismatch: file is ${digest}, manifest says ${manifest.digest}. Updating manifest.`);
    console.warn('(The tarball wins. It passed the linux-x64-gnu native module check above.)');
    manifest.digest = digest;
    writeFileSync(srcManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const destBundle = join(root, BUNDLE);
  const destManifest = join(root, MANIFEST);
  const destVersion = join(root, VERSION);

  if (!force && existsSync(destBundle) && existsSync(destManifest)) {
    try {
      const existing = JSON.parse(readFileSync(destManifest, 'utf8'));
      if (existing.digest === manifest.digest) {
        // Always sync the version file to the manifest — the version file is
        // gitignored, so a git pull that updates the manifest won't update it.
        if (!existsSync(destVersion) || readFileSync(destVersion, 'utf8').trim() !== manifest.version) {
          writeFileSync(destVersion, `${manifest.version}\n`);
        }
        console.log(`${BUNDLE} is up to date (${manifest.triple}, version ${manifest.version})`);
        return { cached: true, manifest };
      }
    } catch { /* fall through and overwrite */ }
  }

  copyFileSync(srcBundle, destBundle);
  copyFileSync(srcManifest, destManifest);
  if (existsSync(srcVersion)) copyFileSync(srcVersion, destVersion);
  else writeFileSync(destVersion, `${manifest.version}\n`);

  console.log(`Copied ${BUNDLE} (${manifest.triple}, version ${manifest.version}, ${(statSync(destBundle).size / 1024 / 1024).toFixed(1)} MB)`);
  return { cached: false, manifest };
}

function downloadViaGh(artifactName, { force }) {
  if (process.env.CI !== 'true') {
    throw new Error(
      'Refusing to download from GitHub outside CI. Set DSH_BUNDLE_DIR to a local ' +
      'directory containing the pre-built bundle, or pass --from <path>.'
    );
  }
  const tmpDir = join(root, '.dsh-bundle-download');
  mkdirSync(tmpDir, { recursive: true });
  const gh = process.env.GH_BIN || 'gh';
  const runId = process.env.GITHUB_RUN_ID;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!runId || !repo) {
    throw new Error('GITHUB_RUN_ID and GITHUB_REPOSITORY are required to download bundle via gh');
  }
  console.log(`Downloading artifact "${artifactName}" from ${repo} run ${runId}...`);
  const result = spawnSync(gh, [
    'run', 'download', runId,
    '--repo', repo,
    '--name', artifactName,
    '--dir', tmpDir,
  ], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`gh run download failed with exit code ${result.status}`);
  }
  return copyBundleFromDir(tmpDir, { force });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.DSH_BUNDLE_DIR) {
    return copyBundleFromDir(resolve(process.env.DSH_BUNDLE_DIR), args);
  }
  if (args.from) {
    const from = resolve(args.from);
    const st = statSync(from);
    const dir = st.isDirectory() ? from : dirname(from);
    return copyBundleFromDir(dir, args);
  }
  // CI: attempt to download from GitHub Actions.
  return downloadViaGh('dsh-remote-bundle-linux-x64-gnu', args);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
