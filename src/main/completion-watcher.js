const { WebSocket } = require('ws');
const path = require('path');
const { callDsh } = require('./dsh-api-client');
const TERMINAL_JOBS = new Set(['completed', 'failed', 'killed']);
const ACTIVE_JOBS = new Set(['running', 'stopping']);
function socketUrl(endpoint, suffix) { const url = new URL(endpoint); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = suffix; url.search = ''; url.hash = ''; return url.toString(); }
function sessionLabel(session) { if (typeof session?.title === 'string' && session.title.trim()) return session.title.trim(); return session?.cwd ? path.basename(session.cwd) : session?.sessionId; }

class CompletionWatcher {
  constructor({ callApi = callDsh, WebSocketImpl = WebSocket, onCompletion, onHostFrame, reconnectDelays = [1000, 2000, 4000, 8000, 15000, 30000], completionDelayMs = 250 } = {}) {
    Object.assign(this, { callApi, WebSocketImpl, onCompletion, onHostFrame, reconnectDelays, completionDelayMs });
    this.endpoint = null; this.generation = 0; this.sockets = []; this.timer = null; this.sessions = new Map(); this.jobs = new Map(); this.dedupe = new Set(); this.active = false; this.attempt = 0;
  }
  async setEndpoint(endpoint) { if (this.endpoint === endpoint && this.sockets.length) return; this.stop(); this.endpoint = endpoint; const generation = ++this.generation; await this.connect(generation); }
  closeSockets(sockets = this.sockets) { for (const socket of sockets) try { socket.close(); } catch {} if (sockets === this.sockets) this.sockets = []; }
  stop() { ++this.generation; clearTimeout(this.timer); this.timer = null; this.closeSockets(); for (const s of this.sessions.values()) clearTimeout(s.completionTimer); this.endpoint = null; this.active = false; this.sessions.clear(); this.jobs.clear(); this.dedupe.clear(); }
  dispose() { this.stop(); }
  async connect(generation) {
    if (!this.endpoint || generation !== this.generation) return;
    this.active = false; const localSockets = [];
    try {
      const host = await this.open('/api/events.host', generation); localSockets.push(host); this.sockets = [...localSockets];
      const mux = await this.open('/api/events.mux', generation); localSockets.push(mux); this.sockets = [...localSockets];
      const baseline = await this.callApi(this.endpoint, 'session.list', {});
      if (generation !== this.generation) { this.closeSockets(localSockets); return; }
      for (const item of baseline.items ?? []) {
        const existing = this.sessions.get(item.sessionId);
        if (existing?.running === true && item.running === false) {
          existing.running = false;
          existing.run = Math.max(1, existing.run);
          if (generation === this.generation) this.emitAgent(existing);
          continue;
        }
        this.sessions.set(item.sessionId, { sessionId: item.sessionId, running: item.running, cwd: item.cwd, title: item.projections?.values?.title ?? null, titleSeq: item.projections?.asOfSeq ?? -1, run: item.running ? Math.max(1, existing?.run ?? 1) : existing?.run ?? 0, reason: null, error: false });
      }
      this.active = true; this.attempt = 0;
    } catch { this.closeSockets(localSockets); if (generation === this.generation) this.scheduleReconnect(generation); }
  }
  open(suffix, generation) { return new Promise((resolve, reject) => { const socket = new this.WebSocketImpl(socketUrl(this.endpoint, suffix), { maxPayload: 16 * 1024 * 1024 }); const fail = error => reject(error); socket.once('open', () => { socket.off?.('error', fail); resolve(socket); }); socket.once('error', fail); socket.on('message', data => { if (generation === this.generation) this.handleMessage(data); }); socket.on('close', () => { if (generation === this.generation) this.reconnectGeneration(generation); }); socket.on('error', () => {}); }); }
  reconnectGeneration(generation) { if (!this.endpoint || generation !== this.generation || this.timer) return; this.closeSockets(); this.active = false; this.scheduleReconnect(generation); }
  scheduleReconnect(generation) { if (this.timer || !this.endpoint) return; const delay = this.reconnectDelays[Math.min(this.attempt++, this.reconnectDelays.length - 1)]; this.timer = setTimeout(() => { this.timer = null; void this.connect(generation); }, delay); this.timer.unref?.(); }
  handleMessage(data) { let envelope; try { envelope = JSON.parse(data.toString()); } catch { return; } const frame = envelope?.payload; if (envelope?.type !== 'server-request' || !frame || envelope.method !== frame.type) return; if (frame.type.startsWith('host/')) { this.onHostFrame?.(frame); this.handleHost(frame); } else this.handleMux(frame); }
  ensureSession(id) { if (!this.sessions.has(id)) this.sessions.set(id, { sessionId: id, running: false, title: null, titleSeq: -1, run: 0, reason: null, error: false }); return this.sessions.get(id); }
  emitAgent(session) { const key = `agent:${session.sessionId}:${session.run}`; if (this.dedupe.has(key)) return; this.dedupe.add(key); const status = session.error || session.reason === 'error' ? 'failed' : ['aborted', 'blocked', 'interrupted', 'max-tokens'].includes(session.reason) ? 'stopped' : 'completed'; this.onCompletion?.({ kind: 'agent', status, label: sessionLabel(session), sessionId: session.sessionId }); }
  handleHost(frame) {
    if (frame.type === 'host/session-added') Object.assign(this.ensureSession(frame.sessionId), { cwd: frame.cwd });
    if (frame.type === 'host/session-removed') { const s = this.sessions.get(frame.sessionId); if (s?.completionTimer) { clearTimeout(s.completionTimer); this.emitAgent(s); } this.sessions.delete(frame.sessionId); this.jobs.delete(frame.sessionId); }
    if (frame.type === 'host/agent-error') this.ensureSession(frame.sessionId).error = true;
    if (frame.type !== 'host/session-status') return;
    const session = this.ensureSession(frame.sessionId); session.observedLive = true; const previous = session.running; session.running = frame.running;
    if (!previous && frame.running) { clearTimeout(session.completionTimer); session.run += 1; session.reason = null; session.error = false; }
    if (this.active && previous === true && !frame.running) { clearTimeout(session.completionTimer); session.completionTimer = setTimeout(() => { if (!session.running) this.emitAgent(session); }, this.completionDelayMs); session.completionTimer.unref?.(); }
  }
  handleMux(frame) {
    if (frame.type === 'session/projection' && frame.key === 'title') { const s = this.ensureSession(frame.sessionId); if (frame.seq > s.titleSeq) { s.title = frame.value; s.titleSeq = frame.seq; } }
    if (frame.type === 'session/event' && frame.event?.type === 'turn/end') this.ensureSession(frame.sessionId).reason = frame.event.data?.reason?.kind;
    if (frame.type === 'session/subscribed') this.jobs.delete(frame.sessionId);
    if (frame.type !== 'session/jobs') return;
    const previous = this.jobs.get(frame.sessionId) ?? new Map(); const next = new Map();
    for (const job of frame.jobs ?? []) { const old = previous.get(job.id); next.set(job.id, job); if (this.active && old && ACTIVE_JOBS.has(old.status) && TERMINAL_JOBS.has(job.status)) { const key = `job:${job.id}:${job.status}:${job.finishedAt ?? ''}`; if (!this.dedupe.has(key)) { this.dedupe.add(key); this.onCompletion?.({ kind: 'job', status: job.status, label: job.label, sessionId: frame.sessionId, jobId: job.id }); } } }
    this.jobs.set(frame.sessionId, next);
  }
}
module.exports = { CompletionWatcher, sessionLabel, socketUrl };
