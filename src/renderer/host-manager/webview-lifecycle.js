// webview-lifecycle.js — pure, DOM-free WebView lifecycle / LRU governance strategy.
//
// This module owns the *decisions* ("what should happen to which webview"), not the
// DOM side effects. It is a small state machine per host (none/active/hidden/evicted/
// crashed) driven by four inputs — setActive / setConnected / markCrashed / remove —
// that each return an ordered list of instructions the renderer applies to real
// <webview> elements. Creation is lazy (only on activation) so a configurable LRU cap
// (maxLive, default 4) can evict the least-recently-used *hidden* instance on switch.
//
// TODO(integration) — wire into src/renderer/host-manager/index.js (do NOT edit it here):
//   1. Load first:  <script src="./webview-lifecycle.js"></script> before index.js, then
//      const lifecycle = WebviewLifecycle.createWebviewLifecycle({ maxLive: 4 });
//   2. Add applyInstructions(list) mapping each instr by type:
//        create|restore -> getOrCreateWebview(i.hostId, i.endpoint)
//        show           -> showWebview(i.hostId)               // reveals + hides siblings
//        hide           -> webviews.get(i.hostId).style.display = 'none'
//        evict|destroy  -> destroyWebview(i.hostId)            // removes the element
//   3. selectHost(id):        applyInstructions(lifecycle.setActive(id));  showWebview(id)
//   4. On 'connected' snapshot with endpoint: applyInstructions(lifecycle.setConnected(id, snap.endpoint))
//   5. On webview 'crashed'/'render-process-gone': applyInstructions(lifecycle.markCrashed(id))
//   6. deleteHost(id) / disconnect: applyInstructions(lifecycle.remove(id))
//   7. Replace reconcileWebviews()'s eager create-all loop with per-host setConnected/remove
//      calls fed from snapshots; after applying, if lifecycle.getState(selectedHostId) is not
//      'active', render the placeholder as today.

