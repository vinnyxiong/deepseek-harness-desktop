const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { buildRemoteSshArgs, checkRemoteDshInstalled, checkRemoteNpmAvailable, getRemoteDshLog, getRemoteDshProcessDetails, getRemoteDshStatus, getRemoteDshVersion, installRemoteDsh, startRemoteDsh, stopRemoteDsh, updateRemoteDsh } = require('../src/main/remote-dsh');

const settings = {
  host: '10.37.117.240', username: 'xiongyuanwen', sshPort: 22,
  localPort: 3080, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new',
};

function spawnWithOutput(stdoutText, exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 9000; child.exitCode = null; child.signalCode = null;
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

// --- startRemoteDsh (new: --port 0, dynamic port detection) ---

test('startRemoteDsh starts a new process with dynamic port', async () => {
  const result = await startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('PID:9999 PORT:56789') });
  assert.deepEqual(result, { pid: 9999, port: 56789 });
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

// --- stopRemoteDsh (new: takes pid) ---

test('stopRemoteDsh kills by pid', async () => {
  const result = await stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { status: 'stopped' });
});

test('stopRemoteDsh handles no-pid', async () => {
  const result = await stopRemoteDsh(settings, null, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { status: 'no-pid' });
});

test('stopRemoteDsh handles not-found', async () => {
  const result = await stopRemoteDsh(settings, 9999, { spawnImpl: () => spawnWithOutput('not-found') });
  assert.deepEqual(result, { status: 'not-found' });
});

// --- getRemoteDshStatus (new: takes pid) ---

test('getRemoteDshStatus returns running state', async () => {
  const result = await getRemoteDshStatus(settings, 7777, { spawnImpl: () => spawnWithOutput('running') });
  assert.deepEqual(result, { running: true, pid: 7777 });
});

test('getRemoteDshStatus returns stopped state', async () => {
  const result = await getRemoteDshStatus(settings, null, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { running: false, pid: null });
});

test('getRemoteDshStatus returns stopped on SSH error', async () => {
  const result = await getRemoteDshStatus(settings, 7777, { spawnImpl: () => spawnWithOutput('', 255) });
  assert.deepEqual(result, { running: false, pid: null });
});

// --- getRemoteDshVersion (new: uses dsh --version) ---

test('getRemoteDshVersion returns dsh version', async () => {
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('1.0.0') });
  assert.equal(result.version, '1.0.0');
});

test('getRemoteDshVersion returns unknown on error', async () => {
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('', 1) });
  assert.equal(result.version, 'unknown');
});

// --- getRemoteDshProcessDetails (new: takes pid) ---

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

// --- getRemoteDshLog (new: takes pid) ---

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

// --- Remote install functions ---

test('checkRemoteNpmAvailable returns true when npm is found', async () => {
  const result = await checkRemoteNpmAvailable(settings, { spawnImpl: () => spawnWithOutput('10.2.0\nnpm:ok') });
  assert.equal(result, true);
});

test('checkRemoteNpmAvailable returns false when npm is missing', async () => {
  const result = await checkRemoteNpmAvailable(settings, { spawnImpl: () => spawnWithOutput('npm:missing') });
  assert.equal(result, false);
});

test('checkRemoteDshInstalled returns true when DSH is installed', async () => {
  const result = await checkRemoteDshInstalled(settings, { spawnImpl: () => spawnWithOutput('installed') });
  assert.equal(result, true);
});

test('checkRemoteDshInstalled returns false when DSH is missing', async () => {
  const result = await checkRemoteDshInstalled(settings, { spawnImpl: () => spawnWithOutput('missing') });
  assert.equal(result, false);
});

test('installRemoteDsh runs npm install on remote', async () => {
  const stdout = 'added 200 packages in 30s';
  const result = await installRemoteDsh(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('added 200 packages'));
});

test('startRemoteDsh with autoInstall false skips the install check', async () => {
  const result = await startRemoteDsh(settings, { autoInstall: false, spawnImpl: () => spawnWithOutput('PID:9999 PORT:56789') });
  assert.deepEqual(result, { pid: 9999, port: 56789 });
});

test('startRemoteDsh with autoInstall true installs when DSH is missing', async () => {
  let callCount = 0;
  const spawnWithSequence = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 9000 + callCount; child.kill = () => {};
    callCount += 1;
    process.nextTick(() => {
      if (callCount === 1) { child.stdout.write('missing'); child.emit('exit', 0, null); }
      else if (callCount === 2) { child.stdout.write('10.2.0\nnpm:ok'); child.emit('exit', 0, null); }
      else if (callCount === 3) { child.stdout.write('added 200 packages'); child.emit('exit', 0, null); }
      else if (callCount === 4) { child.stdout.write('installed'); child.emit('exit', 0, null); }
      else { child.stdout.write('PID:12345 PORT:56789'); child.emit('exit', 0, null); }
    });
    return child;
  };
  const result = await startRemoteDsh(settings, { autoInstall: true, spawnImpl: spawnWithSequence });
  assert.deepEqual(result, { pid: 12345, port: 56789 });
  assert.ok(callCount >= 5, `should have at least 5 calls, got ${callCount}`);
});

test('startRemoteDsh with autoInstall throws when npm is missing on remote', async () => {
  let callCount = 0;
  const spawnWithSequence = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 9000 + callCount; child.kill = () => {};
    callCount += 1;
    process.nextTick(() => {
      if (callCount === 1) { child.stdout.write('missing'); child.emit('exit', 0, null); }
      else { child.stdout.write('npm:missing'); child.emit('exit', 0, null); }
    });
    return child;
  };
  await assert.rejects(
    () => startRemoteDsh(settings, { autoInstall: true, spawnImpl: spawnWithSequence }),
    /npm/,
  );
});

// --- updateRemoteDsh (new: uses npm install) ---

test('updateRemoteDsh runs npm install', async () => {
  const stdout = 'added 200 packages in 30s\n---\n1.0.0';
  const result = await updateRemoteDsh(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('added 200 packages'));
  assert.ok(result.output.includes('1.0.0'));
});

test('updateRemoteDsh throws on SSH failure', async () => {
  await assert.rejects(
    () => updateRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('', 1) }),
    /SSH command exited/,
  );
});