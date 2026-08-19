const { spawn } = require('child_process');
const { buildCommonSshOptions, DEFAULT_SSH_PATH } = require('./managed-ssh');
const { createDiagnosticBuffer, terminateChild } = require('./process-utils');

const COMMAND_TIMEOUT_MS = 15_000;

function buildRemoteSshArgs(settings) {
  return buildCommonSshOptions(settings);
}

function runRemoteCommand(settings, command, {
  sshPath = DEFAULT_SSH_PATH,
  spawnImpl = spawn,
  terminateImpl = terminateChild,
  timeoutMs = COMMAND_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const diagnostics = createDiagnosticBuffer();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const child = spawnImpl(sshPath, [...buildRemoteSshArgs(settings), command], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
    });

    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      diagnostics.append(text);
    });

    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        const diag = diagnostics.toString().trim();
        reject(new Error(diag ? `SSH command exited with code ${code}: ${diag}` : `SSH command exited with code ${code} (signal=${signal})`));
      }
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateImpl(child, { killTree: true }).catch(() => {});
      reject(new Error('SSH command timed out'));
    }, timeoutMs);
  });
}

async function startRemoteDsh(settings, opts) {
  const port = settings.remotePort;
  const command = `PID=$(cat /tmp/dsh-web-${port}.pid 2>/dev/null); if [ -n "$PID" ] && kill -0 $PID 2>/dev/null; then echo "already-running:$PID"; else nohup dsh web --port ${port} >/dev/null 2>&1 & echo $! > /tmp/dsh-web-${port}.pid; echo "started:$!"; fi`;
  const { stdout } = await runRemoteCommand(settings, command, opts);
  const match = stdout.match(/^(already-running|started):(\d+)$/);
  if (!match) throw new Error(`Unexpected output from remote DSH start: ${stdout}`);
  return { status: match[1], pid: Number(match[2]) };
}

async function stopRemoteDsh(settings, opts) {
  const port = settings.remotePort;
  const command = `PID=$(cat /tmp/dsh-web-${port}.pid 2>/dev/null); [ -n "$PID" ] && kill $PID 2>/dev/null; rm -f /tmp/dsh-web-${port}.pid; echo "stopped"`;
  const { stdout } = await runRemoteCommand(settings, command, opts);
  return { status: stdout.includes('stopped') ? 'stopped' : 'unknown' };
}

async function getRemoteDshStatus(settings, opts) {
  const port = settings.remotePort;
  const command = `PID=$(cat /tmp/dsh-web-${port}.pid 2>/dev/null); if [ -n "$PID" ] && kill -0 $PID 2>/dev/null; then echo "running:$PID"; else echo "stopped"; fi`;
  try {
    const { stdout } = await runRemoteCommand(settings, command, opts);
    const match = stdout.match(/^running:(\d+)$/);
    if (match) return { running: true, pid: Number(match[1]) };
    return { running: false, pid: null };
  } catch (error) {
    // If we can't reach the remote host, remote DSH is not running
    return { running: false, pid: null };
  }
}

async function getRemoteDshVersion(settings, opts) {
  const port = settings.remotePort;
  // Non-interactive SSH sessions don't source .zshrc/.bashrc, so dsh may not
  // be on PATH. Use $SHELL -ic to run in the user's interactive shell which
  // loads rc files, with stderr suppressed to filter out rc-file noise.
  const command = `VER=$($SHELL -ic 'dsh --version' 2>/dev/null || echo 'unknown'); echo "VERSION:$VER"; PID=$(cat /tmp/dsh-web-${port}.pid 2>/dev/null); if [ -n "$PID" ] && kill -0 $PID 2>/dev/null; then echo "PROCESS:$PID"; ps -p $PID -o pid,ppid,pcpu,pmem,etime,rss,args --no-headers 2>/dev/null; else echo "PROCESS:not-running"; fi`;
  const { stdout } = await runRemoteCommand(settings, command, opts);
  const lines = stdout.split('\n');
  let version = '';
  let processInfo = '';
  for (const line of lines) {
    if (line.startsWith('VERSION:')) version = line.slice(8);
    else if (line.startsWith('PROCESS:')) processInfo = line.slice(8);
  }
  const processMarker = lines.findIndex(l => l.startsWith('PROCESS:'));
  const processLines = processMarker >= 0 ? lines.slice(processMarker + 1).filter(l => l.trim()) : [];
  const output = processInfo !== 'not-running'
    ? `进程 PID: ${processInfo}\n${processLines.join('\n')}`
    : '远程 DSH 未运行';
  return { version, output };
}

async function getRemoteDshLog(settings, opts) {
  const port = settings.remotePort;
  const command = `PID=$(cat /tmp/dsh-web-${port}.pid 2>/dev/null); if [ -n "$PID" ] && kill -0 $PID 2>/dev/null; then echo "=== DSH PID: $PID ==="; ps -p $PID -o pid,ppid,pcpu,pmem,etime,rss,args --no-headers 2>/dev/null; echo ""; echo "=== RECENT LOGS (last 50 lines) ==="; tail -n 50 /proc/$PID/fd/1 2>/dev/null || echo "(cannot read process stdout)"; else echo "DSH not running on port ${port}"; fi`;
  const { stdout } = await runRemoteCommand(settings, command, opts);
  return { output: stdout };
}

module.exports = { buildRemoteSshArgs, getRemoteDshStatus, getRemoteDshLog, getRemoteDshVersion, startRemoteDsh, stopRemoteDsh };