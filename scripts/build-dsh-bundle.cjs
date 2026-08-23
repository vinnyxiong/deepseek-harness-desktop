// Build dsh-bundle.tar.gz for SSH transfer to remote hosts.
// Usage: node scripts/build-dsh-bundle.cjs [--force]

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} = require('node:fs');
const { basename, join, relative, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const CACHE_VERSION = 1;
const OUTPUT_NAME = 'dsh-bundle.tar.gz';
const VERSION_NAME = 'dsh-bundle.version';
const METADATA_NAME = '.dsh-bundle.cache.json';
const EXCLUDE = new Set([
  'electron', 'electron-builder', 'electron-updater', 'sharp', 'png-to-ico',
  '.cache', '.package-lock.json',
]);

function isExcluded(relativePath) {
  return relativePath.split(sep).some((part) => EXCLUDE.has(part));
}

function listInputs(directory, base = directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    const rel = relative(base, path);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) result.push(...listInputs(path, base));
    else result.push({ path, relativePath: rel });
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

function atomicWrite(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    writeFileSync(temp, data);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function buildBundle({ projectRoot = root, force = false, exec = execFileSync } = {}) {
  const modules = join(projectRoot, 'node_modules');
  const output = join(projectRoot, OUTPUT_NAME);
  const versionPath = join(projectRoot, VERSION_NAME);
  const metadataPath = join(projectRoot, METADATA_NAME);
  const version = JSON.parse(readFileSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  const fingerprint = contentFingerprint(modules);
  const metadata = readMetadata(metadataPath);

  if (!force && metadata?.cacheVersion === CACHE_VERSION && metadata.fingerprint === fingerprint
      && readFileSafe(versionPath) === `${version}\n` && validateBundle(output, exec)) {
    console.log(`dsh-bundle.tar.gz is up to date (version ${version})`);
    return { cached: true, fingerprint, version };
  }

  const temp = `${output}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const tarArgs = ['-czf', temp, '-C', modules, ...[...EXCLUDE].flatMap((item) => ['--exclude', item]), '.'];
  console.log('Creating dsh-bundle.tar.gz...');
  try {
    exec('tar', tarArgs, { stdio: 'inherit' });
    if (!validateBundle(temp, exec)) throw new Error('generated bundle failed validation');
    renameSync(temp, output);
    atomicWrite(versionPath, `${version}\n`);
    atomicWrite(metadataPath, `${JSON.stringify({ cacheVersion: CACHE_VERSION, fingerprint, version }, null, 2)}\n`);
  } finally { rmSync(temp, { force: true }); }

  const size = statSync(output).size;
  console.log(`dsh-bundle.tar.gz created (version ${version}, ${(size / 1024 / 1024).toFixed(1)} MB)`);
  return { cached: false, fingerprint, version };
}

function readFileSafe(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

if (require.main === module) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== '--force');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  buildBundle({ force: process.argv.includes('--force') });
}

module.exports = { atomicWrite, buildBundle, contentFingerprint, isExcluded, listInputs, readMetadata, validateBundle };
