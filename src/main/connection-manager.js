const { EventEmitter } = require('events');
const { waitForDsh, probeDsh } = require('./dsh-health');

const MONITOR_INTERVAL_MS = 5_000;
const MONITOR_FAILURE_LIMIT = 3;

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function tunnelHandle(localPort) {
  return {
    mode: 'tunnel',
    endpoint: `http://127.0.0.1:${localPort}`,
    port: localPort,
    owned: false,
    async stop() {},
  };
}

class ConnectionManager extends EventEmitter {
  constructor({
    startLocal,
    health = { waitForDsh, probeDsh },
    monitorIntervalMs = MONITOR_INTERVAL_MS,
    monitorFailureLimit = MONITOR_FAILURE_LIMIT,
  }) {
    super();
    this.startLocal = startLocal;
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
    this.snapshot = { state: 'idle', mode: null, endpoint: null, error: null };
  }

  getSnapshot() {
    return { ...this.snapshot, settings: this.settings };
  }

  setTargetSettings(settings) {
    this.targetSettings = settings;
    if (!this.current) this.settings = settings;
  }

  setSnapshot(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit('status', this.getSnapshot());
  }

  sameConnectionTarget(left, right) {
    if (left.mode !== right.mode) return false;
    if (left.mode === 'local') return true;
    return left.tunnel.localPort === right.tunnel.localPort;
  }

  connect(settings) {
    const operation = async () => this.connectNow(settings);
    const result = this.operation.then(operation, operation);
    this.operation = result.catch(() => {});
    return result;
  }

  async connectNow(settings) {
    const generation = ++this.generation;
    const reconnectingCurrent = Boolean(
      this.current
      && this.settings
      && this.sameConnectionTarget(this.settings, settings),
    );
    this.targetSettings = settings;
    this.stopMonitor();
    this.setSnapshot({ state: 'connecting', mode: settings.mode, error: null });

    let next = null;
    try {
      if (settings.mode === 'local') {
        next = await this.startLocal(details => this.handleUnexpectedLocalExit(next, details));
      } else {
        next = tunnelHandle(settings.tunnel.localPort);
      }

      await this.health.waitForDsh(next.endpoint, { timeoutMs: settings.mode === 'local' ? 15_000 : 5_000 });
      if (next.isRunning && !next.isRunning()) {
        throw new Error('The local DSH service exited during startup');
      }
      if (generation !== this.generation) {
        await next.stop();
        throw new Error('Connection attempt was superseded');
      }

      const previous = this.current;
      this.current = next;
      this.settings = settings;
      this.setSnapshot({
        state: 'connected',
        mode: next.mode,
        endpoint: next.endpoint,
        error: null,
      });
      this.startMonitor(generation, next);
      if (previous && previous !== next) await previous.stop();
      return this.getSnapshot();
    } catch (error) {
      if (next && next !== this.current) await next.stop().catch(() => {});
      const fallback = this.current;
      if (fallback && !reconnectingCurrent) {
        this.generation -= 1;
        this.targetSettings = this.settings;
        this.setSnapshot({
          state: 'connected',
          mode: fallback.mode,
          endpoint: fallback.endpoint,
          error: `Could not switch connection: ${publicError(error)}`,
        });
        this.startMonitor(this.generation, fallback);
      } else {
        if (fallback) {
          this.current = null;
          await fallback.stop().catch(() => {});
        }
        this.settings = settings;
        this.setSnapshot({
          state: 'error',
          mode: settings.mode,
          endpoint: null,
          error: publicError(error),
        });
      }
      throw error;
    }
  }

  async retry() {
    const settings = this.targetSettings ?? this.settings;
    if (!settings) throw new Error('There is no saved connection to retry');
    return this.connect(settings);
  }

  async useLocal() {
    const settings = this.targetSettings ?? this.settings;
    return this.connect({
      schemaVersion: 1,
      mode: 'local',
      tunnel: { localPort: settings?.tunnel?.localPort ?? 3080 },
    });
  }

  async disconnect({ preserveSettings = true } = {}) {
    ++this.generation;
    this.stopMonitor();
    const current = this.current;
    this.current = null;
    if (!preserveSettings) this.settings = null;
    if (current) await current.stop();
    await this.pendingCleanup.catch(() => {});
    this.setSnapshot({ state: 'idle', mode: null, endpoint: null, error: null });
  }

  async dispose() {
    await this.operation.catch(() => {});
    await this.disconnect();
    await this.pendingCleanup.catch(() => {});
  }

  handleUnexpectedLocalExit(handle, details) {
    if (!handle || this.current !== handle) return;
    this.current = null;
    this.stopMonitor();
    const cleanup = handle.stop();
    this.pendingCleanup = Promise.allSettled([this.pendingCleanup, cleanup]).then(() => {});
    this.setSnapshot({
      state: 'error',
      endpoint: null,
      error: `The local DSH service stopped unexpectedly (code=${details.code}, signal=${details.signal}).`,
    });
  }

  startMonitor(generation, handle) {
    this.stopMonitor();
    let failures = 0;
    const check = async () => {
      if (generation !== this.generation || this.current !== handle) return;
      try {
        await this.health.probeDsh(handle.endpoint, { requestTimeoutMs: 3_000 });
        if (generation !== this.generation || this.current !== handle) return;
        failures = 0;
      } catch (error) {
        if (generation !== this.generation || this.current !== handle) return;
        failures += 1;
        if (failures >= this.monitorFailureLimit) {
          this.stopMonitor();
          this.current = null;
          if (handle.mode === 'local') {
            const cleanup = handle.stop();
            this.pendingCleanup = Promise.allSettled([this.pendingCleanup, cleanup]).then(() => {});
          }
          this.setSnapshot({
            state: 'error',
            endpoint: null,
            error: handle.mode === 'tunnel'
              ? 'The SSH tunnel or remote DSH service is no longer reachable.'
              : 'The local DSH service is no longer responding.',
          });
          return;
        }
      }
      if (generation !== this.generation || this.current !== handle) return;
      this.monitorTimer = setTimeout(check, this.monitorIntervalMs);
      this.monitorTimer.unref?.();
    };
    this.monitorTimer = setTimeout(check, this.monitorIntervalMs);
    this.monitorTimer.unref?.();
  }

  stopMonitor() {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }
}

module.exports = {
  ConnectionManager,
  MONITOR_FAILURE_LIMIT,
  MONITOR_INTERVAL_MS,
  tunnelHandle,
};
