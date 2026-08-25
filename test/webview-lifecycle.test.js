'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWebviewLifecycle,
  STATES,
  INSTR,
} = require('../src/renderer/host-manager/webview-lifecycle.js');

// Helpers -------------------------------------------------------------------

// Collapse an instruction list into compact "type:hostId" tuples for assertions.
function ops(list) {
  return list.map((i) => (i.endpoint ? `${i.type}:${i.hostId}:${i.endpoint}` : `${i.type}:${i.hostId}`));
}

function types(list) {
  return list.map((i) => i.type);
}

// A host that is "connected then activated" — the common bring-up sequence.
function bringUp(lc, hostId, endpoint) {
  lc.setConnected(hostId, endpoint);
  return lc.setActive(hostId);
}

// --- CommonJS export shape -------------------------------------------------

test('module exports factory + enums for both load environments', () => {
  assert.equal(typeof createWebviewLifecycle, 'function');
  assert.equal(STATES.ACTIVE, 'active');
  assert.equal(INSTR.CREATE, 'create');
  const lc = createWebviewLifecycle();
  assert.equal(lc.getMaxLive(), 4); // default cap
});

// --- Basic active switching: show / hide -----------------------------------

test('basic active switch creates, shows, and hides prior host', () => {
  const lc = createWebviewLifecycle({ maxLive: 4 });

  // Connecting alone must not materialize anything for a non-active host.
  assert.deepEqual(lc.setConnected('a', 'ea'), []);

  assert.deepEqual(ops(lc.setActive('a')), ['create:a:ea', 'show:a']);
  assert.equal(lc.getState('a'), STATES.ACTIVE);

  lc.setConnected('b', 'eb');
  assert.deepEqual(ops(lc.setActive('b')), ['hide:a', 'create:b:eb', 'show:b']);
  assert.equal(lc.getState('a'), STATES.HIDDEN);
  assert.equal(lc.getState('b'), STATES.ACTIVE);

  // Switching back reuses the hidden element — just show, no re-create.
  assert.deepEqual(ops(lc.setActive('a')), ['hide:b', 'show:a']);
  assert.equal(lc.getState('a'), STATES.ACTIVE);
  assert.equal(lc.getState('b'), STATES.HIDDEN);

  // Re-selecting the already-active host is a no-op.
  assert.deepEqual(lc.setActive('a'), []);
});

test('activating before connected defers creation until endpoint arrives', () => {
  const lc = createWebviewLifecycle();
  // Select first, connect later (async connect flow).
  assert.deepEqual(lc.setActive('a'), []);
  assert.equal(lc.getState('a'), STATES.NONE);
  assert.equal(lc.getActiveHostId(), 'a');

  assert.deepEqual(ops(lc.setConnected('a', 'ea')), ['create:a:ea', 'show:a']);
  assert.equal(lc.getState('a'), STATES.ACTIVE);
});

// --- LRU: evict least-recently-used hidden ---------------------------------

test('LRU evicts the least-recently-used hidden instance on overflow', () => {
  const lc = createWebviewLifecycle({ maxLive: 2 });

  bringUp(lc, 'a', 'ea'); // active a
  bringUp(lc, 'b', 'eb'); // a hidden, b active  -> live = {a,b}

  // Activating c overflows the cap of 2: a (older hidden) must be evicted, not b.
  const out = bringUp(lc, 'c', 'ec');
  assert.deepEqual(ops(out), ['hide:b', 'evict:a', 'create:c:ec', 'show:c']);
  assert.equal(lc.getState('a'), STATES.EVICTED);
  assert.equal(lc.getState('b'), STATES.HIDDEN);
  assert.equal(lc.getState('c'), STATES.ACTIVE);
  assert.equal(lc.getLiveCount(), 2);
});

test('creating past the cap keeps live count bounded', () => {
  const lc = createWebviewLifecycle({ maxLive: 3 });
  ['a', 'b', 'c', 'd', 'e'].forEach((h) => bringUp(lc, h, `e${h}`));
  assert.equal(lc.getLiveCount(), 3);
  assert.equal(lc.getMaxLive(), 3);
  // Exactly one active at a time.
  const live = lc.getLiveHostIds();
  const active = live.filter((h) => lc.getState(h) === STATES.ACTIVE);
  assert.equal(active.length, 1);
  assert.equal(lc.getActiveHostId(), 'e');
});

// --- Evicted host re-activated => restore(endpoint) ------------------------

test('re-activating an evicted host restores it with its endpoint', () => {
  const lc = createWebviewLifecycle({ maxLive: 2 });
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb');
  bringUp(lc, 'c', 'ec'); // evicts a

  assert.equal(lc.getState('a'), STATES.EVICTED);

  const out = lc.setActive('a');
  // c hidden, then LRU evicts b (now the oldest hidden), then restore a + show.
  assert.deepEqual(ops(out), ['hide:c', 'evict:b', 'restore:a:ea', 'show:a']);
  assert.equal(lc.getState('a'), STATES.ACTIVE);
  assert.equal(lc.getState('b'), STATES.EVICTED);
});

