const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'dsh');
const DSH_RUNNER_DIR = path.join(DSH_STATE_DIR, 'runner');
const INSTALLED_DSH_BIN = path.join(DSH_RUNNER_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const INSTALL_TIMEOUT_MS = 600_000;

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
// npm writes most progress to stderr with control chars and progress bars.
// We buffer chunks and extract meaningful patterns.
let _npmBuf = '';

function npmProgressLabel(text) {
  _npmBuf += text;
  // Keep only the last 2KB to avoid unbounded growth
  if (_npmBuf.length > 2048) _npmBuf = _npmBuf.slice(-2048);

  // Strip control characters to get clean lines
  const clean = _npmBuf.replace(/\r[^\n]*/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '').trim();

  const patterns = [
    // npm v10+ reify output
    { re: /(?:added|removed|changed) (\d+) packages?/, label: (m) => `已安装 ${m[1]} 个包` },
    { re: /reify:.*?timing.*?Completed in/i, label: () => '正在完成安装...' },
    { re: /idealTree:timing/i, label: () => '正在解析依赖树...' },
    { re: /idealTree:.*?diff/i, label: () => '正在计算依赖差异...' },
    { re: /reify:timing/i, label: () => '正在安装包...' },
    { re: /reify:@deepseek/i, label: () => '正在安装 DSH...' },
    { re: /http fetch GET \d+/i, label: () => '正在下载包...' },
    // Simple fallback: any line with "fetch" or "install" or "package"
    { re: /(?:packages?|fetch|install|download|resolve)/i, label: () => '正在安装 DSH...' },
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
      '@deepseek-ai/dsh',
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
  findBin,
  getInstalledDshBinPath,
  installDshLocal,
  isDshInstalled,
};