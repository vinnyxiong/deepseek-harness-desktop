const { spawn } = require('child_process');
const path = require('path');
const { buildCommonSshOptions, DEFAULT_SSH_PATH } = require('./managed-ssh');
const { createDiagnosticBuffer, terminateChild } = require('./process-utils');

const DSH_REMOTE_BIN = '~/.local/state/dsh/runner/.bin/dsh';
const DSH_REMOTE_RUNNER_DIR = '~/.local/state/dsh/runner';
const DSH_REMOTE_VERSION_FILE = '~/.local/state/dsh/runner/.dsh-version';
const DSH_REMOTE_METADATA_FILE = '~/.local/state/dsh/runner/desktop-managed.env';
const DSH_REMOTE_LOG_FILE = '~/.local/state/dsh/runner/desktop-managed.log';

const COMMAND_TIMEOUT_MS = 15_000;

// Resolve the path to dsh-bundle.tar.gz (bundled as extraResource).
function getBundlePath() {
  // In development, read from project root.
  if (process.env.NODE_ENV !== 'production' && !require('electron').app?.isPackaged) {
    return path.join(__dirname, '..', '..', 'dsh-bundle.tar.gz');
  }
  // In packaged app, extraResources are placed in the resources directory.
  return path.join(process.resourcesPath, 'dsh-bundle.tar.gz');
}

function buildRemoteSshArgs(settings) {
  return buildCommonSshOptions(settings);
}

function runRemoteCommand(settings, command, {
  sshPath = DEFAULT_SSH_PATH,
  spawnImpl = spawn,
  terminateImpl = terminateChild,
  timeoutMs = COMMAND_TIMEOUT_MS,
  stdin = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const diagnostics = createDiagnosticBuffer();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const child = spawnImpl(sshPath, [...buildRemoteSshArgs(settings), command], {
      shell: false,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' },
    });

    if (stdin) {
      stdin.pipe(child.stdin);
    }

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
        const output = stdout.trim();
        const details = [diag, output].filter(Boolean).join('\n');
        reject(new Error(details ? `SSH command exited with code ${code}:\n${details}` : `SSH command exited with code ${code} (signal=${signal})`));
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

// --- Remote DSH lifecycle ---

// Read the bundled DSH version from the version file.
function getBundledDshVersion() {
  try {
    const fs = require('fs');
    const versionPath = path.join(path.dirname(getBundlePath()), 'dsh-bundle.version');
    return fs.readFileSync(versionPath, 'utf8').trim();
  } catch {
    // Fallback: read from the bundled package.json
    try {
      const pkg = require('../../package.json');
      return pkg.dependencies?.['@deepseek-ai/dsh'] || '0.1.0-rc.6';
    } catch {
      return '0.1.0-rc.6';
    }
  }
}

// Check if DSH is installed on the remote AND the version matches.
async function checkRemoteDshInstalled(settings, opts = {}) {
  const version = getBundledDshVersion();
  const command = `test -x ${DSH_REMOTE_BIN} && test -f ${DSH_REMOTE_VERSION_FILE} && grep -qFx '${version}' ${DSH_REMOTE_VERSION_FILE} && echo "installed" || echo "missing"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  return stdout.includes('installed');
}

// Transfer the bundled DSH to the remote machine via SSH piped tar.
async function transferRemoteDsh(settings, opts = {}) {
  const fs = require('fs');
  const bundlePath = opts.bundlePath || getBundlePath();
  const version = opts.bundleVersion || getBundledDshVersion();

  opts.onProgress?.('remote-transferring', '正在传输 DSH 到远程服务器...');

  try {
    fs.accessSync(bundlePath, fs.constants.R_OK);
  } catch {
    throw new Error('DSH bundle not found. The application may not have been built correctly.');
  }

  // Pipe the tar.gz via SSH stdin, extract on remote, then write version file.
  const command = `mkdir -p ${DSH_REMOTE_RUNNER_DIR} && rm -rf ${DSH_REMOTE_RUNNER_DIR}/node_modules && tar xzf - -C ${DSH_REMOTE_RUNNER_DIR} && echo '${version}' > ${DSH_REMOTE_VERSION_FILE} && echo "done"`;
  const stdin = fs.createReadStream(bundlePath);
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 600_000, stdin });
  return { output: stdout };
}

async function discoverRemoteDsh(settings, opts = {}) {
  // Metadata is untrusted data. Parse only the two fixed keys line-by-line;
  // never source/evaluate the file, and accept digits only.
  const command = `PID=; PORT=; if test -f ${DSH_REMOTE_METADATA_FILE}; then while IFS= read -r LINE; do case "$LINE" in PID=*) VALUE=\${LINE#PID=}; case "$VALUE" in ''|*[!0-9]*) ;; *) PID=$VALUE ;; esac ;; PORT=*) VALUE=\${LINE#PORT=}; case "$VALUE" in ''|*[!0-9]*) ;; *) PORT=$VALUE ;; esac ;; esac; done < ${DSH_REMOTE_METADATA_FILE}; fi; if test -n "$PID" && test -n "$PORT" && kill -0 "$PID" 2>/dev/null; then echo "PID:$PID PORT:$PORT"; else rm -f ${DSH_REMOTE_METADATA_FILE}; echo "STOPPED"; fi`;
  try {
    const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
    const match = stdout.match(/^PID:(\d+) PORT:(\d+)$/m);
    return match
      ? { running: true, pid: Number(match[1]), port: Number(match[2]) }
      : { running: false, pid: null, port: null };
  } catch {
    return { running: false, pid: null, port: null };
  }
}

async function startRemoteDsh(settings, opts = {}) {
  // Auto-install if requested and DSH is not on the remote machine
  if (opts.autoInstall === true) {
    const installed = await checkRemoteDshInstalled(settings, opts);
    if (!installed) {
      opts.onProgress?.('remote-transferring', '正在传输 DSH 到远程服务器...');
      await transferRemoteDsh(settings, opts);
      const recheck = await checkRemoteDshInstalled(settings, opts);
      if (!recheck) {
        throw new Error('DSH transfer completed but the binary was not found on the remote machine.');
      }
      opts.onProgress?.('remote-start', '传输完成，正在启动远程 DSH...');
    }
  }

  // Reuse a healthy desktop-managed service, otherwise launch one whose
  // metadata and log survive the SSH session and desktop application.
  const existing = await discoverRemoteDsh(settings, opts);
  if (existing.running) return { pid: existing.pid, port: existing.port, discovered: true };

  const command = `mkdir -p ${DSH_REMOTE_RUNNER_DIR}; rm -f ${DSH_REMOTE_METADATA_FILE}; nohup ${DSH_REMOTE_BIN} web --port 0 > ${DSH_REMOTE_LOG_FILE} 2>&1 < /dev/null & PID=$!; for i in $(seq 1 30); do PORT=$(grep -oE 'http://127\\.0\\.0\\.1:[0-9]+' ${DSH_REMOTE_LOG_FILE} 2>/dev/null | tail -n 1 | grep -oE '[0-9]+$'); if [ -n "$PORT" ]; then printf 'PID=%s\\nPORT=%s\\n' "$PID" "$PORT" > ${DSH_REMOTE_METADATA_FILE}; echo "PID:$PID PORT:$PORT"; exit 0; fi; if ! kill -0 "$PID" 2>/dev/null; then echo "EXITED"; exit 1; fi; sleep 1; done; kill "$PID" 2>/dev/null; rm -f ${DSH_REMOTE_METADATA_FILE}; echo "TIMEOUT"; exit 1`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 45_000 });

  const pidMatch = stdout.match(/PID:(\d+)/);
  const portMatch = stdout.match(/PORT:(\d+)/);
  if (!pidMatch || !portMatch) {
    if (stdout.includes('EXITED')) throw new Error('Remote DSH exited before starting');
    if (stdout.includes('TIMEOUT')) throw new Error('Remote DSH startup timed out (30s)');
    throw new Error(`Unexpected output from remote DSH start: ${stdout}`);
  }
  return { pid: Number(pidMatch[1]), port: Number(portMatch[1]), discovered: false };
}

