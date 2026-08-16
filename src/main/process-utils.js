const { spawn } = require('child_process');

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createDiagnosticBuffer(limit = 16 * 1024) {
  let text = '';
  return {
    append(chunk) {
      text = `${text}${String(chunk)}`.slice(-limit);
    },
    toString() {
      return text;
    },
  };
}

function isAlive(child, killTree) {
  if (!child?.pid) return false;
  if (killTree && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error.code === 'EPERM';
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

function signalChild(child, signal, killTree) {
  if (!child?.pid) return;
  if (killTree && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return;
  }
  child.kill(signal);
}

async function forceKillWindowsTree(child) {
  if (!child?.pid || process.platform !== 'win32') return;
  await new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', reject);
    killer.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill.exe exited with code ${code}`));
    });
  });
}

async function terminateChild(child, { graceMs = 7_000, killTree = false } = {}) {
  if (!child?.pid || !isAlive(child, killTree)) return;

  if (killTree && process.platform === 'win32') {
    try {
      await forceKillWindowsTree(child);
      if (!isAlive(child, false)) return;
    } catch {
      // Fall back to direct signalling when taskkill cannot terminate the tree.
    }
    if (isAlive(child, false)) child.kill('SIGTERM');
    const deadline = Date.now() + graceMs;
    while (isAlive(child, false) && Date.now() < deadline) await wait(50);
    if (isAlive(child, false)) child.kill('SIGKILL');
    return;
  }

  signalChild(child, 'SIGTERM', killTree);
  const deadline = Date.now() + graceMs;
  while (isAlive(child, killTree) && Date.now() < deadline) await wait(50);

  if (isAlive(child, killTree)) {
    signalChild(child, 'SIGKILL', killTree);
    const killDeadline = Date.now() + 1_000;
    while (isAlive(child, killTree) && Date.now() < killDeadline) await wait(25);
  }
}

module.exports = {
  createDiagnosticBuffer,
  forceKillWindowsTree,
  isAlive,
  signalChild,
  terminateChild,
  wait,
};
