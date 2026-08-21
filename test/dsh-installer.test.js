const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { getInstalledDshBinPath, installDshLocal, isDshInstalled } = require('../src/main/dsh-installer');

function spawnExit(code, signal, stdoutText = '', stderrText = '') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 9000;
  child.kill = () => {};
  process.nextTick(() => {
    if (stdoutText) child.stdout.write(stdoutText);
    if (stderrText) child.stderr.write(stderrText);
    child.emit('exit', code, signal);
  });
  return child;
}

test('getInstalledDshBinPath returns path under .local/state/dsh', () => {
  const binPath = getInstalledDshBinPath();
  assert.ok(binPath.includes('.local'));
  assert.ok(binPath.includes('state'));
  assert.ok(binPath.includes('dsh'));
  assert.ok(binPath.includes('node_modules'));
  assert.ok(binPath.includes('@deepseek-ai'));
  assert.ok(binPath.endsWith('bin.js'));
});

test('isDshInstalled returns false when DSH is not installed', () => {
  const result = isDshInstalled();
  assert.equal(typeof result, 'boolean');
});

test('installDshLocal finds node and npm and spawns install with correct PATH', async () => {
  const phases = [];
  let spawnCmd = null;
  let spawnEnv = null;

  const result = await installDshLocal({
    spawnImpl: (cmd, args, opts) => {
      spawnCmd = cmd;
      spawnEnv = opts.env;
      return spawnExit(0, null, 'added 200 packages');
    },
    timeoutMs: 5000,
    onProgress: (phase) => phases.push(phase),
  });

  assert.equal(result.success, true);
  assert.ok(spawnCmd.endsWith('npm'), `expected npm path, got ${spawnCmd}`);
  // PATH should be augmented with node's bin directory
  const pathDirs = (spawnEnv.PATH || '').split(path.delimiter);
  assert.ok(pathDirs[0].includes('bin'), `first PATH entry should be node bin dir, got ${pathDirs[0]}`);
  assert.ok(phases.length > 0);
});

test('installDshLocal rejects on non-zero exit code', async () => {
  await assert.rejects(
    () => installDshLocal({
      spawnImpl: () => spawnExit(1, null, '', 'npm ERR! some error'),
      timeoutMs: 5000,
    }),
    /npm install failed with exit code 1/,
  );
});

test('installDshLocal rejects on timeout', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 9001;
  child.kill = () => {};

  await assert.rejects(
    () => installDshLocal({
      spawnImpl: () => child,
      timeoutMs: 50,
    }),
    /timed out/,
  );
});

test('installDshLocal rejects on permission error', async () => {
  await assert.rejects(
    () => installDshLocal({
      spawnImpl: () => spawnExit(1, null, '', 'EACCES: permission denied'),
      timeoutMs: 5000,
    }),
    /Permission denied/,
  );
});

test('installDshLocal rejects on disk full error', async () => {
  await assert.rejects(
    () => installDshLocal({
      spawnImpl: () => spawnExit(1, null, '', 'ENOSPC: No space left on device'),
      timeoutMs: 5000,
    }),
    /Not enough disk space/,
  );
});