(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WebviewLifecycle = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Per-host states.
  var STATES = Object.freeze({
    NONE: 'none',       // no webview element (never created, or destroyed)
    ACTIVE: 'active',   // element exists and is visible
    HIDDEN: 'hidden',   // element exists but is not visible
    EVICTED: 'evicted', // element destroyed by LRU; endpoint kept for restore
    CRASHED: 'crashed', // element gone due to a crash; endpoint kept for restore
  });

  // Instruction types the renderer maps to DOM side effects.
  var INSTR = Object.freeze({
    CREATE: 'create',   // first materialization: getOrCreateWebview(hostId, endpoint)
    RESTORE: 'restore', // re-materialization after evict/crash: getOrCreateWebview(hostId, endpoint)
    SHOW: 'show',       // make visible
    HIDE: 'hide',       // hide but keep the element
    EVICT: 'evict',     // destroy due to LRU pressure
    DESTROY: 'destroy', // destroy due to removal / endpoint rebuild
  });

  var LIVE = { active: true, hidden: true };

  function createWebviewLifecycle(options) {
    options = options || {};
    var maxLive = Math.max(1, Math.floor(options.maxLive != null ? options.maxLive : 4));

    // hostId -> { state, endpoint, seq } ; seq is a monotonic "last activated" clock.
    var records = new Map();
    var activeHostId = null;
    var clock = 0;

    function ensureRecord(hostId) {
      var rec = records.get(hostId);
      if (!rec) {
        rec = { state: STATES.NONE, endpoint: null, seq: 0 };
        records.set(hostId, rec);
      }
      return rec;
    }

    function touch(hostId) {
      var rec = records.get(hostId);
      if (rec) rec.seq = ++clock;
    }

    function isLive(rec) {
      return !!(rec && LIVE[rec.state]);
    }

    function liveCount() {
      var n = 0;
      records.forEach(function (rec) { if (isLive(rec)) n++; });
      return n;
    }

    // Evict least-recently-used HIDDEN instances so that materializing `exceptHostId`
    // (currently non-live) keeps the live count within maxLive. Returns evict instrs.
    function evictIfNeeded(exceptHostId) {
      var out = [];
      var needed = liveCount() + 1 - maxLive;
      if (needed <= 0) return out;

      var candidates = [];
      records.forEach(function (rec, hostId) {
        if (hostId !== exceptHostId && rec.state === STATES.HIDDEN) candidates.push(hostId);
      });
      candidates.sort(function (a, b) { return records.get(a).seq - records.get(b).seq; });

      for (var i = 0; i < needed && i < candidates.length; i++) {
        var h = candidates[i];
        records.get(h).state = STATES.EVICTED; // keep endpoint for later restore
        out.push({ type: INSTR.EVICT, hostId: h });
      }
      return out;
    }

    // Materialize (create or restore) the active host + show it, evicting LRU as needed.
    function materializeActive(hostId, rec, restoring) {
      var out = evictIfNeeded(hostId);
      rec.state = STATES.ACTIVE;
      touch(hostId);
      out.push({
        type: restoring ? INSTR.RESTORE : INSTR.CREATE,
        hostId: hostId,
        endpoint: rec.endpoint,
      });
      out.push({ type: INSTR.SHOW, hostId: hostId });
      return out;
    }

    function setActive(hostId) {
      var out = [];

      if (activeHostId !== hostId) {
        if (activeHostId != null) {
          var prev = records.get(activeHostId);
          if (prev && prev.state === STATES.ACTIVE) {
            prev.state = STATES.HIDDEN;
            out.push({ type: INSTR.HIDE, hostId: activeHostId });
          }
        }
        activeHostId = hostId;
      }

      if (hostId == null) return out;

      var rec = ensureRecord(hostId);
      touch(hostId);

      switch (rec.state) {
        case STATES.ACTIVE:
          // Already visible — nothing to do (re-selecting the current host).
          break;
        case STATES.HIDDEN:
          rec.state = STATES.ACTIVE;
          out.push({ type: INSTR.SHOW, hostId: hostId });
          break;
        case STATES.EVICTED:
        case STATES.CRASHED:
          if (rec.endpoint) out = out.concat(materializeActive(hostId, rec, true));
          // else: no endpoint yet — stays non-live until setConnected arrives.
          break;
        case STATES.NONE:
        default:
          if (rec.endpoint) out = out.concat(materializeActive(hostId, rec, false));
          // else: pending activation; renderer shows placeholder until connected.
          break;
      }
      return out;
    }

    function setConnected(hostId, endpoint) {
      var out = [];
      var rec = ensureRecord(hostId);
      var changed = rec.endpoint !== endpoint;
      rec.endpoint = endpoint;

      switch (rec.state) {
        case STATES.ACTIVE:
          if (changed) {
            out.push({ type: INSTR.DESTROY, hostId: hostId });
            out.push({ type: INSTR.CREATE, hostId: hostId, endpoint: endpoint });
            out.push({ type: INSTR.SHOW, hostId: hostId });
          }
          break;
        case STATES.HIDDEN:
          if (changed) {
            // Rebuild in place; it stays hidden (create leaves the element hidden).
            out.push({ type: INSTR.DESTROY, hostId: hostId });
            out.push({ type: INSTR.CREATE, hostId: hostId, endpoint: endpoint });
          }
          break;
        case STATES.EVICTED:
        case STATES.CRASHED:
          if (hostId === activeHostId) out = out.concat(materializeActive(hostId, rec, true));
          // else: endpoint updated; will restore when activated.
          break;
        case STATES.NONE:
        default:
          if (hostId === activeHostId) out = out.concat(materializeActive(hostId, rec, false));
          // else: lazily recorded; created on activation.
          break;
      }
      return out;
    }

    function markCrashed(hostId) {
      var out = [];
      var rec = ensureRecord(hostId);
      if (isLive(rec)) out.push({ type: INSTR.DESTROY, hostId: hostId });
      rec.state = STATES.CRASHED; // endpoint retained for restore
      return out;
    }

    function remove(hostId) {
      var out = [];
      var rec = records.get(hostId);
      if (!rec) return out;
      if (isLive(rec)) out.push({ type: INSTR.DESTROY, hostId: hostId });
      records.delete(hostId);
      if (activeHostId === hostId) activeHostId = null;
      return out;
    }

    // --- Read-only accessors (for the renderer + tests) ---

    function getState(hostId) {
      var rec = records.get(hostId);
      return rec ? rec.state : STATES.NONE;
    }

    function getEndpoint(hostId) {
      var rec = records.get(hostId);
      return rec ? rec.endpoint : null;
    }

    function getActiveHostId() {
      return activeHostId;
    }

    function getLiveHostIds() {
      var ids = [];
      records.forEach(function (rec, hostId) { if (isLive(rec)) ids.push(hostId); });
      return ids;
    }

    function getLiveCount() {
      return liveCount();
    }

    function getMaxLive() {
      return maxLive;
    }

    function snapshot() {
      var out = {};
      records.forEach(function (rec, hostId) {
        out[hostId] = { state: rec.state, endpoint: rec.endpoint, seq: rec.seq };
      });
      return { activeHostId: activeHostId, maxLive: maxLive, hosts: out };
    }

    return {
      // inputs
      setActive: setActive,
      setConnected: setConnected,
      markCrashed: markCrashed,
      remove: remove,
      // accessors
      getState: getState,
      getEndpoint: getEndpoint,
      getActiveHostId: getActiveHostId,
      getLiveHostIds: getLiveHostIds,
      getLiveCount: getLiveCount,
      getMaxLive: getMaxLive,
      snapshot: snapshot,
    };
  }

  return {
    createWebviewLifecycle: createWebviewLifecycle,
    STATES: STATES,
    INSTR: INSTR,
  };
}));
