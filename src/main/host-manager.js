const { EventEmitter } = require('events');
const { waitForDsh, probeDsh } = require('./dsh-health');

const MONITOR_INTERVAL_MS = 5_000;
const MONITOR_FAILURE_LIMIT = 3;

function publicError(error) { return error instanceof Error ? error.message : String(error); }

class HostManager extends EventEmitter {
  constructor({
    startLocal,
    startManagedSsh,
    remoteDsh = null,
    health = { waitForDsh, probeDsh },
    monitorIntervalMs = MONITOR_INTERVAL_MS,
    monitorFailureLimit = MONITOR_FAILURE_LIMIT,
  }) {
    super();
    this.startLocal = startLocal;
    this.startManagedSsh = startManagedSsh;
    this.remoteDsh = remoteDsh;
    this.health = health;
    this.monitorIntervalMs = monitorIntervalMs;
    this.monitorFailureLimit = monitorFailureLimit;

    // Map<hostId, { handle, settings, generation, monitorTimer, remoteDshState }>
    this.connections = new Map();
    this.hosts = [];
    this.revisions = new Map();
    this.operation = Promise.resolve();
  }

  setHosts(hosts) {
    this.hosts = hosts;
  }

  getHost(hostId) {
    return this.hosts.find(h => h.id === hostId);
  }

