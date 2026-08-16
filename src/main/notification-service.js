const { Notification, BrowserWindow, app } = require('electron');
const { translate } = require('./i18n');

function clean(value, max = 120) { return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max); }
class NotificationService {
  constructor({ settings, getLocale, focusApp, NotificationImpl = Notification } = {}) {
    this.settings = settings; this.getLocale = getLocale; this.focusApp = focusApp; this.NotificationImpl = NotificationImpl; this.active = new Set();
  }
  setSettings(settings) { this.settings = settings; }
  shouldShow(kind, status) {
    if (!this.settings.enabled) return false;
    if (this.settings.onlyWhenUnfocused && BrowserWindow.getFocusedWindow()) return false;
    if (kind === 'agent') return this.settings.agentCompletions;
    return Boolean(this.settings.backgroundJobs[status]);
  }
  show(event, { force = false } = {}) {
    if (!this.NotificationImpl.isSupported() || (!force && !this.shouldShow(event.kind, event.status))) return { supported: this.NotificationImpl.isSupported(), shown: false };
    const locale = this.getLocale(); const title = translate(locale, `notify.${event.kind}.${event.status}`);
    const body = clean(event.label) || translate(locale, 'notify.unnamed');
    const notification = new this.NotificationImpl({ title, body, silent: !this.settings.playSound });
    this.active.add(notification);
    const release = () => this.active.delete(notification);
    notification.on('close', release);
    notification.on('failed', release);
    const timer = setTimeout(release, 60_000); timer.unref?.();
    if (this.settings.focusOnClick) notification.on('click', () => { app.focus({ steal: true }); this.focusApp?.(); });
    notification.show(); return { supported: true, shown: true };
  }
  dispose() { for (const notification of this.active) try { notification.close(); } catch {} this.active.clear(); }
  test(settings = this.settings) {
    const previous = this.settings; this.settings = settings;
    const locale = this.getLocale();
    const supported = this.NotificationImpl.isSupported();
    if (!supported) { this.settings = previous; return { supported: false, shown: false }; }
    const notification = new this.NotificationImpl({ title: translate(locale, 'notify.test.title'), body: translate(locale, 'notify.test.body'), silent: !settings.playSound });
    this.active.add(notification); const release = () => this.active.delete(notification); notification.on('close', release); notification.on('failed', release); const timer = setTimeout(release, 60_000); timer.unref?.();
    if (settings.focusOnClick) notification.on('click', () => { app.focus({ steal: true }); this.focusApp?.(); });
    notification.show(); this.settings = previous; return { supported: true, shown: true };
  }
}
module.exports = { NotificationService, clean };
