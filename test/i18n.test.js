const assert = require('node:assert/strict');
const test = require('node:test');
const { DICTIONARIES, detectSystemLocale, normalizeLocale, translate } = require('../src/main/i18n');

test('locale dictionaries have matching keys', () => assert.deepEqual(Object.keys(DICTIONARIES.en).sort(), Object.keys(DICTIONARIES.zh).sort()));

test('detects supported system locale with zh fallback', () => {
  assert.equal(detectSystemLocale(['en-US']), 'en');
  assert.equal(detectSystemLocale(['fr-FR']), 'zh');
});

test('normalizes unknown locales to zh', () => {
  assert.equal(normalizeLocale('en'), 'en');
  assert.equal(normalizeLocale('zh'), 'zh');
  assert.equal(normalizeLocale('fr'), 'zh');
});

test('translates menu labels for both locales', () => {
  assert.equal(translate('zh', 'menu.edit'), '编辑');
  assert.equal(translate('en', 'menu.edit'), 'Edit');
  assert.equal(translate('zh', 'menu.environment'), '环境');
  assert.equal(translate('en', 'menu.environment'), 'Environment');
});

test('translates notification labels', () => {
  assert.equal(translate('en', 'notify.agent.completed'), 'Agent completed');
  assert.equal(translate('zh', 'notify.job.failed'), '后台任务失败');
});

test('falls back to zh dictionary then key for unknown keys', () => {
  assert.equal(translate('en', 'does.not.exist'), 'does.not.exist');
});
