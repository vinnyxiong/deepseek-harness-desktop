const zh = require('../locales/zh.json');
const en = require('../locales/en.json');
const DICTIONARIES = { zh, en };

function normalizeLocale(value) { return value === 'en' ? 'en' : 'zh'; }
function translate(locale, key) { return DICTIONARIES[normalizeLocale(locale)][key] ?? zh[key] ?? key; }
function detectSystemLocale(languages = []) {
  for (const language of languages) {
    const primary = String(language).toLowerCase().split('-')[0];
    if (primary === 'zh' || primary === 'en') return primary;
  }
  return 'zh';
}
module.exports = { DICTIONARIES, detectSystemLocale, normalizeLocale, translate };
