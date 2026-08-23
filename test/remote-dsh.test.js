const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { buildRemoteSshArgs, checkRemoteDshInstalled, discoverRemoteDsh, getRemoteDshLog, getRemoteDshProcessDetails, getRemoteDshStatus, getRemoteDshVersion, startRemoteDsh, stopRemoteDsh, transferRemoteDsh, updateRemoteDsh } = require('../src/main/remote-dsh');

const settings = {
  host: '10.37.117.240', username: 'xiongyuanwen', sshPort: 22,
  localPort: 3080, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new',
};

function spawnWithOutput(stdoutText, exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 9000; child.exitCode = null; child.signalCode = null;
  child.stdin = new PassThrough();
  child.kill = () => {};
  process.nextTick(() => { if (stdoutText) child.stdout.write(stdoutText); child.emit('exit', exitCode, null); });
  return child;
}

test('buildRemoteSshArgs produces args without tunnel flags', () => {
  const args = buildRemoteSshArgs(settings);
  assert.ok(!args.includes('-N'));
  assert.ok(!args.includes('-T'));
  assert.ok(!args.includes('-n'));
  assert.ok(!args.includes('-L'));
  assert.ok(!args.some(a => a.includes('LocalForward')));
  assert.ok(args.includes('BatchMode=yes'));
  assert.deepEqual(args.slice(-4), ['-p', '22', '--', 'xiongyuanwen@10.37.117.240']);
});

test('buildRemoteSshArgs includes identity file when set', () => {
  const args = buildRemoteSshArgs({ ...settings, identityFile: '/tmp/id', hostKeyPolicy: 'strict' });
  assert.ok(args.includes('/tmp/id'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
});

// --- startRemoteDsh ---


test('discoverRemoteDsh reads persistent managed metadata', async () => {
  const result = await discoverRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('PID:7777 PORT:45678') });
  assert.deepEqual(result, { running: true, pid: 7777, port: 45678 });
});

test('discoverRemoteDsh passively parses metadata without sourcing it', async () => {
  let command;
  const result = await discoverRemoteDsh(settings, {
    spawnImpl: (_ssh, args) => {
      command = args.at(-1);
      return spawnWithOutput('STOPPED');
    },
  });
  assert.deepEqual(result, { running: false, pid: null, port: null });
  assert.ok(command.includes('while IFS= read -r LINE'));
  assert.ok(command.includes('PID=*'));
  assert.ok(command.includes('PORT=*'));
  assert.ok(command.includes('*[!0-9]*'));
  assert.ok(!command.includes(`. ~/.local/state/dsh/runner/desktop-managed.env`));
  assert.ok(!command.includes('source '));
});

test('discoverRemoteDsh rejects output with non-numeric metadata', async () => {
  const result = await discoverRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('PID:7$(touch /tmp/pwned) PORT:45678') });
  assert.deepEqual(result, { running: false, pid: null, port: null });
});


test('startRemoteDsh starts a new process with dynamic port', async () => {
  const result = await startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('PID:9999 PORT:56789') });
  assert.equal(result.pid, 9999);
  assert.equal(result.port, 56789);
});

test('startRemoteDsh throws on early exit', async () => {
  await assert.rejects(
    () => startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('EXITED') }),
    /exited/,
  );
});

test('startRemoteDsh throws on timeout', async () => {
  await assert.rejects(
    () => startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('TIMEOUT') }),
    /timed out/,
  );
});

test('startRemoteDsh throws on SSH failure', async () => {
  await assert.rejects(
    () => startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('', 255) }),
    /SSH command exited/,
  );
});

// --- stopRemoteDsh ---

test('stopRemoteDsh kills by pid', async () => {
  const result = await stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { status: 'stopped' });
});

test('stopRemoteDsh handles no-pid', async () => {
  const result = await stopRemoteDsh(settings, null, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { status: 'stopped' });
});

test('stopRemoteDsh handles not-found', async () => {
  const result = await stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('not-found') });
  assert.deepEqual(result, { status: 'not-found' });
});