  getSnapshot(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn) {
      const host = this.getHost(hostId);
      return { hostId, revision: this.revisions.get(hostId) || 0, state: 'idle', mode: host?.type === 'remote' ? 'managedSsh' : 'local', endpoint: null, error: null, remoteDsh: null, progress: null, needsUpdate: false, remoteVersion: null, bundledVersion: null };
    }
    return {
      hostId,
      revision: this.revisions.get(hostId) || 0,
      state: conn.state,
      mode: conn.handle?.mode || (conn.settings?.type === 'remote' ? 'managedSsh' : 'local'),
      endpoint: conn.handle?.endpoint || null,
      error: conn.error || null,
      remoteDsh: conn.remoteDshState || null,
      progress: conn.progress || null,
      needsUpdate: conn.remoteVersionState?.needsUpdate || false,
      remoteVersion: conn.remoteVersionState?.remoteVersion || null,
      bundledVersion: conn.remoteVersionState?.bundledVersion || null,
    };
  }

  getSnapshots() {
    return this.hosts.map(h => this.getSnapshot(h.id));
  }

  emitStatus(hostId) {
    this.revisions.set(hostId, (this.revisions.get(hostId) || 0) + 1);
    this.emit('status', hostId, this.getSnapshot(hostId));
  }

  async discoverAndAttachRemoteHosts({ concurrency = 2 } = {}) {
    if (!this.remoteDsh?.discoverRemoteDsh) return [];
    const attached = [];
    const hosts = this.hosts.filter(item => item.type === 'remote');
    let next = 0;
    const worker = async () => {
      while (next < hosts.length) {
        const host = hosts[next++];
        try {
          const state = await this.remoteDsh.discoverRemoteDsh(host);
          if (!state.running || this.connections.has(host.id)) continue;
          const conn = { state: 'connecting', error: null, progress: { phase: 'ssh-tunnel', message: '正在恢复 SSH 隧道...' }, remoteDshState: state, generation: 0, handle: null, settings: host, monitorTimer: null };
          this.connections.set(host.id, conn);
          this.emitStatus(host.id);
          const handle = await this.startManagedSsh(host, details => this.handleUnexpectedExit(host.id, details), state.port);
          handle.connectionSettings = host;
          conn.handle = handle;
          conn.generation = 1;
          conn.state = 'connected';
          conn.progress = { phase: 'connected', message: '已连接' };
          this.emitStatus(host.id);
          this.startMonitor(host.id, conn, handle);
          attached.push(this.getSnapshot(host.id));
        } catch (error) {
          this.connections.delete(host.id);
          console.warn(`Failed to attach discovered remote DSH for ${host.id}:`, publicError(error));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), hosts.length) }, worker));
    return attached;
  }

  // --- Connect ---

  connect(hostId) {
    const host = this.getHost(hostId);
    if (!host) throw new Error(`Host not found: ${hostId}`);

    const action = () => this.connectNow(host);
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => {});
    return result;
  }

  async connectNow(host) {
    const hostId = host.id;
    const existing = this.connections.get(hostId);

    // If already connected, just return
    if (existing && existing.handle) {
      return this.getSnapshot(hostId);
    }

    const conn = { state: 'connecting', error: null, progress: { phase: 'connecting', message: '正在连接...' }, remoteDshState: null, generation: 0, handle: null, settings: host, monitorTimer: null };
    this.connections.set(hostId, conn);
    this.emitStatus(hostId);

    try {
      const handle = await this.createHandle(host, conn);
      conn.progress = { phase: 'health-check', message: '正在检查服务状态...' };
      this.emitStatus(hostId);
      conn.generation = 1;
      conn.handle = handle;
      conn.state = 'connected';
      conn.error = null;
      conn.progress = { phase: 'connected', message: '已连接' };
      this.emitStatus(hostId);
      this.startMonitor(hostId, conn, handle);

      // Check remote DSH version match after connection is established
      if (host.type === 'remote' && this.remoteDsh) {
        this.checkRemoteDshVersionMatch(hostId).catch(() => {});
      }

      return this.getSnapshot(hostId);
    } catch (error) {
      conn.state = 'error';
      conn.error = publicError(error);
      conn.handle = null;
      conn.progress = null;
      this.emitStatus(hostId);
      throw error;
    }
  }

  async createHandle(host, conn) {
    let handle = null;

    if (host.type === 'local') {
      conn.progress = { phase: 'starting', message: '正在启动本机 DSH...' };
      this.emitStatus(host.id);
      handle = await this.startLocal(details => this.handleUnexpectedExit(host.id, details));
    } else if (host.type === 'remote') {
      let dynamicRemotePort = null;
      if (this.remoteDsh) {
        const discovered = await this.remoteDsh.discoverRemoteDsh?.(host);
        if (discovered?.running) {
          dynamicRemotePort = discovered.port;
          conn.remoteDshState = discovered;
          this.emitStatus(host.id);
        } else if (host.autoStartRemoteDsh !== false) {
          conn.progress = { phase: 'remote-start', message: '正在启动远程 DSH...' };
          this.emitStatus(host.id);
          try {
            const result = await this.remoteDsh.startRemoteDsh(host, {
              autoInstall: host.autoInstallRemoteDsh !== false,
              onProgress: (phase, message) => {
                conn.progress = { phase, message };
                this.emitStatus(host.id);
              },
            });
            dynamicRemotePort = result.port;
            conn.remoteDshState = { running: true, pid: result.pid, port: result.port };
            this.emitStatus(host.id);
          } catch (error) {
            console.error('Failed to auto-start remote DSH:', error.message);
            conn.remoteDshState = { running: false, pid: null, port: null };
            throw error;
          }
        }
      }
      conn.progress = { phase: 'ssh-tunnel', message: '正在建立 SSH 隧道...' };
      this.emitStatus(host.id);
      handle = await this.startManagedSsh(host, details => this.handleUnexpectedExit(host.id, details), dynamicRemotePort);
    }

    handle.connectionSettings = host;
    return handle;
  }

  // --- Disconnect ---

  async disconnect(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn) return;

    this.stopMonitor(hostId);

    if (conn.handle) {
      try { await conn.handle.stop(); } catch (error) {
        console.error(`Failed to stop handle for ${hostId}:`, error.message);
      }
    }

    this.connections.delete(hostId);
    this.emitStatus(hostId);
  }

  async dispose() {
    const ids = [...this.connections.keys()];
    for (const id of ids) {
      await this.disconnect(id);
    }
  }

  // --- Remote DSH actions ---

  async restartRemoteDsh(hostId) {
    const conn = this.connections.get(hostId);
    const settings = conn?.settings || this.getHost(hostId);
    if (!settings || settings.type !== 'remote') {
      throw new Error('Remote DSH management is only available for remote hosts');
    }
    await this.disconnect(hostId);
    await this.remoteDsh.stopRemoteDsh(settings, conn?.remoteDshState?.pid);
    return this.connect(hostId);
  }

  async stopRemoteDsh(hostId) {
    const conn = this.connections.get(hostId);
    const settings = conn?.settings || this.getHost(hostId);
    if (!settings || settings.type !== 'remote') {
      throw new Error('Remote DSH management is only available for remote hosts');
    }
    await this.disconnect(hostId);
    await this.remoteDsh.stopRemoteDsh(settings, conn?.remoteDshState?.pid);
    return this.getSnapshot(hostId);
  }

  async getRemoteDshVersion(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.settings) throw new Error('Host not connected');
    return this.remoteDsh.getRemoteDshVersion(conn.settings);
  }

  async getRemoteDshLog(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.settings) throw new Error('Host not connected');
    return this.remoteDsh.getRemoteDshLog(conn.settings, conn.remoteDshState?.pid);
  }

  async getRemoteDshProcessDetails(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.settings) throw new Error('Host not connected');
    return this.remoteDsh.getRemoteDshProcessDetails(conn.settings, conn.remoteDshState?.pid);
  }

  async getRemoteDshConfig(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.handle?.endpoint || conn.state !== 'connected') {
      throw new Error('Host not connected');
    }
    const { callDsh } = require('./dsh-api-client');
    return callDsh(conn.handle.endpoint, 'settings.describe', {});
  }

  async checkRemoteDshVersionMatch(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.settings || conn.settings.type !== 'remote') {
      return { needsUpdate: false };
    }
    try {
      const remote = await this.remoteDsh.getRemoteDshVersion(conn.settings);
      const bundled = this.remoteDsh.getBundledDshVersion();
      const needsUpdate = remote.version !== 'unknown' && remote.version !== bundled;
      const result = { needsUpdate, remoteVersion: remote.version, bundledVersion: bundled };
      conn.remoteVersionState = result;
      this.emitStatus(hostId);
      return result;
    } catch {
      return { needsUpdate: false };
    }
  }

  async updateRemoteDsh(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.settings || conn.settings.type !== 'remote') {
      throw new Error('Remote DSH management is only available for remote hosts');
    }
    conn.progress = { phase: 'remote-transferring', message: '正在更新远程 DSH...' };
    this.emitStatus(hostId);
    try {
      const result = await this.remoteDsh.updateRemoteDsh(conn.settings);
      this.stopMonitor(hostId);
      const oldHandle = conn.handle;
      conn.handle = null;
      if (oldHandle) await oldHandle.stop();
      if (conn.remoteDshState?.pid) {
        await this.remoteDsh.stopRemoteDsh(conn.settings, conn.remoteDshState.pid);
      }
      const startResult = await this.remoteDsh.startRemoteDsh(conn.settings, {
        autoInstall: false,
      });
      const newHandle = await this.startManagedSsh(conn.settings, details => this.handleUnexpectedExit(hostId, details), startResult.port);
      newHandle.connectionSettings = conn.settings;
      conn.handle = newHandle;
      conn.generation += 1;
      conn.remoteDshState = { running: true, pid: startResult.pid, port: startResult.port };
      conn.state = 'connected';
      conn.error = null;
      conn.progress = { phase: 'connected', message: '已连接' };
      this.emitStatus(hostId);
      this.startMonitor(hostId, conn, newHandle);
      return result;
    } catch (error) {
      conn.progress = null;
      throw error;
    }
  }

  // --- Monitor ---

  handleUnexpectedExit(hostId, details) {
    const conn = this.connections.get(hostId);
    if (!conn) return;
    this.stopMonitor(hostId);
    try { conn.handle?.stop(); } catch {}
    conn.handle = null;
    conn.state = 'error';
    conn.error = `The connection stopped unexpectedly (code=${details.code}, signal=${details.signal}).`;
    this.emitStatus(hostId);
  }

  startMonitor(hostId, conn, handle) {
    this.stopMonitor(hostId);
    let failures = 0;
    const generation = conn.generation;

    const check = async () => {
      if (generation !== conn.generation || !this.connections.has(hostId)) return;
      try {
        await this.health.probeDsh(handle.endpoint, { requestTimeoutMs: 3_000 });
        failures = 0;
      } catch {
        failures += 1;
        if (failures >= this.monitorFailureLimit) {
          this.stopMonitor(hostId);
          try { await handle.stop(); } catch {}
          conn.handle = null;
          conn.state = 'error';
          conn.error = 'The connection is no longer reachable.';
          this.emitStatus(hostId);
          return;
        }
      }
      if (generation !== conn.generation || !this.connections.has(hostId)) return;
      conn.monitorTimer = setTimeout(check, this.monitorIntervalMs);
      conn.monitorTimer.unref?.();
    };
    conn.monitorTimer = setTimeout(check, this.monitorIntervalMs);
    conn.monitorTimer.unref?.();
  }

  stopMonitor(hostId) {
    const conn = this.connections.get(hostId);
    if (conn?.monitorTimer) {
      clearTimeout(conn.monitorTimer);
      conn.monitorTimer = null;
    }
  }
}

module.exports = { HostManager };