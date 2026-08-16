const { spawn } = require('child_process');
const path = require('path');
const { createRequire } = require('module');
const { createDiagnosticBuffer, terminateChild } = require('./process-utils');

const require_ = createRequire(__filename);
const STARTUP_TIMEOUT_MS = 30_000;
const SERVER_URL_PATTERN = /dsh web:\s+(http:\/\/127\.0\.0\.1:(\d+))/;

function resolveDshBin({ isPackaged, resourcesPath }) {
  if (!isPackaged) return require_.resolve('@deepseek-ai/dsh/lib/bin.js');
  return path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
}

async function startLocalDsh({
  executablePath,
  resourcesPath,
  isPackaged,
  dshHome,
  onUnexpectedExit,
  spawnImpl = spawn,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
}) {
  const diagnostics = createDiagnosticBuffer();
  const child = spawnImpl(
    executablePath,
    ['--expose-internals', resolveDshBin({ isPackaged, resourcesPath }), 'web', '--port', '0'],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: dshHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    },
  );

  let started = false;
  let expectedExit = false;
  let exited = false;
  let exitDetails = null;
  let outputBuffer = '';
  let settle;
  let fail;
  const startedPromise = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const onOutput = chunk => {
    const text = chunk.toString();
    diagnostics.append(text);
    process.stdout.write(`[dsh] ${text}`);
    if (started) return;
    outputBuffer = `${outputBuffer}${text}`.slice(-4096);
    const match = outputBuffer.match(SERVER_URL_PATTERN);
    if (!match) return;
    started = true;
    settle({ endpoint: match[1], port: Number.parseInt(match[2], 10) });
  };

  child.stdout?.on('data', onOutput);
  child.stderr?.on('data', chunk => {
    diagnostics.append(chunk);
    process.stderr.write(`[dsh] ${chunk.toString()}`);
  });
  child.once('error', error => {
    diagnostics.append(error.stack ?? error.message);
    if (!started) fail(error);
  });
  child.once('exit', (code, signal) => {
    exited = true;
    exitDetails = { code, signal };
    if (!started) {
      fail(new Error(
        `dsh exited before starting (code=${code}, signal=${signal})\n${diagnostics.toString()}`,
      ));
      return;
    }
    if (!expectedExit) onUnexpectedExit?.({ code, signal, diagnostics: diagnostics.toString() });
  });

  const timeout = setTimeout(() => {
    if (!started) fail(new Error(`dsh startup timed out after ${startupTimeoutMs / 1000}s`));
  }, startupTimeoutMs);

  try {
    const ready = await startedPromise;
    clearTimeout(timeout);
    if (exited) {
      throw new Error(
        `dsh exited during startup (code=${exitDetails.code}, signal=${exitDetails.signal})\n${diagnostics.toString()}`,
      );
    }
    return {
      mode: 'local',
      endpoint: ready.endpoint,
      port: ready.port,
      owned: true,
      diagnostics: () => diagnostics.toString(),
      isRunning: () => !exited,
      async stop() {
        expectedExit = true;
        await terminateChild(child, { killTree: true });
      },
    };
  } catch (error) {
    clearTimeout(timeout);
    expectedExit = true;
    await terminateChild(child, { killTree: true });
    throw error;
  }
}

module.exports = { SERVER_URL_PATTERN, resolveDshBin, startLocalDsh };