test('stopRemoteDsh propagates SSH and remote command failures', async () => {
  await assert.rejects(
    () => stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('stop-failed', 1) }),
    /SSH command exited/,
  );
});

test('stopRemoteDsh passively reads numeric PID metadata', async () => {
  let command;
  await stopRemoteDsh(settings, null, {
    spawnImpl: (_ssh, args) => {
      command = args.at(-1);
      return spawnWithOutput('not-found');
    },
  });
  assert.ok(command.includes('while IFS= read -r LINE'));
  assert.ok(command.includes('*[!0-9]*'));
  assert.ok(!command.includes(`. ~/.local/state/dsh/runner/desktop-managed.env`));
});

// --- getRemoteDshStatus ---

test('getRemoteDshStatus returns running state', async () => {
  const result = await getRemoteDshStatus(settings, 7777, { spawnImpl: () => spawnWithOutput('running') });
  assert.deepEqual(result, { running: true, pid: 7777 });
});

test('getRemoteDshStatus returns stopped state', async () => {
  const result = await getRemoteDshStatus(settings, null, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { running: false, pid: null, port: null });
});

test('getRemoteDshStatus returns stopped on SSH error', async () => {
  const result = await getRemoteDshStatus(settings, 7777, { spawnImpl: () => spawnWithOutput('', 255) });
  assert.deepEqual(result, { running: false, pid: null });
});

// --- getRemoteDshVersion ---

test('getRemoteDshVersion returns dsh version', async () => {
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('1.0.0') });
  assert.equal(result.version, '1.0.0');
});

test('getRemoteDshVersion returns unknown on error', async () => {
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('', 1) });
  assert.equal(result.version, 'unknown');
});

// --- getRemoteDshProcessDetails ---

test('getRemoteDshProcessDetails returns process info', async () => {
  const stdout = 'PID:7777\n7777 1 0.5 1.2 01:30:00 123456 dsh web --port 56789';
  const result = await getRemoteDshProcessDetails(settings, 7777, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('7777'));
  assert.ok(result.output.includes('0.5'));
});

test('getRemoteDshProcessDetails shows not-running when no pid', async () => {
  const result = await getRemoteDshProcessDetails(settings, null, { spawnImpl: () => spawnWithOutput('') });
  assert.ok(result.output.includes('not running'));
});

// --- getRemoteDshLog ---

test('getRemoteDshLog returns log content', async () => {
  const stdout = '=== DSH PID: 7777 ===\n7777 1 0.5 1.2 01:30:00 123456 dsh web\n\n=== RECENT LOGS ===\nServer started on port 56789';
  const result = await getRemoteDshLog(settings, 7777, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('DSH PID: 7777'));
  assert.ok(result.output.includes('Server started'));
});

test('getRemoteDshLog shows not-running when no pid', async () => {
  const result = await getRemoteDshLog(settings, null, { spawnImpl: () => spawnWithOutput('') });
  assert.ok(result.output.includes('not running'));
});

// --- SSH command timeout ---

test('SSH command timeout rejects with error', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 9001; child.exitCode = null; child.signalCode = null;
  child.kill = () => {};
  let terminated = false;
  await assert.rejects(
    () => startRemoteDsh(settings, {
      spawnImpl: () => child,
      terminateImpl: async () => { terminated = true; },
      timeoutMs: 50,
    }),
    /timed out/,
  );
  assert.ok(terminated);
});

// --- Remote transfer functions ---

test('checkRemoteDshInstalled returns true when DSH is installed with matching version', async () => {
  const result = await checkRemoteDshInstalled(settings, { spawnImpl: () => spawnWithOutput('installed') });
  assert.equal(result, true);
});

test('checkRemoteDshInstalled returns false when DSH is missing', async () => {
  const result = await checkRemoteDshInstalled(settings, { spawnImpl: () => spawnWithOutput('missing') });
  assert.equal(result, false);
});

