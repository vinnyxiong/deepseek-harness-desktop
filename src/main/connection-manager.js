const { EventEmitter } = require('events');
const { waitForDsh, probeDsh } = require('./dsh-health');

const MONITOR_INTERVAL_MS = 5_000;
const MONITOR_FAILURE_LIMIT = 3;

function publicError(error) { return error instanceof Error ? error.message : String(error); }
function externalTunnelHandle(localPort) {
  return { mode: 'external', endpoint: `http://127.0.0.1:${localPort}`, port: localPort, owned: false, async stop() {} };
}

class ConnectionManager extends EventEmitter {
  constructor({ startLocal, startManagedSsh, remoteDsh = null, health = { waitForDsh, probeDsh }, monitorIntervalMs = MONITOR_INTERVAL_MS, monitorFailureLimit = MONITOR_FAILURE_LIMIT }) {
    super();
    this.startLocal = startLocal;
    this.startManagedSsh = startManagedSsh;
    this.remoteDsh = remoteDsh;
    this.health = health;
    this.monitorIntervalMs = monitorIntervalMs;
    this.monitorFailureLimit = monitorFailureLimit;
    this.current = null;
    this.settings = null;
    this.targetSettings = null;
    this.generation = 0;
    this.operation = Promise.resolve();
    this.monitorTimer = null;
    this.pendingCleanup = Promise.resolve();
    this.pendingCleanupHandle = null;
    this.ownedHandles = new Set();
    this.remoteDshState = { running: false, pid: null };
    this.snapshot = { state: 'idle', mode: null, endpoint: null, error: null };
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      settings: this.settings,
      remoteDsh: this.snapshot.mode === 'managedSsh' ? { ...this.remoteDshState } : null,
    };
  }
  setTargetSettings(settings) { this.targetSettings = settings; if (!this.current) this.settings = settings; }
  setSnapshot(patch) { this.snapshot = { ...this.snapshot, ...patch }; this.emit('status', this.getSnapshot()); }

  sameConnectionTarget(left, right) {
    if (left.mode !== right.mode) return false;
    if (left.mode === 'local') return true;
    if (left.mode === 'external') return left.externalTunnel.localPort === right.externalTunnel.localPort;
    const a = left.managedSsh; const b = right.managedSsh;
    return ['host', 'username', 'sshPort', 'localPort', 'remotePort', 'identityFile', 'hostKeyPolicy'].every(key => a[key] === b[key]);
  }

  requestedPort(settings) {
    if (settings.mode === 'managedSsh') return settings.managedSsh.localPort;
    if (settings.mode === 'external') return settings.externalTunnel.localPort;
    return null;
  }

  connect(settings) {
    const action = () => this.connectNow(settings);
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => {});
    return result;
  }

  async createHandle(settings) {
    let handle = null;
    if (settings.mode === 'local') {
      handle = await this.startLocal(details => this.handleUnexpectedOwnedExit(handle, details));
    } else if (settings.mode === 'managedSsh') {
      // Auto-start remote DSH before creating the tunnel
      if (this.remoteDsh && settings.managedSsh.autoStartRemoteDsh !== false) {
        try {
          const result = await this.remoteDsh.startRemoteDsh(settings.managedSsh);
          this.remoteDshState = { running: true, pid: result.pid };
        } catch (error) {
          // Log but don't fail — user may have started DSH manually
          console.error('Failed to auto-start remote DSH:', error.message);
          this.remoteDshState = { running: false, pid: null };
        }
      }
      handle = await this.startManagedSsh(settings.managedSsh, details => this.handleUnexpectedOwnedExit(handle, details));
    } else {
      handle = externalTunnelHandle(settings.externalTunnel.localPort);
    }
    handle.connectionSettings = settings;
    if (handle.owned) this.ownedHandles.add(handle);
    return handle;
  }

  async stopHandle(handle) {
    if (!handle) return;
    await handle.stop();
    if (handle.owned) this.ownedHandles.delete(handle);
  }

  trackCleanup(handle) {
    const cleanup = this.stopHandle(handle);
    cleanup.catch(() => {});
    this.pendingCleanup = cleanup;
    this.pendingCleanupHandle = handle;
    cleanup.then(
      () => {
        if (this.pendingCleanup === cleanup) {
          this.pendingCleanup = Promise.resolve();
          this.pendingCleanupHandle = null;
        }
      },
      () => {},
    );
    return cleanup;
  }

  async waitUntilHealthy(handle, timeoutMs) {
    const health = this.health.waitForDsh(handle.endpoint, { timeoutMs });
    if (handle.earlyExit) await Promise.race([health, handle.earlyExit]); else await health;
    if (handle.isRunning && !handle.isRunning()) throw new Error(`${handle.mode} process exited during startup`);
  }

  async connectNow(settings) {
    try {
      await this.pendingCleanup;
    } catch (error) {
      if (this.pendingCleanupHandle) {
        this.current = this.pendingCleanupHandle;
        this.settings = this.pendingCleanupHandle.connectionSettings ?? this.settings;
        this.targetSettings = this.settings;
      }
      throw error;
    }
    const generation = ++this.generation;
    const reconnectingCurrent = Boolean(this.current && this.settings && this.sameConnectionTarget(this.settings, settings));
    this.targetSettings = settings;
    this.stopMonitor();
    this.setSnapshot({ state: 'connecting', mode: settings.mode, error: null });

    const requestedPort = this.requestedPort(settings);
    const previous = this.current;
    const previousSettings = this.settings;
    const conflicting = Boolean(previous && requestedPort && previous.port === requestedPort);
    let stoppedPrevious = false;
    let next = null;

    try {
      if (conflicting) {
        if (!previous.owned && settings.mode === 'managedSsh') {
          throw new Error(`Local port ${requestedPort} is owned by an external tunnel. Stop it or choose another port.`);
        }
        if (previous.owned) {
          await this.stopHandle(previous);
          if (this.current === previous) this.current = null;
          stoppedPrevious = true;
        }
      }

      next = await this.createHandle(settings);
      await this.waitUntilHealthy(next, settings.mode === 'local' ? 15_000 : 10_000);
      if (generation !== this.generation) { await this.stopHandle(next); throw new Error('Connection attempt was superseded'); }

      if (previous && previous !== next && !stoppedPrevious) {
        try {
          await this.stopHandle(previous);
        } catch (stopError) {
          try { await this.stopHandle(next); } catch {}
          this.current = previous;
          this.settings = previousSettings;
          this.targetSettings = previousSettings;
          throw new Error(`New connection was ready, but the previous connection could not be stopped: ${publicError(stopError)}`);
        }
      }

      this.current = next;
      this.settings = settings;
      this.setSnapshot({ state: 'connected', mode: next.mode, endpoint: next.endpoint, error: null });
      this.startMonitor(generation, next);
      return this.getSnapshot();
    } catch (error) {
      if (next && next !== this.current && this.ownedHandles.has(next)) {
        try { await this.stopHandle(next); } catch {}
      }
      const fallback = stoppedPrevious ? null : this.current;
      if (fallback && !reconnectingCurrent) {
        this.generation -= 1;
        this.settings = previousSettings;
        this.targetSettings = previousSettings;
        this.setSnapshot({ state: 'connected', mode: fallback.mode, endpoint: fallback.endpoint, error: `Could not switch connection: ${publicError(error)}` });
        this.startMonitor(this.generation, fallback);
      } else {
        let restored = null;
        if (stoppedPrevious && previousSettings) {
          try {
            restored = await this.createHandle(previousSettings);
            await this.waitUntilHealthy(restored, 10_000);
          } catch {
            if (restored) try { await this.stopHandle(restored); } catch {}
            restored = null;
          }
        }
        if (restored) {
          this.current = restored;
          this.settings = previousSettings;
          this.targetSettings = previousSettings;
          this.generation += 1;
          this.setSnapshot({ state: 'connected', mode: restored.mode, endpoint: restored.endpoint, error: `Could not switch connection: ${publicError(error)}. Previous connection restored.` });
          this.startMonitor(this.generation, restored);
        } else {
          this.current = null;
          this.settings = settings;
          this.setSnapshot({ state: 'error', mode: settings.mode, endpoint: null, error: publicError(error) });
        }
      }
      throw error;
    }
  }

  async retry() { const settings = this.targetSettings ?? this.settings; if (!settings) throw new Error('There is no saved connection to retry'); return this.connect(settings); }

  async disconnect({ preserveSettings = true } = {}) {
    ++this.generation;
    this.stopMonitor();
    if (!preserveSettings) this.settings = null;

    const pendingHandle = this.pendingCleanupHandle;
    if (pendingHandle) {
      try {
        await this.pendingCleanup;
      } catch {
        try {
          await this.stopHandle(pendingHandle);
          this.pendingCleanup = Promise.resolve();
          this.pendingCleanupHandle = null;
        } catch (error) {
          this.current = pendingHandle;
          this.settings = pendingHandle.connectionSettings ?? this.settings;
          this.targetSettings = this.settings;
          const failure = new Error(`Could not stop an owned connection process: ${publicError(error)}`);
          this.setSnapshot({ state: 'error', mode: pendingHandle.mode, endpoint: pendingHandle.endpoint, error: failure.message });
          throw failure;
        }
      }
    }

    const handles = new Set(this.ownedHandles);
    if (this.current) handles.add(this.current);
    const failures = [];
    for (const handle of handles) {
      try { await this.stopHandle(handle); } catch (error) { failures.push({ handle, error }); }
    }
    if (failures.length) {
      const failed = failures[0];
      this.current = failed.handle;
      this.settings = failed.handle.connectionSettings ?? this.settings;
      this.targetSettings = this.settings;
      const error = new Error(`Could not stop ${failures.length} owned connection process(es): ${publicError(failed.error)}`);
      this.setSnapshot({ state: 'error', mode: failed.handle.mode, endpoint: failed.handle.endpoint, error: error.message });
      throw error;
    }
    this.current = null;
    // Auto-stop remote DSH after all tunnel handles are stopped
    if (this.remoteDsh && this.settings?.mode === 'managedSsh' && this.settings?.managedSsh?.autoStopRemoteDsh !== false) {
      try {
        await this.remoteDsh.stopRemoteDsh(this.settings.managedSsh);
      } catch (error) {
        console.error('Failed to auto-stop remote DSH:', error.message);
      } finally {
        this.remoteDshState = { running: false, pid: null };
      }
    }
    this.setSnapshot({ state: 'idle', mode: null, endpoint: null, error: null });
  }

  async dispose() { await this.operation.catch(() => {}); await this.disconnect(); }

  async restartRemoteDsh() {
    if (!this.remoteDsh || !this.settings || this.settings.mode !== 'managedSsh') {
      throw new Error('Remote DSH management is only available in managed SSH mode');
    }
    if (this.snapshot.state !== 'connected') {
      throw new Error('Cannot restart remote DSH while not connected');
    }
    try {
      await this.remoteDsh.stopRemoteDsh(this.settings.managedSsh);
    } catch (error) {
      // Ignore stop errors; the process might already be dead
    }
    const result = await this.remoteDsh.startRemoteDsh(this.settings.managedSsh);
    this.remoteDshState = { running: true, pid: result.pid };
    this.setSnapshot(this.snapshot);
    return this.remoteDshState;
  }

  async stopRemoteDsh() {
    if (!this.remoteDsh || !this.settings || this.settings.mode !== 'managedSsh') {
      throw new Error('Remote DSH management is only available in managed SSH mode');
    }
    await this.remoteDsh.stopRemoteDsh(this.settings.managedSsh);
    this.remoteDshState = { running: false, pid: null };
    this.setSnapshot(this.snapshot);
    return this.remoteDshState;
  }

  async getRemoteDshStatus() {
    if (!this.remoteDsh || !this.settings || this.settings.mode !== 'managedSsh') {
      return null;
    }
    try {
      const status = await this.remoteDsh.getRemoteDshStatus(this.settings.managedSsh);
      this.remoteDshState = { running: status.running, pid: status.pid };
      this.setSnapshot(this.snapshot);
      return status;
    } catch (error) {
      this.remoteDshState = { running: false, pid: null };
      return { running: false, pid: null };
    }
  }

  handleUnexpectedOwnedExit(handle, details) {
    if (!handle || this.current !== handle) return;
    this.current = null;
    this.stopMonitor();
    const cleanup = this.trackCleanup(handle);
    cleanup.catch(() => {
      this.current = handle;
      this.settings = handle.connectionSettings ?? this.settings;
      this.targetSettings = this.settings;
    });
    const name = handle.mode === 'managedSsh' ? 'SSH tunnel' : 'local DSH service';
    this.setSnapshot({ state: 'error', endpoint: null, error: `The ${name} stopped unexpectedly (code=${details.code}, signal=${details.signal}).` });
  }

  startMonitor(generation, handle) {
    this.stopMonitor(); let failures = 0;
    const check = async () => {
      if (generation !== this.generation || this.current !== handle) return;
      try {
        await this.health.probeDsh(handle.endpoint, { requestTimeoutMs: 3_000 });
        if (generation !== this.generation || this.current !== handle) return;
        failures = 0;
      } catch {
        if (generation !== this.generation || this.current !== handle) return;
        failures += 1;
        if (failures >= this.monitorFailureLimit) {
          this.stopMonitor(); this.current = null;
          if (handle.owned) {
            const cleanup = this.trackCleanup(handle);
            cleanup.catch(() => {
              this.current = handle;
              this.settings = handle.connectionSettings ?? this.settings;
              this.targetSettings = this.settings;
              this.setSnapshot({ state: 'error', mode: handle.mode, endpoint: handle.endpoint, error: 'The connection failed and its process could not be stopped. Retry Disconnect before reconnecting.' });
            });
          }
          const remote = handle.mode === 'managedSsh' || handle.mode === 'external';
          this.setSnapshot({ state: 'error', endpoint: null, error: remote ? 'The SSH tunnel or remote DSH service is no longer reachable.' : 'The local DSH service is no longer responding.' });
          return;
        }
      }
      if (generation !== this.generation || this.current !== handle) return;
      this.monitorTimer = setTimeout(check, this.monitorIntervalMs); this.monitorTimer.unref?.();
    };
    this.monitorTimer = setTimeout(check, this.monitorIntervalMs); this.monitorTimer.unref?.();
  }

  stopMonitor() { if (this.monitorTimer) clearTimeout(this.monitorTimer); this.monitorTimer = null; }
}

module.exports = { ConnectionManager, MONITOR_FAILURE_LIMIT, MONITOR_INTERVAL_MS, externalTunnelHandle, tunnelHandle: externalTunnelHandle };
