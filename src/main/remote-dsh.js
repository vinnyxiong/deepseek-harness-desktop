const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildCommonSshOptions, DEFAULT_SSH_PATH } = require('./managed-ssh');
const { createDiagnosticBuffer, terminateChild } = require('./process-utils');

// Remote directory layout.
const DSH_REMOTE_BASE_DIR = '$HOME/.local/state/dsh';
const DSH_REMOTE_RUNNER_DIR = `${DSH_REMOTE_BASE_DIR}/runner`;
const DSH_REMOTE_BIN = `${DSH_REMOTE_RUNNER_DIR}/node_modules/.bin/dsh`;
const DSH_REMOTE_VERSION_FILE = `${DSH_REMOTE_RUNNER_DIR}/.dsh-version`;
const DSH_REMOTE_MANIFEST_FILE = `${DSH_REMOTE_RUNNER_DIR}/.dsh-manifest.json`;
// Deliberately outside the runner directory: a redeployment moves the runner
// aside and deletes it, so metadata kept inside it would take the record of the
// running process with it -- leaving an orphan that the desktop can no longer
// discover or stop, still holding its port and its plugin locks.
const DSH_REMOTE_METADATA_FILE = `${DSH_REMOTE_BASE_DIR}/desktop-managed.env`;
const DSH_REMOTE_LOG_FILE = `${DSH_REMOTE_BASE_DIR}/desktop-managed.log`;
// Pre-0.0.2 installs kept both inside the runner directory.
const DSH_REMOTE_LEGACY_METADATA_FILE = `${DSH_REMOTE_RUNNER_DIR}/desktop-managed.env`;

const SUPPORTED_TRIPLE = 'linux-x64-gnu';

// Shell helper shared by the stop and transfer scripts: confirm a pid really is
// a dsh started from this runner before signalling it. Metadata can outlive the
// process it names and the kernel recycles pids, so an unverified kill can hit
// an unrelated process. Matched on a path suffix rather than $HOME: the recorded
// command line may spell the home directory differently than this shell does
// (symlinked homes), and a mismatch there would silently skip the check.
const SHELL_IS_MANAGED_DSH = `is_managed_dsh() {
  ps -p "$1" -o args= 2>/dev/null | grep -q 'state/dsh/runner/node_modules/\\.bin/dsh'
}`;

// Native modules the remote runner must contain, relative to its node_modules.
// `dsh --version` never loads them, so a bundle built on the wrong host passes
// the smoke test and only fails later, when `dsh web` boots the plugin loader
// ("Failed to load native module: pty.node" / "Cannot find the native Koffi
// module"). Checking them here keeps the failure at install time, where the
// error message can name the real cause.
// Keep in sync with REQUIRED_NATIVE_ENTRIES in scripts/build-dsh-bundle.cjs
// (test/remote-dsh.test.js asserts the two lists match).
const REQUIRED_REMOTE_NATIVES = Object.freeze([
  'node-pty/prebuilds/linux-x64/pty.node',
  '@koromix/koffi-linux-x64/linux_x64/koffi.node',
]);

const COMMAND_TIMEOUT_MS = 15_000;

// --- Bundle / manifest discovery on the local (desktop) side ---

function getBundleDir() {
  try {
    const { app } = require('electron');
    if (app?.isPackaged && process.resourcesPath) return process.resourcesPath;
  } catch { /* not in electron main process; fall through */ }
  return path.join(__dirname, '..', '..');
}

function getBundlePath() {
  return path.join(getBundleDir(), 'dsh-bundle.tar.gz');
}

function getManifestPath() {
  return path.join(getBundleDir(), 'dsh-bundle.manifest.json');
}

function getVersionFilePath() {
  return path.join(getBundleDir(), 'dsh-bundle.version');
}

function readBundledManifest() {
  try {
    return JSON.parse(fs.readFileSync(getManifestPath(), 'utf8'));
  } catch {
    return null;
  }
}

