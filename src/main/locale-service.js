const { EventEmitter } = require('events');
const { callDsh } = require('./dsh-api-client');
const { detectSystemLocale, normalizeLocale } = require('./i18n');
class LocaleService extends EventEmitter {
  constructor({ systemLanguages = [], callApi = callDsh } = {}) { super(); this.callApi = callApi; this.systemLocale = detectSystemLocale(systemLanguages); this.locale = this.systemLocale; this.endpoint = null; this.generation = 0; this.revision = 0; }
  getLocale() { return this.locale; }
  async setEndpoint(endpoint) { this.endpoint = endpoint; const generation = ++this.generation; this.revision = 0; await this.refresh(generation, ++this.revision); }
  clearEndpoint() { this.endpoint = null; ++this.generation; ++this.revision; }
  async refresh(generation = this.generation, revision = ++this.revision) {
    if (!this.endpoint) return this.locale;
    try {
      const result = await this.callApi(this.endpoint, 'settings.describe', {});
      if (generation !== this.generation || revision !== this.revision) return this.locale;
      const preference = result.namespaces?.find(item => item.ns === 'locale')?.value?.preference;
      const next = preference === 'en' || preference === 'zh' ? preference : this.systemLocale;
      if (next !== this.locale) { this.locale = normalizeLocale(next); this.emit('change', this.locale); }
    } catch {}
    return this.locale;
  }
  handleHostFrame(frame) { if (frame?.type === 'host/remote-event' && frame.event === 'settings/document-updated' && frame.args?.[0] === 'locale') void this.refresh(this.generation, ++this.revision); }
}
module.exports = { LocaleService };
