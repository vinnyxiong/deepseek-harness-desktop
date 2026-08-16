const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { buildManagedSshArgs, classifySshError, startManagedSsh } = require('../src/main/managed-ssh');

const settings = {
  host: '10.37.117.240', username: 'xiongyuanwen', sshPort: 22,
  localPort: 3080, remotePort: 3080, identityFile: null, hostKeyPolicy: 'accept-new',
};

test('builds safe managed SSH argv without a shell command', () => {
  const args = buildManagedSshArgs(settings);
  assert.deepEqual(args.slice(0, 5), ['-N', '-T', '-n', '-L', '127.0.0.1:3080:127.0.0.1:3080']);
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=accept-new'));
  assert.deepEqual(args.slice(-4), ['-p', '22', '--', 'xiongyuanwen@10.37.117.240']);
});

test('adds identity and strict host-key options', () => {
  const args = buildManagedSshArgs({ ...settings, identityFile: '/tmp/id', hostKeyPolicy: 'strict' });
  assert.ok(args.includes('/tmp/id'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
});

test('classifies common authentication errors', () => {
  assert.match(classifySshError('Permission denied (publickey).', 'failed'), /authentication failed/);
  assert.match(classifySshError('Host key verification failed.', 'failed'), /host-key verification failed/);
});

test('starts and idempotently stops an owned SSH process', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 123; child.exitCode = null; child.signalCode = null;
  let spawnCall; let terminateCount = 0;
  const handle = await startManagedSsh({
    settings,
    checkPort: async () => {},
    spawnImpl(command, args, options) { spawnCall = { command, args, options }; return child; },
    terminateImpl: async () => { terminateCount += 1; },
  });
  assert.equal(spawnCall.command, '/usr/bin/ssh');
  assert.equal(spawnCall.options.shell, false);
  assert.equal(handle.owned, true);
  await Promise.all([handle.stop(), handle.stop()]);
  assert.equal(terminateCount, 1);
});

test('reports unexpected SSH exits with diagnostics', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 124; child.exitCode = null; child.signalCode = null;
  let details;
  const handle = await startManagedSsh({ settings, checkPort: async () => {}, spawnImpl: () => child, onUnexpectedExit: value => { details = value; } });
  child.stderr.write('Permission denied (publickey).');
  child.emit('exit', 255, null);
  await assert.rejects(handle.earlyExit, /authentication failed/);
  assert.equal(details.code, 255);
});