// Read the bundled DSH version. Prefer the manifest; fall back to version file,
// then to package.json dependency pin.
function getBundledDshVersion() {
  const manifest = readBundledManifest();
  if (manifest?.version) return manifest.version;
  try {
    return fs.readFileSync(getVersionFilePath(), 'utf8').trim();
  } catch {
    try {
      const pkg = require('../../package.json');
      return pkg.dependencies?.['@deepseek-ai/dsh'] || '0.1.0-rc.6';
    } catch {
      return '0.1.0-rc.6';
    }
  }
}

function getBundledTriple() {
  const manifest = readBundledManifest();
  if (manifest?.triple) return manifest.triple;
  return SUPPORTED_TRIPLE;
}

// --- SSH plumbing ---

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

// --- Remote host probing ---

// Probe the remote host for OS, architecture, and libc family. Returns
// { platform, arch, libc, triple } or throws if unsupported. Only linux-x64-gnu
// is supported; everything else is rejected with a descriptive error.
async function probeRemoteHost(settings, opts = {}) {
  // uname -s: Linux|Darwin|..., uname -m: x86_64|aarch64|..., libc detection via
  // the dynamic linker path or ldd (avoid shell-evaluating any remote output).
  const command = `set -e; UNAME_S=$(uname -s); UNAME_M=$(uname -m); LIBC=unknown; if [ "$UNAME_S" = "Linux" ]; then if [ -e /lib/ld-musl-x86_64.so.1 ] || ls /lib/ld-musl-* >/dev/null 2>&1; then LIBC=musl; elif [ -e /lib64/ld-linux-x86-64.so.2 ] || [ -e /lib/ld-linux-x86-64.so.2 ] || (ldd --version 2>/dev/null | grep -qi 'glibc\\|GNU libc'); then LIBC=gnu; fi; fi; case "$UNAME_M" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) ARCH="$UNAME_M" ;; esac; case "$UNAME_S" in Linux) PLATFORM=linux ;; Darwin) PLATFORM=darwin ;; *) PLATFORM=$(echo "$UNAME_S" | tr '[:upper:]' '[:lower:]') ;; esac; echo "PLATFORM:$PLATFORM"; echo "ARCH:$ARCH"; echo "LIBC:$LIBC"; echo "TRIPLE:$PLATFORM-$ARCH-$LIBC"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  const kv = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const platform = kv.PLATFORM || 'unknown';
  const arch = kv.ARCH || 'unknown';
  const libc = kv.LIBC || 'unknown';
  const triple = `${platform}-${arch}-${libc}`;
  const supported = platform === 'linux' && arch === 'x64' && libc === 'gnu';
  return { platform, arch, libc, triple, supported };
}

// --- Remote identity check ---

// Read the manifest installed on the remote (if any), parse it safely, and
// return the identity. A legacy install has no manifest and must be reinstalled.
async function readRemoteManifest(settings, opts = {}) {
  const command = `if test -f ${DSH_REMOTE_MANIFEST_FILE}; then cat ${DSH_REMOTE_MANIFEST_FILE}; else echo "NO_MANIFEST"; fi`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  if (stdout.trim() === 'NO_MANIFEST') return null;
  try {
    return JSON.parse(stdout);
  } catch {
    // Malformed manifest on the remote -- treat as missing (force reinstall).
    return null;
  }
}

// Verify that the installed remote DSH matches the bundled manifest:
//  - binary exists and is executable
//  - manifest triple matches supported triple
//  - manifest digest matches the actual on-disk tarball? No: we verify the
//    extracted files' identity via the version file and manifest presence,
//    because we don't keep the tarball on the remote.
//  - version matches bundled version
// Returns { ok: true } or { ok: false, reason: 'legacy'|'mismatch'|'missing', detail }.
async function checkRemoteIdentity(settings, opts = {}) {
  const bundledVersion = opts.bundledVersion || getBundledDshVersion();
  const bundledTriple = opts.bundledTriple || getBundledTriple();
  const bundledDigest = opts.bundledDigest || readBundledManifest()?.digest || '';

  // First check binary exists.
  const binCheckCmd = `if test -x ${DSH_REMOTE_BIN}; then echo BIN_OK; else echo BIN_MISSING; fi`;
  const { stdout: binOut } = await runRemoteCommand(settings, binCheckCmd, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  if (!binOut.includes('BIN_OK')) {
    return { ok: false, reason: 'missing', detail: `DSH binary not found at ${DSH_REMOTE_BIN}` };
  }

  const manifest = await readRemoteManifest(settings, opts);
  if (!manifest) {
    return { ok: false, reason: 'legacy', detail: 'Legacy install without manifest; forced reinstall required' };
  }
  if (manifest.triple !== bundledTriple) {
    return { ok: false, reason: 'mismatch', detail: `Remote triple ${manifest.triple} does not match bundled ${bundledTriple}` };
  }
  if (manifest.version !== bundledVersion) {
    return { ok: false, reason: 'mismatch', detail: `Remote version ${manifest.version} does not match bundled ${bundledVersion}` };
  }
  // Compare bundle digest to detect redeployments after bundle rebuild.
  // Without this, a runner with the same version/triple but different
  // native module contents (e.g. one deployed by an app whose bundle was built
  // on the wrong host) is reused instead of being replaced.
  if (bundledDigest && manifest.digest !== bundledDigest) {
    return { ok: false, reason: 'mismatch', detail: `Remote bundle digest ${manifest.digest} does not match bundled ${bundledDigest}` };
  }
  // Verify version file also matches (defense in depth).
  const versionCheckCmd = `if test -f ${DSH_REMOTE_VERSION_FILE} && grep -qFx '${bundledVersion}' ${DSH_REMOTE_VERSION_FILE}; then echo V_OK; else echo V_MISMATCH; fi`;
  const { stdout: vOut } = await runRemoteCommand(settings, versionCheckCmd, { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  if (!vOut.includes('V_OK')) {
    return { ok: false, reason: 'mismatch', detail: 'Remote version file mismatch' };
  }
  return { ok: true, manifest };
}

// --- Transfer with atomic staging deployment and digest verification ---

// Transfer the bundle to the remote. Uses a staging directory, verifies
// sha256 digest of the received tarball against the manifest, extracts only if
// digest matches, and atomically swaps the runner directory. On any failure,
// the existing runner is preserved and the staging directory is cleaned up;
// error messages include recent log tail for diagnosis.
async function transferRemoteDsh(settings, opts = {}) {
  const bundlePath = opts.bundlePath || getBundlePath();
  const manifest = opts.manifest || readBundledManifest();
  if (!manifest) {
    throw new Error('DSH bundle manifest not found. The application may not have been built correctly.');
  }

  opts.onProgress?.('remote-probing', '正在检查远程服务器环境...');

  const probe = await probeRemoteHost(settings, opts);
  if (!probe.supported) {
    throw new Error(
      `Remote host is ${probe.triple}, but only ${SUPPORTED_TRIPLE} is supported. ` +
      `DSH remote execution requires a Linux x86_64 host with glibc (most common Linux distributions).`
    );
  }
  if (manifest.triple !== SUPPORTED_TRIPLE) {
    throw new Error(
      `Bundled DSH is for ${manifest.triple}, but only ${SUPPORTED_TRIPLE} remote hosts are supported.`
    );
  }

  opts.onProgress?.('remote-transferring', '正在传输 DSH 到远程服务器...');

  try {
    fs.accessSync(bundlePath, fs.constants.R_OK);
  } catch {
    throw new Error('DSH bundle not found. The application may not have been built correctly.');
  }

  const expectedDigest = manifest.digest || '';
  const version = manifest.version;

  // Atomic staging deployment:
  //   1. Create a unique staging directory under ~/.local/state/dsh/
  //   2. Receive tarball into staging/bundle.tgz
  //   3. Compute sha256 of the received file; compare to expected digest
  //   4. Extract tarball into staging/
  //   5. Write manifest and version file into staging/
  //   6. Smoke-test the extracted binary with --version
  //   7. Atomically replace runner with staging via rm + mv
  //   8. Clean up on any failure, capturing log tail
  const STAGE = `${DSH_REMOTE_BASE_DIR}/runner.staging.$$.$(date +%s%N 2>/dev/null || echo $$)`;
  const remoteScript = `set -u
FAIL_LOG=''
fail() {
  FAIL_LOG="$1"
  echo "INSTALL_FAILED"
  if [ -n "$FAIL_LOG" ]; then echo "---FAIL_LOG---"; echo "$FAIL_LOG" | tail -n 40; echo "---END_FAIL---"; fi
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf "$STAGE"; fi
  exit 1
}
STAGE=''
trap 'fail "interrupted"' INT TERM
mkdir -p ${DSH_REMOTE_BASE_DIR} || fail "failed to create ${DSH_REMOTE_BASE_DIR}"
STAGE=$(mktemp -d "${DSH_REMOTE_BASE_DIR}/runner.staging.XXXXXX") 2>/dev/null || STAGE="${DSH_REMOTE_BASE_DIR}/runner.staging.$$"
mkdir -p "$STAGE" || fail "failed to create staging dir $STAGE"
cat > "$STAGE/bundle.tgz"
RECEIVED_DIGEST=$(sha256sum "$STAGE/bundle.tgz" 2>/dev/null | awk '{print $1}')
if [ -z "$RECEIVED_DIGEST" ]; then
  RECEIVED_DIGEST=$(shasum -a 256 "$STAGE/bundle.tgz" 2>/dev/null | awk '{print $1}')
fi
if [ "sha256:$RECEIVED_DIGEST" != "${expectedDigest}" ]; then
  fail "digest mismatch: expected ${expectedDigest}, got sha256:$RECEIVED_DIGEST"
fi
	mkdir -p "$STAGE/node_modules" || fail "failed to create node_modules dir"
	tar xzf "$STAGE/bundle.tgz" -C "$STAGE/node_modules" 2>"$STAGE/extract.err" || fail "tar extract failed: $(cat "$STAGE/extract.err" 2>/dev/null)"
rm -f "$STAGE/bundle.tgz" "$STAGE/extract.err"
cat > "$STAGE/.dsh-manifest.json" <<'MANIFEST_EOF'
${JSON.stringify(manifest)}
MANIFEST_EOF
echo '${version}' > "$STAGE/.dsh-version" || fail "failed to write version file"
if ! test -x "$STAGE/node_modules/.bin/dsh"; then fail "extracted dsh binary is not executable at $STAGE/node_modules/.bin/dsh"; fi
"$STAGE/node_modules/.bin/dsh" --version >"$STAGE/smoke.out" 2>"$STAGE/smoke.err" || fail "dsh --version failed: $(cat "$STAGE/smoke.err" 2>/dev/null)"
${REQUIRED_REMOTE_NATIVES.map(entry => `if ! test -f "$STAGE/node_modules/${entry}"; then fail "bundle is missing the ${SUPPORTED_TRIPLE} native module ${entry}; the desktop app shipped a bundle that was not built on a Linux x64 glibc host"; fi`).join('\n')}
# The runner directory is about to be replaced. A dsh started from the old one
# keeps running code that no longer exists on disk and keeps holding its port
# and its plugin locks (the task-board ledger, for one), so the next start
# collides with it. Stop it here -- after the smoke tests, so a failed install
# never takes down a working instance.
read_managed_pid() {
  RESULT=''
  if [ -f "$1" ]; then
    while IFS= read -r LINE; do
      case "$LINE" in
        PID=*)
          VALUE=\${LINE#PID=}
          case "$VALUE" in ''|*[!0-9]*) ;; *) RESULT=$VALUE ;; esac
          ;;
      esac
    done < "$1"
  fi
  echo "$RESULT"
}
# A metadata file can outlive the process it names (that is how this bug was
# found), and the kernel recycles pids -- so confirm the pid still belongs to a
# dsh started from this runner before signalling it. Unverifiable means leave it
# alone: an orphaned runner is recoverable, killing an unrelated process is not.
${SHELL_IS_MANAGED_DSH}
for META in "${DSH_REMOTE_METADATA_FILE}" "${DSH_REMOTE_LEGACY_METADATA_FILE}"; do
  OLD_PID=$(read_managed_pid "$META")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null && is_managed_dsh "$OLD_PID"; then
    kill "$OLD_PID" 2>/dev/null || true
    WAITED=0
    while [ "$WAITED" -lt 10 ] && kill -0 "$OLD_PID" 2>/dev/null; do
      sleep 1
      WAITED=$((WAITED + 1))
    done
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$META"
done
# Atomic replacement: move old runner aside, move staging into place, then restore user-installed plugins from the old installation.
	if [ -d "${DSH_REMOTE_RUNNER_DIR}" ]; then
	  mv "${DSH_REMOTE_RUNNER_DIR}" "${DSH_REMOTE_RUNNER_DIR}.old" || fail "failed to move old runner aside"
	  mv "$STAGE" "${DSH_REMOTE_RUNNER_DIR}" || {
	    mv "${DSH_REMOTE_RUNNER_DIR}.old" "${DSH_REMOTE_RUNNER_DIR}"
	    fail "failed to move staging into place, old runner restored"
	  }
	  # Restore user-installed profile plugins into the runner so the loader can resolve them.
	  for prof_dir in "$HOME/.dsh/profiles/"*/; do
	    if [ -d "$prof_dir/node_modules" ]; then
	      for pkg in "$prof_dir/node_modules/"*/; do
	        pkgname=$(basename "$pkg")
	        if [ ! -e "${DSH_REMOTE_RUNNER_DIR}/node_modules/$pkgname" ]; then
	          cp -r "$pkg" "${DSH_REMOTE_RUNNER_DIR}/node_modules/" 2>/dev/null || true
	        fi
	      done
	    fi
	  done
	  rm -rf "${DSH_REMOTE_RUNNER_DIR}.old" 2>/dev/null || true
	else
	  mv "$STAGE" "${DSH_REMOTE_RUNNER_DIR}" || fail "failed to move staging into place"
	fi
