const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'dsh');
const DSH_RUNNER_DIR = path.join(DSH_STATE_DIR, 'runner');
const INSTALLED_DSH_BIN = path.join(DSH_RUNNER_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const INSTALL_TIMEOUT_MS = 120_000;

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

// Find npm by scanning PATH and common locations.
// This avoids spawning a login shell (slow) and works in Electron's
// minimal PATH environment.
function findNpm() {
  // 1. Common locations on macOS / Linux
  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/npm');
    candidates.push('/usr/local/bin/npm');
  }
  candidates.push('/usr/bin/npm');

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }

  // 2. Walk PATH directories
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'npm');
    if (candidates.includes(p)) continue; // already checked
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* not here */ }
  }

  return null;
}

async function installDshLocal({
  onProgress,
  spawnImpl = spawn,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  await fs.promises.mkdir(DSH_RUNNER_DIR, { recursive: true });

  const npmPath = findNpm();
  if (!npmPath) {
    throw new Error('npm is not available. Please install Node.js and npm first.');
  }

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
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error('npm install timed out'));
    }, timeoutMs);

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      onProgress?.('installing');
    });

    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
      onProgress?.('installing');
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
  findNpm,
  getInstalledDshBinPath,
  installDshLocal,
  isDshInstalled,
};