// --- endpoint change => rebuild --------------------------------------------

test('endpoint change rebuilds the active webview', () => {
  const lc = createWebviewLifecycle();
  bringUp(lc, 'a', 'ea');

  const out = lc.setConnected('a', 'ea2');
  assert.deepEqual(ops(out), ['destroy:a', 'create:a:ea2', 'show:a']);
  assert.equal(lc.getEndpoint('a'), 'ea2');

  // Same endpoint again => no work.
  assert.deepEqual(lc.setConnected('a', 'ea2'), []);
});

test('endpoint change on a hidden host rebuilds in place without showing', () => {
  const lc = createWebviewLifecycle();
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb'); // a hidden

  const out = lc.setConnected('a', 'ea2');
  assert.deepEqual(ops(out), ['destroy:a', 'create:a:ea2']);
  assert.equal(lc.getState('a'), STATES.HIDDEN);
  assert.ok(!types(out).includes('show'));
});

// --- crash then recover ----------------------------------------------------

test('crash destroys the element, and re-activation restores it', () => {
  const lc = createWebviewLifecycle();
  bringUp(lc, 'a', 'ea');

  const crashOut = lc.markCrashed('a');
  assert.deepEqual(ops(crashOut), ['destroy:a']);
  assert.equal(lc.getState('a'), STATES.CRASHED);
  assert.equal(lc.getEndpoint('a'), 'ea'); // endpoint retained for restore

  // Re-activating the crashed (still-selected) host restores it.
  const out = lc.setActive('a');
  assert.deepEqual(ops(out), ['restore:a:ea', 'show:a']);
  assert.equal(lc.getState('a'), STATES.ACTIVE);
});

test('crash while hidden: no restore until re-activated', () => {
  const lc = createWebviewLifecycle();
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb'); // a hidden, b active

  assert.deepEqual(ops(lc.markCrashed('a')), ['destroy:a']);
  assert.equal(lc.getState('a'), STATES.CRASHED);
  assert.equal(lc.getLiveCount(), 1); // only b remains live

  const out = lc.setActive('a');
  assert.deepEqual(ops(out), ['hide:b', 'restore:a:ea', 'show:a']);
});

// --- remove destroys --------------------------------------------------------

test('removing a host destroys its element and clears active', () => {
  const lc = createWebviewLifecycle();
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb'); // a hidden, b active

  // Remove a hidden host: destroy, gone from records.
  assert.deepEqual(ops(lc.remove('a')), ['destroy:a']);
  assert.equal(lc.getState('a'), STATES.NONE);
  assert.equal(lc.getLiveCount(), 1);

  // Remove the active host: destroy + active cleared.
  assert.deepEqual(ops(lc.remove('b')), ['destroy:b']);
  assert.equal(lc.getActiveHostId(), null);
  assert.equal(lc.getLiveCount(), 0);

  // Removing an unknown host is a no-op.
  assert.deepEqual(lc.remove('zzz'), []);
});

test('removing an evicted host emits nothing (no live element)', () => {
  const lc = createWebviewLifecycle({ maxLive: 2 });
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb');
  bringUp(lc, 'c', 'ec'); // evicts a
  assert.equal(lc.getState('a'), STATES.EVICTED);

  assert.deepEqual(lc.remove('a'), []); // nothing to destroy
  assert.equal(lc.getState('a'), STATES.NONE);
});

// --- hidden instances are not needlessly destroyed -------------------------

test('hidden instances survive repeated switching under the cap', () => {
  const lc = createWebviewLifecycle({ maxLive: 4 });
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb');
  bringUp(lc, 'c', 'ec'); // all within cap of 4

  // Switch around several times; nothing should be destroyed or evicted.
  const seq = []
    .concat(lc.setActive('a'))
    .concat(lc.setActive('b'))
    .concat(lc.setActive('c'))
    .concat(lc.setActive('a'));

  const kinds = types(seq);
  assert.ok(!kinds.includes(INSTR.DESTROY), 'no destroy under the cap');
  assert.ok(!kinds.includes(INSTR.EVICT), 'no evict under the cap');
  assert.ok(!kinds.includes(INSTR.CREATE), 'no re-create for live hidden hosts');

  // All three still materialized (active or hidden).
  assert.equal(lc.getLiveCount(), 3);
  assert.equal(lc.getState('b'), STATES.HIDDEN);
  assert.equal(lc.getState('c'), STATES.HIDDEN);
  assert.equal(lc.getState('a'), STATES.ACTIVE);
});

// --- snapshot introspection ------------------------------------------------

test('snapshot reports active host, cap, and per-host state', () => {
  const lc = createWebviewLifecycle({ maxLive: 2 });
  bringUp(lc, 'a', 'ea');
  bringUp(lc, 'b', 'eb');
  const snap = lc.snapshot();
  assert.equal(snap.activeHostId, 'b');
  assert.equal(snap.maxLive, 2);
  assert.equal(snap.hosts.a.state, STATES.HIDDEN);
  assert.equal(snap.hosts.b.state, STATES.ACTIVE);
  assert.equal(snap.hosts.a.endpoint, 'ea');
});
