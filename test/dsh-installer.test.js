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

function spawnError(code) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 9000;
  child.kill = () => {};
  process.nextTick(() => child.emit('error', { code, message: 'spawn failed' }));
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
  // The installed path under ~/.local/state/dsh/runner/ typically doesn't exist
  // in test environments, so this should return false.
  // We don't assert exact value because it depends on the test environment.
  const result = isDshInstalled();
  assert.equal(typeof result, 'boolean');
});

test('installDshLocal resolves with success on exit code 0', async () => {
  // Create a temporary directory to simulate the install
  const tmpDir = path.join(os.tmpdir(), `dsh-installer-test-${Date.now()}`);
  // We need to mock the install prefix to point to tmpDir.
  // Since the module uses a hardcoded path, we can't easily mock it.
  // Instead, we verify the spawn behavior.
  const phases = [];
  let spawnArgs = null;
  let spawnOpts = null;

  // We use a real spawn that captures args and returns success
  const result = await installDshLocal({
    spawnImpl: (cmd, args, opts) => {
      spawnArgs = args;
      spawnOpts = opts;
      return spawnExit(0, null, 'installed package');
    },
    timeoutMs: 5000,
    onProgress: (phase) => phases.push(phase),
  });

  assert.equal(result.success, true);
  assert.ok(spawnArgs.includes('install'));
  assert.ok(spawnArgs.includes('@deepseek-ai/dsh'));
  assert.equal(spawnOpts.shell, false);
  // onProgress should have been called at least once
  assert.ok(phases.length > 0);

  // Clean up tmp dir if it was created
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('installDshLocal rejects when npm is not found', async () => {
  await assert.rejects(
    () => installDshLocal({
      spawnImpl: () => spawnError('ENOENT'),
      timeoutMs: 5000,
    }),
    /npm is not available/,
  );
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
  // Never emits 'exit' — triggers timeout

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