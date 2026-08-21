const { spawn } = require('child_process');
const { buildCommonSshOptions, DEFAULT_SSH_PATH } = require('./managed-ssh');
const { createDiagnosticBuffer, terminateChild } = require('./process-utils');
const { DSH_PACKAGE_SPEC, DSH_VERSION } = require('./dsh-installer');

const DSH_REMOTE_BIN = '~/.local/state/dsh/runner/node_modules/.bin/dsh';
const DSH_REMOTE_RUNNER_DIR = '~/.local/state/dsh/runner';

// Write a minimal package.json with overrides to pin all @deepseek-ai/*
// transitive deps. Without this, npm caret ranges can resolve to rc.8
// which may reference packages that don't exist on the registry.
const OVERRIDES_JSON = JSON.stringify({ overrides: { '@deepseek-ai/*': DSH_VERSION } });
const WRITE_OVERRIDES_CMD = `echo '${OVERRIDES_JSON}' > ${DSH_REMOTE_RUNNER_DIR}/package.json`;

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

// --- Remote DSH lifecycle (no dsh-web dependency) ---

async function checkRemoteNpmAvailable(settings, opts = {}) {
  const command = 'npm --version 2>/dev/null && echo "npm:ok" || echo "npm:missing"';
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 10_000 });
  return stdout.includes('npm:ok');
}

async function checkRemoteDshInstalled(settings, opts = {}) {
  const command = `test -x ${DSH_REMOTE_BIN} && echo "installed" || echo "missing"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 10_000 });
  return stdout.includes('installed');
}

async function installRemoteDsh(settings, opts = {}) {
  const command = `mkdir -p ${DSH_REMOTE_RUNNER_DIR} && ${WRITE_OVERRIDES_CMD} && npm install --prefer-offline --prefix ${DSH_REMOTE_RUNNER_DIR} --no-audit --no-fund ${DSH_PACKAGE_SPEC} 2>&1`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 600_000 });
  return { output: stdout };
}

async function startRemoteDsh(settings, opts = {}) {
  // Auto-install if requested and DSH is not on the remote machine
  if (opts.autoInstall === true) {
    const installed = await checkRemoteDshInstalled(settings, opts);
    if (!installed) {
      opts.onProgress?.('remote-install-checking', '正在检查远程环境...');
      const npmOk = await checkRemoteNpmAvailable(settings, opts);
      if (!npmOk) {
        throw new Error('Remote machine does not have npm. Please install Node.js and npm on the remote machine, or disable "Auto-install remote DSH" in connection settings.');
      }
      opts.onProgress?.('remote-installing', '正在远程安装 DSH，请稍候...');
      await installRemoteDsh(settings, opts);
      const recheck = await checkRemoteDshInstalled(settings, opts);
      if (!recheck) {
        throw new Error('DSH installation on the remote machine completed but the binary was not found. Check npm output for errors.');
      }
      opts.onProgress?.('remote-start', '安装完成，正在启动远程 DSH...');
    }
  }

  // Start dsh web --port 0 on the remote machine, capture its PID and port.
  // Use the full path since npm --prefix installs into a local node_modules.
  const command = `nohup ${DSH_REMOTE_BIN} web --port 0 > /tmp/dsh-remote-$$.log 2>&1 & PID=$!; for i in $(seq 1 30); do PORT=$(grep -oP 'http://127\\.0\\.0\\.1:\\K\\d+' /tmp/dsh-remote-$$.log 2>/dev/null); if [ -n "$PORT" ]; then echo "PID:$PID PORT:$PORT"; exit 0; fi; if ! kill -0 $PID 2>/dev/null; then echo "EXITED"; exit 1; fi; sleep 1; done; kill $PID 2>/dev/null; echo "TIMEOUT"; exit 1`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 45_000 });

  const pidMatch = stdout.match(/PID:(\d+)/);
  const portMatch = stdout.match(/PORT:(\d+)/);
  if (!pidMatch || !portMatch) {
    if (stdout.includes('EXITED')) throw new Error('Remote DSH exited before starting');
    if (stdout.includes('TIMEOUT')) throw new Error('Remote DSH startup timed out (30s)');
    throw new Error(`Unexpected output from remote DSH start: ${stdout}`);
  }
  return { pid: Number(pidMatch[1]), port: Number(portMatch[1]) };
}

async function stopRemoteDsh(settings, pid, opts = {}) {
  if (!pid) return { status: 'no-pid' };
  const command = `kill ${pid} 2>/dev/null && echo "stopped" || echo "not-found"`;
  try {
    const { stdout } = await runRemoteCommand(settings, command, opts);
    return { status: stdout.includes('stopped') ? 'stopped' : 'not-found' };
  } catch {
    return { status: 'not-found' };
  }
}

async function getRemoteDshStatus(settings, pid, opts = {}) {
  if (!pid) return { running: false, pid: null };
  const command = `kill -0 ${pid} 2>/dev/null && echo "running" || echo "stopped"`;
  try {
    const { stdout } = await runRemoteCommand(settings, command, opts);
    if (stdout.includes('running')) return { running: true, pid };
    return { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

async function getRemoteDshVersion(settings, opts = {}) {
  try {
    const command = `${DSH_REMOTE_BIN} --version 2>/dev/null || echo "unknown"`;
    const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 10_000 });
    return { version: stdout.trim() || 'unknown' };
  } catch {
    return { version: 'unknown' };
  }
}

async function getRemoteDshLog(settings, pid, opts = {}) {
  if (!pid) return { output: 'Remote DSH is not running.' };
  const command = `echo "=== DSH PID: ${pid} ==="; ps -p ${pid} -o pid,ppid,pcpu,pmem,etime,rss,args --no-headers 2>/dev/null; echo ""; echo "=== RECENT LOGS ==="; for f in /tmp/dsh-remote-*.log; do tail -n 50 "$f" 2>/dev/null && break; done || echo "(no log file found)"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 10_000 });
  return { output: stdout };
}

async function getRemoteDshProcessDetails(settings, pid, opts = {}) {
  if (!pid) return { output: 'Remote DSH is not running.' };
  const command = `echo "PID:${pid}"; ps -p ${pid} -o pid,ppid,pcpu,pmem,etime,rss,args --no-headers 2>/dev/null || echo "Process not found"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 10_000 });
  return { output: stdout };
}

async function updateRemoteDsh(settings, opts = {}) {
  const command = `${WRITE_OVERRIDES_CMD} && npm install --prefer-offline --prefix ${DSH_REMOTE_RUNNER_DIR} --no-audit --no-fund ${DSH_PACKAGE_SPEC} 2>&1; echo "---"; ${DSH_REMOTE_BIN} --version 2>/dev/null || echo "version-unknown"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: 600_000 });
  return { output: stdout };
}

module.exports = { buildRemoteSshArgs, checkRemoteDshInstalled, checkRemoteNpmAvailable, getRemoteDshLog, getRemoteDshProcessDetails, getRemoteDshStatus, getRemoteDshVersion, installRemoteDsh, startRemoteDsh, stopRemoteDsh, updateRemoteDsh };