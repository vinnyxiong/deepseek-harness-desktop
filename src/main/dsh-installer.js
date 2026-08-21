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

async function installDshLocal({
  onProgress,
  spawnImpl = spawn,
  timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  // Ensure the install directory exists
  await fs.promises.mkdir(DSH_RUNNER_DIR, { recursive: true });

  // Use a login shell to run npm install so that the user's full shell
  // environment (PATH, nvm, fnm, etc.) is available. Electron-packaged
  // apps have a minimal PATH that doesn't include Homebrew or other
  // Node.js installation directories.
  const shell = process.env.SHELL || '/bin/zsh';
  const installCmd = `npm install --prefix "${DSH_RUNNER_DIR}" --no-audit --no-fund @deepseek-ai/dsh`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const child = spawnImpl(shell, ['-l', '-c', installCmd], {
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
      const text = chunk.toString();
      stdout += text;
      onProgress?.('installing');
    });

    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
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
        if (code === 127) {
          reject(new Error('npm is not available. Please install Node.js and npm first.'));
        } else if (errorOutput.includes('EACCES') || errorOutput.includes('permission denied')) {
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
  getInstalledDshBinPath,
  installDshLocal,
  isDshInstalled,
};