echo "done"
`;

  const stdin = fs.createReadStream(bundlePath);
  const { stdout } = await runRemoteCommand(settings, remoteScript, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? 600_000,
    stdin,
  });

  if (stdout.includes('INSTALL_FAILED')) {
    const failMatch = stdout.match(/---FAIL_LOG---\n([\s\S]*?)\n---END_FAIL---/);
    const log = failMatch ? failMatch[1].trim() : '';
    throw new Error(`Remote DSH installation failed${log ? `:\n${log}` : ''}`);
  }

  return { output: stdout, manifest };
}

// --- DSH process lifecycle ---

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
  // Auto-install if requested.
  if (opts.autoInstall === true) {
    const identity = await checkRemoteIdentity(settings, opts).catch(() => ({ ok: false, reason: 'missing' }));
    if (!identity.ok) {
      opts.onProgress?.('remote-probing', '正在检查远程服务器环境...');
      await transferRemoteDsh(settings, opts);
      const recheck = await checkRemoteIdentity(settings, opts);
      if (!recheck.ok) {
        throw new Error(`DSH transfer completed but identity check failed: ${recheck.detail}`);
      }
      opts.onProgress?.('remote-start', '传输完成，正在启动远程 DSH...');
    }
  } else {
    // Even without autoInstall, verify the host triple is supported.
    const probe = await probeRemoteHost(settings, opts).catch(() => null);
    if (probe && !probe.supported) {
      throw new Error(
        `Remote host is ${probe.triple}, but only ${SUPPORTED_TRIPLE} is supported.`
      );
    }
  }

  // Reuse a healthy desktop-managed service, otherwise launch one whose
  // metadata and log survive the SSH session and desktop application.
  const existing = await discoverRemoteDsh(settings, opts);
  if (existing.running) {
    // Health-check the existing instance before reusing it.
    const healthy = await performRemoteHealthCheck(settings, existing.port, opts).catch(() => false);
    if (healthy) return { pid: existing.pid, port: existing.port, discovered: true };
    // Stale metadata -- clean it up before starting a fresh instance.
    await runRemoteCommand(settings, `rm -f ${DSH_REMOTE_METADATA_FILE}; kill ${existing.pid} 2>/dev/null || true`, opts).catch(() => {});
  }

  // Sync user-installed profile plugins into the runner node_modules so the
  // loader can resolve them. This must happen every start, not just during
  // transfer, because the identity check may pass (version match) and skip the
  // transfer entirely.
  // Sync user-installed plugins from profile into runner. Only copy
  // scoped packages that are NOT @deepseek-ai or @types — user-installed
  // plugins like @nanmicoder/dsh-agent-teams. We must avoid copying native
  // modules (node-pty, koffi, etc.) which are platform-specific and already
  // provided by the bundle.
  const syncPluginsCmd = `for prof_dir in "$HOME/.dsh/profiles/"*/; do
    if [ -d "$prof_dir/node_modules" ]; then
      for pkg in "$prof_dir/node_modules/"@*/; do
        pkgname=$(basename "$pkg")
        case "$pkgname" in @deepseek-ai|@types) continue ;; esac
        if [ ! -d "${DSH_REMOTE_RUNNER_DIR}/node_modules/$pkgname" ]; then
          cp -r "$pkg" "${DSH_REMOTE_RUNNER_DIR}/node_modules/$pkgname" 2>/dev/null || true
        fi
      done
    fi
  done`;
  await runRemoteCommand(settings, syncPluginsCmd, { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 }).catch(() => {});

  const startCmd = `mkdir -p ${DSH_REMOTE_RUNNER_DIR}; rm -f ${DSH_REMOTE_METADATA_FILE}; nohup node --expose-internals ${DSH_REMOTE_BIN} web --port 0 > ${DSH_REMOTE_LOG_FILE} 2>&1 < /dev/null & PID=$!; for i in $(seq 1 30); do PORT=$(grep -oE 'http://127\\.0\\.0\\.1:[0-9]+' ${DSH_REMOTE_LOG_FILE} 2>/dev/null | tail -n 1 | grep -oE '[0-9]+$'); if [ -n "$PORT" ]; then printf 'PID=%s\\nPORT=%s\\n' "$PID" "$PORT" > ${DSH_REMOTE_METADATA_FILE}; echo "PID:$PID PORT:$PORT"; exit 0; fi; if ! kill -0 "$PID" 2>/dev/null; then echo "EXITED"; echo "---LOG---"; tail -n 40 ${DSH_REMOTE_LOG_FILE} 2>/dev/null; echo "---END---"; exit 1; fi; sleep 1; done; kill "$PID" 2>/dev/null; rm -f ${DSH_REMOTE_METADATA_FILE}; echo "TIMEOUT"; exit 1`;
  const { stdout } = await runRemoteCommand(settings, startCmd, { ...opts, timeoutMs: opts.timeoutMs ?? 45_000 });

  const pidMatch = stdout.match(/PID:(\d+)/);
  const portMatch = stdout.match(/PORT:(\d+)/);
  if (!pidMatch || !portMatch) {
    const logMatch = stdout.match(/---LOG---\n([\s\S]*?)\n---END---/);
    const log = logMatch ? logMatch[1].trim() : '';
    if (stdout.includes('EXITED')) {
      throw new Error(`Remote DSH exited before starting${log ? `:\n${log}` : ''}`);
    }
    if (stdout.includes('TIMEOUT')) throw new Error('Remote DSH startup timed out (30s)');
    throw new Error(`Unexpected output from remote DSH start: ${stdout}`);
  }

  const pid = Number(pidMatch[1]);
  const port = Number(portMatch[1]);

  // Runtime health check: confirm the HTTP endpoint is serving DSH content.
  const healthy = await performRemoteHealthCheck(settings, port, opts).catch(err => {
    throw new Error(`Remote DSH started but health check failed: ${err.message}`);
  });
  if (!healthy) {
    throw new Error('Remote DSH started but did not respond to health checks');
  }

  return { pid, port, discovered: false };
}

// Perform a runtime health check by curling the remote DSH over an SSH tunnel
// is impractical here (no tunnel yet), so we ask the remote host itself to curl
// the loopback endpoint.
async function performRemoteHealthCheck(settings, port, opts = {}) {
  // Use node to make the HTTP request instead of curl, because curl is not
  // guaranteed to be installed on all Linux distributions. Node is always
  // available since we just used it to start dsh.
  const cmd = `for i in $(seq 1 20); do
    BODY=$(node -e "
      const http = require('http');
      http.get('http://127.0.0.1:${port}/', { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { process.stdout.write(data); });
      }).on('error', () => {});
    " 2>/dev/null || true);
    if echo "$BODY" | grep -q 'DeepSeek'; then echo "HEALTHY"; exit 0; fi;
    sleep 0.5;
  done; echo "UNHEALTHY"; exit 1`;
  const { stdout } = await runRemoteCommand(settings, cmd, { ...opts, timeoutMs: opts.timeoutMs ?? 20_000 });
  return stdout.includes('HEALTHY');
}

// Stop the desktop-managed dsh and do not return until it is actually gone.
//
// `kill` succeeds as soon as the signal is *sent*, so reporting success there --
// and deleting the metadata there -- leaves a live process the desktop can no
// longer see. The next start then races it and loses: the survivor still owns
// singleton resources like the task-board ledger lock, and the new instance dies
// with "ledger is already owned by process N". Wait for the exit instead, and
// only drop the metadata once there is nothing left to record.
async function stopRemoteDsh(settings, pid, opts = {}) {
  const explicitPid = Number.isSafeInteger(pid) && pid > 0 ? String(pid) : '';
  const command = `PID=${explicitPid}
