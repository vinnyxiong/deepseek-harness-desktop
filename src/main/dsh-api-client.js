const { randomUUID } = require('crypto');

async function callDsh(endpoint, method, payload = {}, { signal, timeoutMs = 10_000, fetchImpl = fetch } = {}) {
  const rpcId = randomUUID();
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(`${endpoint}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: combined,
  });
  if (!response.ok) throw new Error(`DSH API ${method} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.type !== 'server-response' || body.rpcId !== rpcId || typeof body.result?.ok !== 'boolean') throw new Error(`Invalid DSH API response for ${method}`);
  if (!body.result.ok) throw new Error(body.result.error?.message || `DSH API ${method} failed`);
  return body.result.value;
}

module.exports = { callDsh };
