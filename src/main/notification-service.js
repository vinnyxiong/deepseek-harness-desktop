const { EventEmitter } = require('events');
const { translate } = require('./i18n');

let electron = null;
try { electron = require('electron'); } catch { /* not running under Electron (tests) */ }

// Strip control characters and clamp length so notification text stays safe/legible.
function clean(value, max = 120) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

class NotificationService extends EventEmitter {
  constructor({
    settings,
    getLocale,
    onActivate,
    NotificationImpl = electron && typeof electron === 'object' ? electron.Notification : undefined,
    isAppFocused = () => Boolean(electron && typeof electron === 'object' && electron.BrowserWindow?.getFocusedWindow?.()),
  } = {}) {
    super();
    this.settings = settings;
    this.getLocale = getLocale;
    this.onActivate = onActivate;
    this.NotificationImpl = NotificationImpl;
    this.isAppFocused = isAppFocused;
    this.active = new Set();
    this.lastResult = null;
  }

  setSettings(settings) { this.settings = settings; }

  // Returns a reason string if a notification should be suppressed, otherwise null.
  suppression(kind, status) {
    if (!this.settings.enabled) return 'notifications-disabled';
    if (this.settings.onlyWhenUnfocused && this.isAppFocused()) return 'app-focused';
    if (kind === 'agent' && !this.settings.agentCompletions) return 'category-disabled';
    if (kind === 'job' && !this.settings.backgroundJobs?.[status]) return 'category-disabled';
    return null;
  }

  create(options, onClick) {
    const notification = new this.NotificationImpl(options);
    this.active.add(notification);
    const release = () => this.active.delete(notification);
    notification.on('close', release);
    notification.on('failed', release);
    const timer = setTimeout(release, 60000);
    timer.unref?.();
    if (onClick) notification.on('click', onClick);
    return notification;
  }

  record(result) {
    this.lastResult = { ...result, time: Date.now() };
    this.emit('result', this.lastResult);
    return this.lastResult;
  }

  show(event) {
    if (!this.NotificationImpl?.isSupported?.()) return this.record({ supported: false, attempted: false, outcome: 'unsupported', event });
    const reason = this.suppression(event.kind, event.status);
    if (reason) return this.record({ supported: true, attempted: false, outcome: 'suppressed', suppressionReason: reason, event });
    const locale = this.getLocale();
    const notification = this.create(
      {
        title: translate(locale, `notify.${event.kind}.${event.status}`),
        body: clean(event.label) || translate(locale, 'notify.unnamed'),
        silent: !this.settings.playSound,
      },
      this.settings.focusOnClick ? () => this.onActivate?.(event) : null,
    );
    notification.on('show', () => this.record({ supported: true, attempted: true, outcome: 'shown', event }));
    notification.on('failed', (_e, error) => this.record({ supported: true, attempted: true, outcome: 'failed', error: String(error || ''), event }));
    notification.show();
    return this.record({ supported: true, attempted: true, outcome: 'attempted', event });
  }

  async test(settings = this.settings, { timeoutMs = 2000 } = {}) {
    if (!this.NotificationImpl?.isSupported?.()) return this.record({ supported: false, attempted: false, outcome: 'unsupported' });
    const locale = this.getLocale();
    const notification = this.create(
      {
        title: translate(locale, 'notify.test.title'),
        body: translate(locale, 'notify.test.body'),
        silent: !settings.playSound,
      },
      settings.focusOnClick ? () => this.onActivate?.({ kind: 'test' }) : null,
    );
    const result = await new Promise(resolve => {
      let settled = false;
      let timer = null;
      const done = value => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      notification.once('show', () => done({ supported: true, attempted: true, outcome: 'shown' }));
      notification.once('failed', (_e, error) => done({ supported: true, attempted: true, outcome: 'failed', error: String(error || '') }));
      // The timer is the guaranteed fallback resolution, so it must stay referenced
      // (not unref'd) or an otherwise-idle event loop would leave this promise pending.
      timer = setTimeout(() => done({ supported: true, attempted: true, outcome: 'unconfirmed' }), timeoutMs);
      notification.show();
    });
    return this.record(result);
  }

  dispose() {
    for (const notification of this.active) try { notification.close(); } catch {}
    this.active.clear();
  }
}

module.exports = { NotificationService, clean };