if test -z "$PID" && test -f ${DSH_REMOTE_METADATA_FILE}; then
  while IFS= read -r LINE; do
    case "$LINE" in
      PID=*) VALUE=\${LINE#PID=}; case "$VALUE" in ''|*[!0-9]*) ;; *) PID=$VALUE ;; esac ;;
    esac
  done < ${DSH_REMOTE_METADATA_FILE}
fi
if test -z "$PID"; then echo "not-found"; exit 0; fi
${SHELL_IS_MANAGED_DSH}
if ! is_managed_dsh "$PID"; then
  # Already gone, or the pid was recycled by an unrelated process.
  rm -f ${DSH_REMOTE_METADATA_FILE}
  echo "not-found"
  exit 0
fi
kill "$PID" 2>/dev/null || true
WAITED=0
while [ "$WAITED" -lt 10 ] && kill -0 "$PID" 2>/dev/null; do
  sleep 1
  WAITED=$((WAITED + 1))
done
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID" 2>/dev/null || true
  WAITED=0
  while [ "$WAITED" -lt 3 ] && kill -0 "$PID" 2>/dev/null; do
    sleep 1
    WAITED=$((WAITED + 1))
  done
fi
if kill -0 "$PID" 2>/dev/null; then
  echo "stop-failed: process $PID survived SIGKILL" >&2
  exit 1
fi
rm -f ${DSH_REMOTE_METADATA_FILE}
echo "stopped"`;
  const { stdout } = await runRemoteCommand(settings, command, { ...opts, timeoutMs: opts.timeoutMs ?? 30_000 });
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

module.exports = {
  DSH_REMOTE_BIN,
  DSH_REMOTE_LEGACY_METADATA_FILE,
  DSH_REMOTE_LOG_FILE,
  DSH_REMOTE_MANIFEST_FILE,
  DSH_REMOTE_METADATA_FILE,
  DSH_REMOTE_RUNNER_DIR,
  DSH_REMOTE_VERSION_FILE,
  REQUIRED_REMOTE_NATIVES,
  SUPPORTED_TRIPLE,
  buildRemoteSshArgs,
  checkRemoteIdentity,
  discoverRemoteDsh,
  getBundledDshVersion,
  getBundledTriple,
  getBundlePath,
  getManifestPath,
  getRemoteDshLog,
  getRemoteDshProcessDetails,
  getRemoteDshStatus,
  getRemoteDshVersion,
  getVersionFilePath,
  performRemoteHealthCheck,
  probeRemoteHost,
  readBundledManifest,
  readRemoteManifest,
  startRemoteDsh,
  stopRemoteDsh,
  transferRemoteDsh,
  updateRemoteDsh,
};
