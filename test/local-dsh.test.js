const assert = require('node:assert/strict');
const test = require('node:test');
const { SERVER_URL_PATTERN } = require('../src/main/local-dsh');

test('matches the local dsh readiness URL and port', () => {
  const match = 'log\ndsh web: http://127.0.0.1:49188\n'.match(SERVER_URL_PATTERN);
  assert.equal(match[1], 'http://127.0.0.1:49188');
  assert.equal(match[2], '49188');
});

test('does not accept non-loopback startup URLs', () => {
  assert.equal('dsh web: http://10.0.0.2:3080'.match(SERVER_URL_PATTERN), null);
});
