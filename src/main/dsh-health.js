const { wait } = require('./process-utils');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 250;

function describeRequestError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'request timed out';
  if (error?.cause?.code === 'ECONNREFUSED') return 'nothing is listening on that port';
  return error?.message || String(error);
}

async function probeDsh(url, { signal, requestTimeoutMs = 3_000 } = {}) {
  const expected = new URL(url);
  const response = await fetch(expected, {
    redirect: 'manual',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error('The service redirected to another address');
  }
  if (response.status !== 200) {
    throw new Error(`The service returned HTTP ${response.status}`);
  }

  const body = await response.text();
  if (!body.includes('DeepSeek Harness')) {
    throw new Error('The selected port is open, but it is not a DeepSeek Harness service');
  }
  return true;
}

async function waitForDsh(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  signal,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason ?? new Error('Connection attempt was cancelled');
    try {
      await probeDsh(url, { signal });
      return true;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      lastError = error;
    }
    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new Error(`DeepSeek Harness was not reachable at ${url}: ${describeRequestError(lastError)}`);
}

module.exports = { describeRequestError, probeDsh, waitForDsh };
