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

test('installDshLocal finds npm and spawns install', async () => {
  const phases = [];
  let spawnCmd = null;
  let spawnArgs = null;
  let spawnOpts = null;

  const result = await installDshLocal({
    spawnImpl: (cmd, args, opts) => {
      spawnCmd = cmd;
      spawnArgs = args;
      spawnOpts = opts;
      return spawnExit(0, null, 'added 200 packages');
    },
    timeoutMs: 5000,
    onProgress: (phase) => phases.push(phase),
  });

  assert.equal(result.success, true);
  // Should be an absolute npm path
  assert.ok(spawnCmd.endsWith('npm'), `expected npm path, got ${spawnCmd}`);
  assert.ok(spawnArgs.includes('install'));
  assert.ok(spawnArgs.includes('@deepseek-ai/dsh'));
  assert.equal(spawnOpts.shell, false);
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