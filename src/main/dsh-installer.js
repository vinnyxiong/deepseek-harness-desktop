const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DSH_STATE_DIR = path.join(os.homedir(), '.local', 'state', 'dsh');
const DSH_RUNNER_DIR = path.join(DSH_STATE_DIR, 'runner');
const INSTALLED_DSH_BIN = path.join(DSH_RUNNER_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const INSTALL_TIMEOUT_MS = 120_000;

// Common npm locations on macOS (Homebrew, system, nvm) and Linux
const NPM_CANDIDATES = [
  '/opt/homebrew/bin/npm',
  '/usr/local/bin/npm',
  '/usr/bin/npm',
  '/bin/npm',
];

function resolveNpmPath() {
  // 1. Try known paths first
  for (const candidate of NPM_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not at this path
    }
  }

  // 2. Try each directory in PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'npm');
    if (candidate === NPM_CANDIDATES[0] || candidate === NPM_CANDIDATES[1] ||
        candidate === NPM_CANDIDATES[2] || candidate === NPM_CANDIDATES[3]) {
      continue; // Already checked
    }
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not at this path
    }
  }

  // 3. Try ~/.nvm/ (Node Version Manager)
  try {
    const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
    if (fs.statSync(nvmDir).isDirectory()) {
      const versions = fs.readdirSync(nvmDir);
      // Use the latest version first
      versions.sort().reverse();
      for (const version of versions) {
        const candidate = path.join(nvmDir, version, 'bin', 'npm');
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // Not at this path
        }
      }
    }
  } catch {
    // nvm directory doesn't exist or can't be read
  }

  // 4. Fall back to login shell lookup
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-l', '-c', 'which npm 2>/dev/null'], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const npmPath = result.trim();
    if (npmPath) {
      try {
        fs.accessSync(npmPath, fs.constants.X_OK);
        return npmPath;
      } catch {
        // found but not executable
      }
    }
  } catch {
    // shell lookup failed
  }

  return null;
}

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
  npmPath = resolveNpmPath(),
} = {}) {
  // Ensure the install directory exists
  await fs.promises.mkdir(DSH_RUNNER_DIR, { recursive: true });

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
  NPM_CANDIDATES,
  getInstalledDshBinPath,
  installDshLocal,
  isDshInstalled,
  resolveNpmPath,
};