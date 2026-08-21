const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'dsh');
const DSH_RUNNER_DIR = path.join(DSH_STATE_DIR, 'runner');
const INSTALLED_DSH_BIN = path.join(DSH_RUNNER_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const INSTALL_TIMEOUT_MS = 900_000;

// Pin the DSH version to the one this app was built against, so the lite
// build never pulls a broken "latest" whose transitive deps may be missing
// from the registry. Falls back to a known-good version if unreadable.
function resolveDshVersion() {
  try {
    const pkg = require('../../package.json');
    const v = pkg.dependencies?.['@deepseek-ai/dsh'];
    if (v) return v;
  } catch { /* ignore */ }
  return '0.1.0-rc.6';
}

const DSH_VERSION = resolveDshVersion();
const DSH_PACKAGE_SPEC = `@deepseek-ai/dsh@${DSH_VERSION}`;


function isDshInstalled() {
  try {
    fs.accessSync(INSTALLED_DSH_BIN, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getInstalledDshBinPath() {
  return INSTALLED_DSH_BIN;
}

// Extract a short progress label from npm output.
// npm writes progress to stderr with control chars and progress bars.
// We buffer chunks and extract meaningful patterns.
let _npmBuf = '';

function npmProgressLabel(text) {
  _npmBuf += text;
  // Keep only the last 4KB to avoid unbounded growth
  if (_npmBuf.length > 4096) _npmBuf = _npmBuf.slice(-4096);

  // Strip ANSI control characters and progress spinners to get clean lines
  const clean = _npmBuf
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI escape sequences
    .replace(/[\r\x00-\x08\x0b\x0c\x0e-\x1f]/g, '\n')  // control chars
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')  // braille spinners
    .trim();

  const patterns = [
    // npm v10+ reify output (most common)
    { re: /added\s+(\d+)\s+packages?(?:\s+in\s+(\d+)s)?/i, label: (m) => `已安装 ${m[1]} 个包${m[2] ? ` (${m[2]}s)` : ''}` },
    { re: /(?:added|removed|changed)\s+(\d+)\s+packages?/i, label: (m) => `已安装 ${m[1]} 个包` },
    // npm v10+ reify stages
    { re: /reify:.*?Completed\s+in\s+(\d+)/i, label: (m) => `安装完成 (${m[1]}ms)` },
    { re: /reify:timing\s+reifyNode:node_modules/i, label: () => '正在安装包...' },
    { re: /reify:timing\s+reify/i, label: () => '正在安装包...' },
    { re: /reify:timing\s+audit/i, label: () => '正在审计...' },
    { re: /reify:timing/i, label: () => '正在安装包...' },
    { re: /idealTree:timing\s+diff/i, label: () => '正在计算依赖差异...' },
    { re: /idealTree:timing/i, label: () => '正在解析依赖树...' },
    { re: /reify:@deepseek/i, label: () => '正在安装 DSH...' },
    // http fetch progress
    { re: /http\s+fetch\s+GET\s+\d+/i, label: () => '正在下载包...' },
    // Any package-related progress
    { re: /(?:packages?|fetch|install|download|resolve|reify|idealTree)/i, label: () => '正在安装 DSH...' },
  ];

  for (const p of patterns) {
    const m = clean.match(p.re);
    if (m) return p.label(m);
  }
  return null;
}

// Find a binary by scanning known locations and PATH.
// Electron-packaged apps have a minimal PATH, so we need to search
// common installation directories directly.
function findBin(name) {
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(`/opt/homebrew/bin/${name}`);
    candidates.push(`/usr/local/bin/${name}`);
  }
  candidates.push(`/usr/bin/${name}`);
  candidates.push(`/bin/${name}`);

  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ }
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (candidates.includes(p)) continue;
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* not here */ }
  }
  return null;
}

async function installDshLocal({
  onProgress,
  spawnImpl = spawn,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  await fs.promises.mkdir(DSH_RUNNER_DIR, { recursive: true });

  onProgress?.('checking');

  const npmPath = findBin('npm');
  if (!npmPath) {
    throw new Error('npm is not available. Please install Node.js and npm first.');
  }
  const nodePath = findBin('node');
  if (!nodePath) {
    throw new Error('node is not available. Please install Node.js first.');
  }
  const binDir = path.dirname(nodePath);
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
  };

  onProgress?.('installing');

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnImpl(npmPath, [
      'install',
      '--prefix', DSH_RUNNER_DIR,
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      DSH_PACKAGE_SPEC,
    ], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error('npm install timed out'));
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      const label = npmProgressLabel(chunk.toString());
      if (label) onProgress?.('installing', label);
    });

    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      const label = npmProgressLabel(text);
      if (label) onProgress?.('installing', label);
    });

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to start npm: ${error.message}`));
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code === 0) {
        if (!isDshInstalled()) {
          reject(new Error('npm install completed but DSH binary was not found. Check npm output for errors.'));
          return;
        }
        onProgress?.('done');
        resolve({ success: true, path: INSTALLED_DSH_BIN });
      } else {
        const errorOutput = stderr || stdout || '';
        if (errorOutput.includes('EACCES') || errorOutput.includes('permission denied')) {
          reject(new Error(`Permission denied when installing DSH. Check permissions on ${DSH_RUNNER_DIR}.`));
        } else if (errorOutput.includes('ENOSPC') || errorOutput.includes('No space left')) {
          reject(new Error('Not enough disk space to install DSH.'));
        } else {
          reject(new Error(`npm install failed with exit code ${code}${signal ? ` (signal: ${signal})` : ''}\n${errorOutput.slice(-1024)}`));
        }
      }
    });
  });
}

module.exports = {
  DSH_STATE_DIR,
  DSH_RUNNER_DIR,
  INSTALLED_DSH_BIN,
  INSTALL_TIMEOUT_MS,
  DSH_VERSION,
  DSH_PACKAGE_SPEC,
  findBin,
  getInstalledDshBinPath,
  installDshLocal,
  isDshInstalled,
};