async function stopRemoteDsh(settings, pid, opts = {}) {
  const explicitPid = Number.isSafeInteger(pid) && pid > 0 ? String(pid) : '';
  const command = `PID=${explicitPid}; if test -z "$PID" && test -f ${DSH_REMOTE_METADATA_FILE}; then while IFS= read -r LINE; do case "$LINE" in PID=*) VALUE=\${LINE#PID=}; case "$VALUE" in ''|*[!0-9]*) ;; *) PID=$VALUE ;; esac ;; esac; done < ${DSH_REMOTE_METADATA_FILE}; fi; if test -z "$PID"; then echo "not-found"; exit 0; fi; if kill "$PID"; then rm -f ${DSH_REMOTE_METADATA_FILE}; echo "stopped"; elif kill -0 "$PID" 2>/dev/null; then echo "stop-failed" >&2; exit 1; else rm -f ${DSH_REMOTE_METADATA_FILE}; echo "not-found"; fi`;
  const { stdout } = await runRemoteCommand(settings, command, opts);
  return { status: stdout.trim() === 'stopped' ? 'stopped' : 'not-found' };
}

async function getRemoteDshStatus(settings, pid, opts = {}) {
  if (!pid) return discoverRemoteDsh(settings, opts);
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
    const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
    return { version: stdout.trim() || 'unknown' };
  } catch {
    return { version: 'unknown' };
  }
}

async function getRemoteDshLog(settings, pid, opts = {}) {
  const state = pid ? { running: true, pid } : await discoverRemoteDsh(settings, opts);
  if (!state.running) return { output: 'Remote DSH is not running.' };
  const command = `echo "=== DSH PID: ${state.pid} ==="; ps -p ${state.pid} -o pid,ppid,pcpu,pmem,etime,rss,args --no-headers 2>/dev/null; echo ""; echo "=== RECENT LOGS ==="; tail -n 50 ${DSH_REMOTE_LOG_FILE} 2>/dev/null || echo "(no log file found)"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  return { output: stdout };
}

async function getRemoteDshProcessDetails(settings, pid, opts = {}) {
  if (!pid) return { output: 'Remote DSH is not running.' };
  const command = `echo "PID:${pid}"; ps -p ${pid} -o pid,ppid,pcpu,pmem,etime,rss,args --no-headers 2>/dev/null || echo "Process not found"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  return { output: stdout };
}

async function updateRemoteDsh(settings, opts = {}) {
  await transferRemoteDsh(settings, opts);
  const version = await getRemoteDshVersion(settings, opts);
  return { output: `Updated to version ${version.version}` };
}

module.exports = { buildRemoteSshArgs, checkRemoteDshInstalled, discoverRemoteDsh, getBundledDshVersion, getRemoteDshLog, getRemoteDshProcessDetails, getRemoteDshStatus, getRemoteDshVersion, startRemoteDsh, stopRemoteDsh, transferRemoteDsh, updateRemoteDsh };