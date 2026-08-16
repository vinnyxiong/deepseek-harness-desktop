const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { probeDsh, waitForDsh } = require('../src/main/dsh-health');

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('accepts a DeepSeek Harness page', async () => {
  const server = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<title>DeepSeek Harness</title>');
  });
  try {
    assert.equal(await probeDsh(server.url), true);
  } finally {
    await server.close();
  }
});

test('rejects a different service on the selected port', async () => {
  const server = await serve((_request, response) => response.end('another service'));
  try {
    await assert.rejects(() => probeDsh(server.url), /not a DeepSeek Harness service/);
  } finally {
    await server.close();
  }
});

test('rejects redirects instead of following another origin', async () => {
  const server = await serve((_request, response) => {
    response.writeHead(302, { location: 'https://example.com/' });
    response.end();
  });
  try {
    await assert.rejects(() => probeDsh(server.url), /redirected/);
  } finally {
    await server.close();
  }
});

test('times out when no service listens on the port', async () => {
  const server = await serve((_request, response) => response.end('unused'));
  const port = new URL(server.url).port;
  await server.close();
  await assert.rejects(
    () => waitForDsh(`http://127.0.0.1:${port}`, { timeoutMs: 80, intervalMs: 10 }),
    /not reachable/,
  );
});
