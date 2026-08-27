// Build dsh-bundle.tar.gz for SSH transfer to remote Linux x64 glibc hosts.
// This bundle is cross-platform: it MUST be built on a Linux x64 glibc host so
// that native modules match the target runtime. macOS and Windows CI jobs
// download a pre-built artifact instead of rebuilding the bundle locally.
//
// Usage: node scripts/build-dsh-bundle.cjs [--force]

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} = require('node:fs');
const { basename, join, relative, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const CACHE_VERSION = 3;
const MANIFEST_SCHEMA = 'dsh-remote-bundle';
const MANIFEST_SCHEMA_VERSION = 1;
const TARGET_PLATFORM = 'linux';
const TARGET_ARCH = 'x64';
const TARGET_LIBC = 'gnu';
const TARGET_TRIPLE = `${TARGET_PLATFORM}-${TARGET_ARCH}-${TARGET_LIBC}`;

const OUTPUT_NAME = 'dsh-bundle.tar.gz';
const VERSION_NAME = 'dsh-bundle.version';
const MANIFEST_NAME = 'dsh-bundle.manifest.json';
const METADATA_NAME = '.dsh-bundle.cache.json';

// Dev-only packages and files that never need to be sent to a remote host.
// AppleDouble / resource-fork files (._*) and .DS_Store are produced by macOS
// tar/zip operations and must never leak into the bundle.
const EXCLUDE = new Set([
  'electron', 'electron-builder', 'electron-updater', 'png-to-ico',
  '.cache', '.package-lock.json',
]);

const EXCLUDE_PREFIXES = ['._'];
const EXCLUDE_NAMES = new Set(['.DS_Store']);

// Native modules that MUST be present inside a linux-x64-gnu bundle.
// A bundle built on macOS/Windows -- or one whose prebuilds were pruned by
// @electron/rebuild -- still extracts cleanly and still passes `dsh --version`,
// because the CLI only touches these modules once `dsh web` boots the loader.
// Assert their presence here so a mislabelled bundle can never be shipped.
const REQUIRED_NATIVE_ENTRIES = Object.freeze([
  'node-pty/prebuilds/linux-x64/pty.node',
  '@koromix/koffi-linux-x64/linux_x64/koffi.node',
]);

// Entries that prove the bundle was produced on a non-Linux host. koffi resolves
// its binary through the optional dependency matching the *install* platform, so
// a darwin/win32 koffi package inside a "linux" bundle is a build-host mistake.
const FOREIGN_NATIVE_PATTERNS = Object.freeze([
  /^@koromix\/koffi-(darwin|win32|freebsd|openbsd)-/,
]);

function normalizeTarEntry(entry) {
  return entry.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

function listTarEntries(path, exec = execFileSync) {
  const output = exec('tar', ['-tzf', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\n').map(normalizeTarEntry).filter(Boolean);
}

// Returns { missing, foreign } for a list of tar entries.
function inspectBundleNatives(entries) {
  const set = new Set(entries.map(normalizeTarEntry));
  const missing = REQUIRED_NATIVE_ENTRIES.filter(required => !set.has(required));
  const foreign = [...set].filter(entry => FOREIGN_NATIVE_PATTERNS.some(re => re.test(entry)));
  return { missing, foreign };
}

// Throws when the tarball does not look like a usable linux-x64-gnu runner.
function assertBundleNatives(path, exec = execFileSync) {
  const { missing, foreign } = inspectBundleNatives(listTarEntries(path, exec));
  if (missing.length === 0 && foreign.length === 0) return;
  const lines = [`bundle is not a usable ${TARGET_TRIPLE} runner:`];
  for (const entry of missing) lines.push(`  - missing native module: ${entry}`);
  for (const entry of [...new Set(foreign.map(e => e.split('/').slice(0, 2).join('/')))]) {
    lines.push(`  - foreign native package for another platform: ${entry}`);
  }
  lines.push('', 'The bundle must be built by npm run build:bundle on a Linux x64 glibc host.');
  const error = new Error(lines.join('\n'));
  error.code = 'INVALID_BUNDLE_CONTENTS';
  error.missing = missing;
  error.foreign = foreign;
  throw error;
}

// Non-throwing variant used to invalidate a cached bundle that predates the
// native-module assertion.
function hasBundleNatives(path, exec = execFileSync) {
  try {
    assertBundleNatives(path, exec);
    return true;
  } catch { return false; }
}

function isExcluded(relPath) {
  const parts = relPath.split(sep);
  for (const part of parts) {
    if (EXCLUDE.has(part)) return true;
    if (EXCLUDE_NAMES.has(part)) return true;
    for (const prefix of EXCLUDE_PREFIXES) {
      if (part.startsWith(prefix)) return true;
    }
  }
  return false;
}

function listInputs(directory, base = directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const rel = relative(base, path);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) result.push(...listInputs(path, base));
    else if (entry.isFile() || entry.isSymbolicLink()) result.push({ path, relativePath: rel });
  }
  return result;
}

function contentFingerprint(directory) {
  const hash = crypto.createHash('sha256');
  for (const file of listInputs(directory)) {
    const stat = lstatSync(file.path);
    hash.update(file.relativePath).update('\0').update(String(stat.mode)).update('\0');
    if (stat.isSymbolicLink()) hash.update(readFileSync(file.path));
    else hash.update(readFileSync(file.path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function readMetadata(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function validateBundle(path, exec = execFileSync) {
  try {
    if (!statSync(path).isFile() || statSync(path).size === 0) return false;
    exec('tar', ['-tzf', path], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// Detect the build host's platform/arch/libc and enforce that it matches the
// bundle target. This prevents accidentally producing a macOS-arm64 bundle and
// shipping it to a Linux x64 host.
function detectBuildHost(exec = execFileSync) {
  const platform = process.platform;
  const arch = process.arch;
  let libc = 'unknown';
  if (platform === 'linux') {
    try {
      const lddOut = exec('ldd', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      // musl ldd reports "musl libc"; glibc ldd starts with "ldd (GNU libc)" or similar.
      if (/musl/i.test(lddOut)) libc = 'musl';
      else if (/GNU libc|glibc/i.test(lddOut)) libc = 'gnu';
    } catch {
      // Some environments (e.g. Alpine without ldd wrapper) may fail; fall through.
    }
  }
  return { platform, arch, libc };
}

function validateBuildHost(host = detectBuildHost()) {
  const errors = [];
  if (host.platform !== TARGET_PLATFORM) {
    errors.push(`unsupported build platform "${host.platform}" (required: ${TARGET_PLATFORM})`);
  }
  if (host.arch !== TARGET_ARCH) {
    errors.push(`unsupported build arch "${host.arch}" (required: ${TARGET_ARCH})`);
  }
  if (host.libc !== TARGET_LIBC) {
    errors.push(`unsupported build libc "${host.libc}" (required: ${TARGET_LIBC})`);
  }
  return errors;
}

function sha256File(path) {
  const hash = crypto.createHash('sha256');
  const { closeSync: close, readSync: read } = require('node:fs');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    let bytes;
    while ((bytes = read(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally { close(fd); }
  return hash.digest('hex');
}

function atomicWrite(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temp, data);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function buildManifest({ version, digest }) {
  return {
    schema: MANIFEST_SCHEMA,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version,
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
    libc: TARGET_LIBC,
    triple: TARGET_TRIPLE,
    digest: `sha256:${digest}`,
    digestAlgorithm: 'sha256',
    createdAt: new Date().toISOString(),
  };
}

function buildBundle({ projectRoot = root, force = false, exec = execFileSync, detectHost = detectBuildHost } = {}) {
  // Validate build host before doing any work.
  const host = detectHost(exec);
  const hostErrors = validateBuildHost(host);
  if (hostErrors.length > 0) {
    const message = [
      `Cannot build ${TARGET_TRIPLE} DSH bundle on this host (${host.platform}-${host.arch}-${host.libc}):`,
      ...hostErrors.map(e => `  - ${e}`),
      '',
      'The remote DSH bundle contains native modules and must be built on Linux x64 with glibc.',
      'macOS and Windows CI jobs download the pre-built Linux bundle artifact instead of building locally.',
    ].join('\n');
    const error = new Error(message);
    error.code = 'UNSUPPORTED_BUILD_HOST';
    error.host = host;
    throw error;
  }

  const modules = join(projectRoot, 'node_modules');
  const output = join(projectRoot, OUTPUT_NAME);
  const versionPath = join(projectRoot, VERSION_NAME);
  const manifestPath = join(projectRoot, MANIFEST_NAME);
  const metadataPath = join(projectRoot, METADATA_NAME);

  const dshPkgPath = join(modules, '@deepseek-ai', 'dsh', 'package.json');
  const version = JSON.parse(readFileSync(dshPkgPath, 'utf8')).version;
  const fingerprint = contentFingerprint(modules);
  const metadata = readMetadata(metadataPath);

  // Cache is valid when fingerprint matches, version file matches, manifest is
  // for the same triple and digest matches the file, and the tarball is intact.
  let cacheHit = false;
  if (!force && metadata?.cacheVersion === CACHE_VERSION
      && metadata.fingerprint === fingerprint
      && metadata.triple === TARGET_TRIPLE
      && readFileSafe(versionPath) === `${version}\n`) {
    const existingManifest = readMetadata(manifestPath);
    if (existingManifest
        && existingManifest.triple === TARGET_TRIPLE
        && existingManifest.digest === `sha256:${sha256File(output)}`
        && validateBundle(output, exec)
        && hasBundleNatives(output, exec)) {
      cacheHit = true;
    }
  }

  if (cacheHit) {
    console.log(`${OUTPUT_NAME} is up to date (${TARGET_TRIPLE}, version ${version})`);
    return { cached: true, fingerprint, version, triple: TARGET_TRIPLE };
  }

  const temp = `${output}.tmp-${process.pid}-${crypto.randomUUID()}`;
  // Exclude dev packages, AppleDouble resource forks, .DS_Store, and npm caches.
  const tarExcludes = [
    ...[...EXCLUDE].flatMap(item => ['--exclude', item]),
    '--exclude', '._*',
    '--exclude', '.DS_Store',
  ];
  console.log(`Creating ${OUTPUT_NAME} for ${TARGET_TRIPLE}...`);
  try {
    exec('tar', ['-czf', temp, '-C', modules, ...tarExcludes, '.'], { stdio: 'inherit' });
    if (!validateBundle(temp, exec)) throw new Error('generated bundle failed validation');
    // node_modules on this host may itself be missing the linux prebuilds (for
    // example after @electron/rebuild replaced them); refuse to publish such a
    // bundle instead of letting it fail hours later on the remote host.
    assertBundleNatives(temp, exec);

    const digest = sha256File(temp);
    const manifest = buildManifest({ version, digest });

    renameSync(temp, output);
    atomicWrite(versionPath, `${version}\n`);
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    atomicWrite(metadataPath, `${JSON.stringify({
      cacheVersion: CACHE_VERSION,
      fingerprint,
      version,
      triple: TARGET_TRIPLE,
      digest,
      manifestCreatedAt: manifest.createdAt,
    }, null, 2)}\n`);
  } finally { rmSync(temp, { force: true }); }

  const size = statSync(output).size;
  console.log(`${OUTPUT_NAME} created (${TARGET_TRIPLE}, version ${version}, ${(size / 1024 / 1024).toFixed(1)} MB)`);
  return { cached: false, fingerprint, version, triple: TARGET_TRIPLE };
}

module.exports = {
  FOREIGN_NATIVE_PATTERNS,
  MANIFEST_NAME,
  MANIFEST_SCHEMA,
  MANIFEST_SCHEMA_VERSION,
  METADATA_NAME,
  OUTPUT_NAME,
  REQUIRED_NATIVE_ENTRIES,
  TARGET_ARCH,
  TARGET_LIBC,
  TARGET_PLATFORM,
  TARGET_TRIPLE,
  VERSION_NAME,
  assertBundleNatives,
  atomicWrite,
  buildBundle,
  buildManifest,
  contentFingerprint,
  detectBuildHost,
  hasBundleNatives,
  inspectBundleNatives,
  isExcluded,
  listInputs,
  listTarEntries,
  normalizeTarEntry,
  readMetadata,
  sha256File,
  validateBuildHost,
  validateBundle,
};

// --- CLI entry point ---
if (require.main === module) {
  const force = process.argv.includes('--force');
  try {
    buildBundle({ force });
  } catch (err) {
    const known = err.code === 'UNSUPPORTED_BUILD_HOST' || err.code === 'INVALID_BUNDLE_CONTENTS';
    console.error(known ? err.message : err.stack || err.message);
    process.exit(1);
  }
}
