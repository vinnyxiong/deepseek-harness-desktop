const { EventEmitter } = require('events');
const { waitForDsh, probeDsh } = require('./dsh-health');
const { DshNotInstalledError } = require('./local-dsh');

const MONITOR_INTERVAL_MS = 5_000;
const MONITOR_FAILURE_LIMIT = 3;

function publicError(error) { return error instanceof Error ? error.message : String(error); }

class HostManager extends EventEmitter {
  constructor({
    startLocal,
    startManagedSsh,
    remoteDsh = null,
    localDshInstaller = null,
    health = { waitForDsh, probeDsh },
    monitorIntervalMs = MONITOR_INTERVAL_MS,
    monitorFailureLimit = MONITOR_FAILURE_LIMIT,
  }) {
    super();
    this.startLocal = startLocal;
    this.startManagedSsh = startManagedSsh;
    this.remoteDsh = remoteDsh;
    this.localDshInstaller = localDshInstaller;
    this.health = health;
    this.monitorIntervalMs = monitorIntervalMs;
    this.monitorFailureLimit = monitorFailureLimit;

    // Map<hostId, { handle, settings, generation, monitorTimer, remoteDshState }>
    this.connections = new Map();
    this.hosts = [];
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
      return { hostId, state: 'idle', mode: host?.type === 'remote' ? 'managedSsh' : 'local', endpoint: null, error: null, remoteDsh: null, progress: null };
    }
    return {
      hostId,
      state: conn.state,
      mode: conn.handle?.mode || (conn.settings?.type === 'remote' ? 'managedSsh' : 'local'),
      endpoint: conn.handle?.endpoint || null,
      error: conn.error || null,
      remoteDsh: conn.remoteDshState || null,
      progress: conn.progress || null,
    };
  }

  getSnapshots() {
    return this.hosts.map(h => this.getSnapshot(h.id));
  }

  emitStatus(hostId) {
    this.emit('status', hostId, this.getSnapshot(hostId));
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
      try {
        handle = await this.startLocal(details => this.handleUnexpectedExit(host.id, details));
      } catch (error) {
        if (error instanceof DshNotInstalledError && this.localDshInstaller) {
          try {
            const result = await this.localDshInstaller.install({
              onProgress: (phase, label) => {
                const messages = {
                  checking: '正在检查环境...',
                  preparing: '正在准备安装 DSH...',
                  installing: label || '正在下载并安装 DSH，请稍候...',
                  done: '安装完成，正在启动...',
                };
                conn.progress = { phase, message: messages[phase] || label || phase };
                this.emitStatus(host.id);
              },
            });
            if (!result.success) {
              throw new Error('DSH installation failed. Please ensure npm is available and try again.');
            }
          } catch (installError) {
            throw new Error(`DSH installation failed: ${publicError(installError)}`);
          }
          conn.progress = { phase: 'starting', message: '正在启动本机 DSH...' };
          this.emitStatus(host.id);
          handle = await this.startLocal(details => this.handleUnexpectedExit(host.id, details));
        } else {
          throw error;
        }
      }
    } else if (host.type === 'remote') {
      let dynamicRemotePort = null;
      if (this.remoteDsh && host.autoStartRemoteDsh !== false) {
        conn.progress = { phase: 'remote-start', message: '正在启动远程 DSH...' };
        this.emitStatus(host.id);
        try {
          const result = await this.remoteDsh.startRemoteDsh(host, {
            autoInstall: host.autoInstallRemoteDsh !== false,
          });
          dynamicRemotePort = result.port;
          conn.remoteDshState = { running: true, pid: result.pid, port: result.port };
          this.emitStatus(host.id);
        } catch (error) {
          console.error('Failed to auto-start remote DSH:', error.message);
          conn.remoteDshState = { running: false, pid: null, port: null };
          if (host.autoInstallRemoteDsh !== false &&
              (error.message.includes('npm') || error.message.includes('installation'))) {
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

    // Auto-stop remote DSH
    if (this.remoteDsh && conn.settings?.type === 'remote' && conn.settings?.autoStopRemoteDsh !== false && conn.remoteDshState?.pid) {
      try {
        await this.remoteDsh.stopRemoteDsh(conn.settings, conn.remoteDshState.pid);
      } catch (error) {
        console.error('Failed to auto-stop remote DSH:', error.message);
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
    if (!conn || !conn.settings || conn.settings.type !== 'remote') {
      throw new Error('Remote DSH management is only available for remote hosts');
    }
    try {
      await this.remoteDsh.stopRemoteDsh(conn.settings, conn.remoteDshState?.pid);
    } catch { /* ignore */ }
    const result = await this.remoteDsh.startRemoteDsh(conn.settings, {
      autoInstall: conn.settings.autoInstallRemoteDsh !== false,
    });
    conn.remoteDshState = { running: true, pid: result.pid, port: result.port };
    this.emitStatus(hostId);
    return conn.remoteDshState;
  }

  async stopRemoteDsh(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn || !conn.settings || conn.settings.type !== 'remote') {
      throw new Error('Remote DSH management is only available for remote hosts');
    }
    await this.remoteDsh.stopRemoteDsh(conn.settings, conn.remoteDshState?.pid);
    conn.remoteDshState = { running: false, pid: null, port: null };
    this.emitStatus(hostId);
    return conn.remoteDshState;
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

  async updateRemoteDsh(hostId) {
    const conn = this.connections.get(hostId);
    if (!conn?.settings || conn.settings.type !== 'remote') {
      throw new Error('Remote DSH management is only available for remote hosts');
    }
    return this.remoteDsh.updateRemoteDsh(conn.settings);
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