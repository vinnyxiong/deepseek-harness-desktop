import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIcons } from '../scripts/generate-icons.mjs';
import { generateMacIcon } from '../scripts/generate-mac-icon.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'icon-cache-test-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', 'icon.svg'), '<svg/>');
  return root;
}
function fakeSharp(counter, failAt = -1) {
  return () => ({ resize() { return this; }, png() { return this; }, async toBuffer() {
    counter.count += 1;
    if (counter.count === failAt) throw new Error('render failed');
    return Buffer.from(`png-${counter.count}`);
  } });
}

test('icon cache hits and source changes invalidate it', async () => {
  const root = await fixture();
  const counter = { count: 0 };
  const options = { projectDir: root, sharpFactory: fakeSharp(counter), icoFactory: async () => Buffer.from('ico') };
  assert.equal((await generateIcons(options)).cached, false);
  assert.equal((await generateIcons(options)).cached, true);
  assert.equal(counter.count, 8);
  assert.equal((await generateIcons({ ...options, force: true })).cached, false);
  await writeFile(join(root, 'assets', 'icon.svg'), '<svg>changed</svg>');
  assert.equal((await generateIcons(options)).cached, false);
});

test('icon render failure does not replace later outputs or metadata', async () => {
  const root = await fixture();
  await assert.rejects(generateIcons({ projectDir: root, sharpFactory: fakeSharp({ count: 0 }, 2), icoFactory: async () => Buffer.from('ico') }), /render failed/);
  assert.equal((await readdir(join(root, 'build'))).some((name) => name.includes('.tmp-')), false);
  await assert.rejects(readFile(join(root, 'build', '.icons.cache.json')));
});

test('mac icon cache, force, invalidation, and failed atomic output', async () => {
  const root = await fixture();
  await mkdir(join(root, 'build'), { recursive: true });
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) await writeFile(join(root, 'build', `icon-${size}.png`), `png-${size}`);
  let runs = 0;
  const runner = async (_command, args) => { runs += 1; await writeFile(args[3], `icns-${runs}`); };
  assert.equal((await generateMacIcon({ projectDir: root, platform: 'darwin', runner })).cached, false);
  assert.equal((await generateMacIcon({ projectDir: root, platform: 'darwin', runner })).cached, true);
  await generateMacIcon({ projectDir: root, platform: 'darwin', runner, force: true });
  await writeFile(join(root, 'build', 'icon-16.png'), 'changed');
  await generateMacIcon({ projectDir: root, platform: 'darwin', runner });
  assert.equal(runs, 3);
  const prior = await readFile(join(root, 'build', 'icon.icns'), 'utf8');
  await assert.rejects(generateMacIcon({ projectDir: root, platform: 'darwin', force: true, runner: async () => { throw new Error('iconutil failed'); } }), /iconutil failed/);
  assert.equal(await readFile(join(root, 'build', 'icon.icns'), 'utf8'), prior);
  assert.equal((await readdir(join(root, 'build'))).some((name) => name.includes('.tmp-')), false);
});