test('transferRemoteDsh pipes tar.gz via SSH', async () => {
  // Create a temp empty tar.gz for testing
  const tmpDir = fs.mkdtempSync('dsh-test-');
  const tmpTar = path.join(tmpDir, 'test-bundle.tar.gz');
  const { execSync } = require('node:child_process');
  execSync(`tar czf "${tmpTar}" --files-from /dev/null 2>/dev/null || true`);

  const result = await transferRemoteDsh(settings, {
    spawnImpl: () => spawnWithOutput('done'),
    bundlePath: tmpTar,
    bundleVersion: '0.1.0-test',
  });
  assert.ok(result.output.includes('done'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('transferRemoteDsh throws when bundle not found', async () => {
  await assert.rejects(
    () => transferRemoteDsh(settings, {
      spawnImpl: () => spawnWithOutput(''),
      bundlePath: '/nonexistent/bundle.tar.gz',
      bundleVersion: '0.1.0',
    }),
    /bundle not found/,
  );
});

test('startRemoteDsh with autoInstall false skips the transfer', async () => {
  const result = await startRemoteDsh(settings, { autoInstall: false, spawnImpl: () => spawnWithOutput('PID:9999 PORT:56789') });
  assert.equal(result.pid, 9999);
  assert.equal(result.port, 56789);
});

test('startRemoteDsh with autoInstall true transfers when DSH is missing', async () => {
  const tmpDir = fs.mkdtempSync('dsh-test-');
  const tmpTar = path.join(tmpDir, 'test-bundle.tar.gz');
  const { execSync } = require('node:child_process');
  execSync(`tar czf "${tmpTar}" --files-from /dev/null 2>/dev/null || true`);

  let callCount = 0;
  const spawnWithSequence = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 9000 + callCount; child.kill = () => {};
    callCount += 1;
    process.nextTick(() => {
      if (callCount === 1) { child.stdout.write('missing'); child.emit('exit', 0, null); }
      else if (callCount === 2) { child.stdout.write('done'); child.emit('exit', 0, null); }
      else if (callCount === 3) { child.stdout.write('installed'); child.emit('exit', 0, null); }
      else { child.stdout.write('PID:12345 PORT:56789'); child.emit('exit', 0, null); }
    });
    return child;
  };
  const result = await startRemoteDsh(settings, {
    autoInstall: true,
    spawnImpl: spawnWithSequence,
    bundlePath: tmpTar,
    bundleVersion: '0.1.0-test',
  });
  assert.equal(result.pid, 12345);
  assert.equal(result.port, 56789);
  assert.ok(callCount >= 4, `should have at least 4 calls, got ${callCount}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- updateRemoteDsh ---

test('updateRemoteDsh transfers and returns version', async () => {
  const tmpDir = fs.mkdtempSync('dsh-test-');
  const tmpTar = path.join(tmpDir, 'test-bundle.tar.gz');
  const { execSync } = require('node:child_process');
  execSync(`tar czf "${tmpTar}" --files-from /dev/null 2>/dev/null || true`);

  let callCount = 0;
  const spawnWithSequence = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 9000 + callCount; child.kill = () => {};
    callCount += 1;
    process.nextTick(() => {
      if (callCount === 1) { child.stdout.write('done'); child.emit('exit', 0, null); }
      else { child.stdout.write('1.0.0-test'); child.emit('exit', 0, null); }
    });
    return child;
  };
  const result = await updateRemoteDsh(settings, {
    spawnImpl: spawnWithSequence,
    bundlePath: tmpTar,
    bundleVersion: '0.1.0-test',
  });
  assert.ok(result.output.includes('1.0.0-test'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('updateRemoteDsh throws on SSH failure', async () => {
  const tmpDir = fs.mkdtempSync('dsh-test-');
  const tmpTar = path.join(tmpDir, 'test-bundle.tar.gz');
  const { execSync } = require('node:child_process');
  execSync(`tar czf "${tmpTar}" --files-from /dev/null 2>/dev/null || true`);

  await assert.rejects(
    () => updateRemoteDsh(settings, {
      spawnImpl: () => spawnWithOutput('', 1),
      bundlePath: tmpTar,
      bundleVersion: '0.1.0-test',
    }),
    /SSH command exited/,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});