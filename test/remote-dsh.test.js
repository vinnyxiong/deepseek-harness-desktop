const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { buildRemoteSshArgs, getRemoteDshLog, getRemoteDshProcessDetails, getRemoteDshStatus, getRemoteDshVersion, startRemoteDsh, stopRemoteDsh } = require('../src/main/remote-dsh');

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

test('startRemoteDsh starts a new process', async () => {
  const result = await startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('started:9999') });
  assert.deepEqual(result, { status: 'started', pid: 9999 });
});

test('startRemoteDsh detects already-running process', async () => {
  const result = await startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('already-running:8888') });
  assert.deepEqual(result, { status: 'already-running', pid: 8888 });
});

test('startRemoteDsh throws on unexpected output', async () => {
  await assert.rejects(
    () => startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('garbage') }),
    /Unexpected output/,
  );
});

test('startRemoteDsh throws on SSH failure', async () => {
  await assert.rejects(
    () => startRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('', 255) }),
    /SSH command exited/,
  );
});

test('stopRemoteDsh runs the kill command', async () => {
  const result = await stopRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { status: 'stopped' });
});

test('stopRemoteDsh handles non-zero exit gracefully', async () => {
  // stopRemoteDsh uses runRemoteCommand which rejects on non-zero exit.
  // The shell command still echoes "stopped" before exit, but the non-zero
  // exit code from ssh causes the promise to reject. We verify it throws.
  await assert.rejects(
    () => stopRemoteDsh(settings, { spawnImpl: () => spawnWithOutput('stopped', 1) }),
    /SSH command exited/,
  );
});

test('getRemoteDshStatus returns running state', async () => {
  const result = await getRemoteDshStatus(settings, { spawnImpl: () => spawnWithOutput('running:7777') });
  assert.deepEqual(result, { running: true, pid: 7777 });
});

test('getRemoteDshStatus returns stopped state', async () => {
  const result = await getRemoteDshStatus(settings, { spawnImpl: () => spawnWithOutput('stopped') });
  assert.deepEqual(result, { running: false, pid: null });
});

test('getRemoteDshStatus returns stopped on SSH error', async () => {
  const result = await getRemoteDshStatus(settings, { spawnImpl: () => spawnWithOutput('', 255) });
  assert.deepEqual(result, { running: false, pid: null });
});

test('SSH command timeout rejects with error', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 9001; child.exitCode = null; child.signalCode = null;
  child.kill = () => {};
  let terminated = false;
  // child never emits 'exit', so the timeout is the only way to settle
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

test('SSH command includes port in PID file path', async () => {
  let capturedArgs;
  const child = spawnWithOutput('started:1234');
  await startRemoteDsh({ ...settings, remotePort: 5678 }, {
    spawnImpl: (cmd, args) => {
      capturedArgs = args;
      return child;
    },
  });
  const command = capturedArgs[capturedArgs.length - 1];
  assert.ok(command.includes('5678'));
  assert.ok(command.includes('dsh-web-5678.pid'));
});

test('SSH command uses spawn with shell:false', async () => {
  let capturedOptions;
  await startRemoteDsh(settings, {
    spawnImpl: (cmd, args, options) => {
      capturedOptions = options;
      return spawnWithOutput('started:9999');
    },
  });
  assert.equal(capturedOptions.shell, false);
  assert.equal(capturedOptions.env.SSH_ASKPASS_REQUIRE, 'never');
});

test('getRemoteDshVersion returns version when process is running', async () => {
  const stdout = 'PROCESS:7777\nVERSION:0.1.0-rc.6';
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.equal(result.version, '0.1.0-rc.6');
  assert.ok(result.output.includes('7777'));
});

test('getRemoteDshVersion handles not-running state', async () => {
  const stdout = 'PROCESS:not-running\nVERSION:DSH not running';
  const result = await getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.equal(result.version, 'DSH not running');
  assert.equal(result.output, '远程 DSH 未运行');
});

test('getRemoteDshVersion throws on SSH failure', async () => {
  await assert.rejects(
    () => getRemoteDshVersion(settings, { spawnImpl: () => spawnWithOutput('', 255) }),
    /SSH command exited/,
  );
});

test('getRemoteDshProcessDetails returns process info', async () => {
  const stdout = 'PID:7777\n7777 1 0.5 1.2 01:30:00 123456 dsh web --port 3080';
  const result = await getRemoteDshProcessDetails(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('7777'));
  assert.ok(result.output.includes('0.5'));
});

test('getRemoteDshProcessDetails shows not-running when DSH is down', async () => {
  const stdout = 'DSH not running on port 3080';
  const result = await getRemoteDshProcessDetails(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('not running'));
});

test('getRemoteDshProcessDetails throws on SSH failure', async () => {
  await assert.rejects(
    () => getRemoteDshProcessDetails(settings, { spawnImpl: () => spawnWithOutput('', 1) }),
    /SSH command exited/,
  );
});

test('getRemoteDshLog returns log content', async () => {
  const stdout = '=== DSH PID: 7777 ===\n7777 1 0.5 1.2 01:30:00 123456 dsh web\n\n=== RECENT LOGS (last 50 lines) ===\n[2026-08-19] Server started on port 3080';
  const result = await getRemoteDshLog(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('DSH PID: 7777'));
  assert.ok(result.output.includes('Server started'));
});

test('getRemoteDshLog shows not-running when DSH is down', async () => {
  const stdout = 'DSH not running on port 3080';
  const result = await getRemoteDshLog(settings, { spawnImpl: () => spawnWithOutput(stdout) });
  assert.ok(result.output.includes('not running'));
});

test('getRemoteDshLog throws on SSH failure', async () => {
  await assert.rejects(
    () => getRemoteDshLog(settings, { spawnImpl: () => spawnWithOutput('', 1) }),
    /SSH command exited/,
  );
});