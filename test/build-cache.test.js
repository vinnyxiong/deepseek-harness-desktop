const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildBundle, contentFingerprint, validateBundle } = require('../scripts/build-dsh-bundle.cjs');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bundle-test-'));
  const modules = join(root, 'node_modules');
  mkdirSync(join(modules, '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(join(modules, '@deepseek-ai', 'dsh', 'package.json'), '{"version":"1.2.3"}');
  writeFileSync(join(modules, '@deepseek-ai', 'dsh', 'index.js'), 'one');
  mkdirSync(join(modules, 'electron'), { recursive: true });
  writeFileSync(join(modules, 'electron', 'ignored'), 'one');
  return root;
}

function fakeTar(calls, fail = false) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '-czf') {
      writeFileSync(args[1], 'archive');
      if (fail) throw new Error('tar failed');
    }
  };
}

test('bundle cache hits, force rebuilds, and content invalidates', () => {
  const root = fixture();
  const calls = [];
  assert.equal(buildBundle({ projectRoot: root, exec: fakeTar(calls) }).cached, false);
  assert.equal(buildBundle({ projectRoot: root, exec: fakeTar(calls) }).cached, true);
  assert.equal(buildBundle({ projectRoot: root, force: true, exec: fakeTar(calls) }).cached, false);
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'index.js'), 'two');
  assert.equal(buildBundle({ projectRoot: root, exec: fakeTar(calls) }).cached, false);
});

test('bundle fingerprint excludes dev packages', () => {
  const root = fixture();
  const before = contentFingerprint(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'electron', 'ignored'), 'changed');
  assert.equal(contentFingerprint(join(root, 'node_modules')), before);
});

test('failed bundle leaves existing output and cleans temporary file', () => {
  const root = fixture();
  writeFileSync(join(root, 'dsh-bundle.tar.gz'), 'good');
  assert.throws(() => buildBundle({ projectRoot: root, force: true, exec: fakeTar([], true) }), /tar failed/);
  assert.equal(readFileSync(join(root, 'dsh-bundle.tar.gz'), 'utf8'), 'good');
  assert.equal(readdirSync(root).some((name) => name.includes('.tmp-')), false);
  assert.equal(validateBundle(join(root, 'missing'), () => {}), false);
  assert.equal(existsSync(join(root, '.dsh-bundle.cache.json')), false);
});
