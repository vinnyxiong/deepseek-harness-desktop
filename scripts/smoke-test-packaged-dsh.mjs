#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STARTUP_TIMEOUT_MS = 60_000;
const STABILITY_DELAY_MS = 1_000;
const URL_PATTERN = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/;

function usage() {
  console.error('Usage: node scripts/smoke-test-packaged-dsh.mjs <electron-executable> <resources-directory>');
}

async function wait(ms) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolvePromise => child.once('exit', () => resolvePromise(true))),
    wait(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  const [electronArgument, resourcesArgument] = process.argv.slice(2);
  if (!electronArgument || !resourcesArgument) {
    usage();
    process.exitCode = 2;
    return;
  }

  const electronPath = resolve(electronArgument);
  const resourcesPath = resolve(resourcesArgument);
  const dshBin = join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  const home = await mkdtemp(join(tmpdir(), 'deepseek-harness-desktop-smoke-'));
  const logFile = join(home, 'dsh.log');
  let smokePassed = false;
  let log = '';
  let settled = false;
  let resolveUrl;
  let rejectUrl;
  const urlPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveUrl = resolvePromise;
    rejectUrl = rejectPromise;
  });

  const child = spawn(
    electronPath,
    ['--expose-internals', dshBin, 'web', '--port', '0'],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_HOME: join(home, 'dsh-home'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const onOutput = data => {
    const text = data.toString();
    log += text;
    process.stdout.write(text);
    if (settled) return;
    const match = log.match(URL_PATTERN);
    if (!match) return;
    settled = true;
    resolveUrl(match[1]);
  };

  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  child.once('error', error => {
    if (settled) return;
    settled = true;
    rejectUrl(error);
  });
  child.once('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    rejectUrl(new Error(`dsh exited before startup (code=${code}, signal=${signal})`));
  });

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectUrl(new Error(`dsh did not start within ${STARTUP_TIMEOUT_MS / 1000}s`));
  }, STARTUP_TIMEOUT_MS);

  try {
    const url = await urlPromise;
    clearTimeout(timeout);

    const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    if (response.status !== 200) throw new Error(`Expected HTTP 200, received ${response.status}`);
    if (!body.includes('DeepSeek Harness')) throw new Error('Web page does not contain the DeepSeek Harness title');

    await wait(STABILITY_DELAY_MS);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dsh exited after startup (code=${child.exitCode}, signal=${child.signalCode})`);
    }

    smokePassed = true;
    console.log(`Packaged dsh smoke test passed: ${url}`);
  } catch (error) {
    await import('node:fs/promises').then(({ writeFile }) => writeFile(logFile, log));
    throw new Error(`${error.message}\n--- dsh output ---\n${log}\nLog: ${logFile}`);
  } finally {
    clearTimeout(timeout);
    await stopChild(child);
    if (smokePassed) await rm(home, { recursive: true, force: true });
  }
}

main().catch(async error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
