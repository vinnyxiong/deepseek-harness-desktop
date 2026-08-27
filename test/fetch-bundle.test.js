const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { REQUIRED_NATIVE_ENTRIES } = require('../scripts/build-dsh-bundle.cjs');

const script = () => import('../scripts/fetch-remote-bundle.mjs');

function sha256(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

// Build a real tar.gz carrying the linux native modules, plus a filler file so
// callers can produce two bundles with different digests.
function makeBundleDir({ filler = 'a', natives = REQUIRED_NATIVE_ENTRIES, version = '1.2.3' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fetch-test-'));
  const staged = join(dir, 'staged');
  for (const entry of natives) {
    const full = join(staged, entry);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, 'native');
  }
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, 'filler'), filler);
  const tarball = join(dir, 'dsh-bundle.tar.gz');
  execFileSync('tar', ['-czf', tarball, '-C', staged, '.']);
  writeFileSync(join(dir, 'dsh-bundle.manifest.json'), JSON.stringify({
    schema: 'dsh-remote-bundle', schemaVersion: 1, version,
    platform: 'linux', arch: 'x64', libc: 'gnu', triple: 'linux-x64-gnu',
    digest: sha256(tarball), digestAlgorithm: 'sha256', createdAt: '2026-01-01T00:00:00.000Z',
  }, null, 2));
  writeFileSync(join(dir, 'dsh-bundle.version'), `${version}\n`);
  return dir;
}

// The manifest is tracked in git, the tarball is gitignored. After a pull, a
// checkout can hold a correct manifest next to a completely unrelated tarball
// -- the exact state that shipped a macOS bundle to a Linux host.
test('copyBundleFromDir replaces a stale tarball that its manifest does not describe', async () => {
  const { copyBundleFromDir } = await script();
  const source = makeBundleDir({ filler: 'good' });
  const dest = makeBundleDir({ filler: 'stale' });
  try {
    // Simulate `git pull`: dest manifest now describes the source tarball,
    // while dest still holds the stale one.
    const staleDigest = sha256(join(dest, 'dsh-bundle.tar.gz'));
    writeFileSync(join(dest, 'dsh-bundle.manifest.json'), readFileSync(join(source, 'dsh-bundle.manifest.json')));

    const result = copyBundleFromDir(source, { force: false, destDir: dest });

    assert.equal(result.cached, false);
    const copied = sha256(join(dest, 'dsh-bundle.tar.gz'));
    assert.notEqual(copied, staleDigest);
    assert.equal(copied, sha256(join(source, 'dsh-bundle.tar.gz')));
    assert.equal(JSON.parse(readFileSync(join(dest, 'dsh-bundle.manifest.json'), 'utf8')).digest, copied);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('copyBundleFromDir skips the copy when the destination tarball already matches', async () => {
  const { copyBundleFromDir } = await script();
  const source = makeBundleDir({ filler: 'same' });
  const dest = makeBundleDir({ filler: 'other' });
  try {
    copyBundleFromDir(source, { force: false, destDir: dest });
    const result = copyBundleFromDir(source, { force: false, destDir: dest });
    assert.equal(result.cached, true);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('copyBundleFromDir refuses to fetch a directory from itself', async () => {
  const { copyBundleFromDir } = await script();
  const dir = makeBundleDir();
  try {
    assert.throws(
      () => copyBundleFromDir(dir, { force: false, destDir: dir }),
      /Refusing to fetch/,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('copyBundleFromDir rejects a source bundle without linux natives', async () => {
  const { copyBundleFromDir } = await script();
  const source = makeBundleDir({ natives: ['@koromix/koffi-darwin-arm64/macos_arm64/koffi.node'] });
  const dest = makeBundleDir();
  try {
    assert.throws(
      () => copyBundleFromDir(source, { force: false, destDir: dest }),
      err => err.code === 'INVALID_BUNDLE_CONTENTS',
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
