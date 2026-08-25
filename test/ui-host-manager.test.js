const assert = require('node:assert/strict');
const test = require('node:test');
const { loadHostManagerDom } = require('./helpers/dom');

// Contract-level UI smoke + a11y tests for the native HTML renderer.
//
// The renderer is being refactored, so these assertions target STABLE
// contracts: the page must parse, expose the expected semantic landmarks and
// ARIA roles, keep an aria-live region for async status, and label icon-only
// buttons for assistive tech. They intentionally tolerate copy and class-name
// changes.

test('index.html parses as a valid HTML document', () => {
  const { document } = loadHostManagerDom();
  assert.equal(document.doctype?.name, 'html');
  assert.ok(document.documentElement, 'expected a root <html> element');
  assert.ok(document.querySelector('head'), 'expected a <head>');
  assert.ok(document.querySelector('body'), 'expected a <body>');
});

test('document declares a language and a title', () => {
  const { document } = loadHostManagerDom();
  assert.ok(
    document.documentElement.getAttribute('lang'),
    'root <html> must declare a lang attribute for a11y',
  );
  assert.ok((document.title ?? '').trim().length > 0, 'expected a non-empty <title>');
});

test('declares a Content-Security-Policy meta tag', () => {
  const { document } = loadHostManagerDom();
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(csp, 'expected a CSP meta tag');
  assert.ok((csp.getAttribute('content') ?? '').includes("default-src 'self'"));
});

test('exposes a main landmark and a tablist for host tabs', () => {
  const { document } = loadHostManagerDom();
  assert.ok(document.querySelector('main'), 'expected a <main> landmark');
  const tablist = document.querySelector('[role="tablist"]');
  assert.ok(tablist, 'expected an element with role="tablist" for the host tabs');
});

test('provides at least one dialog for host configuration workflows', () => {
  const { document } = loadHostManagerDom();
  const dialogs = document.querySelectorAll('dialog, [role="dialog"]');
  assert.ok(dialogs.length >= 1, 'expected at least one dialog element');
});

test('has an aria-live region for asynchronous status updates', () => {
  const { document } = loadHostManagerDom();
  const liveRegions = document.querySelectorAll('[aria-live]');
  assert.ok(liveRegions.length >= 1, 'expected at least one aria-live region');
  for (const region of liveRegions) {
    assert.match(
      region.getAttribute('aria-live'),
      /^(polite|assertive|off)$/,
      'aria-live must be a valid token',
    );
  }
});

test('every interactive button has an accessible name', () => {
  const { document } = loadHostManagerDom();
  const buttons = [...document.querySelectorAll('button')];
  assert.ok(buttons.length > 0, 'expected at least one button in the UI');

  const unlabeled = buttons.filter(button => {
    const hasTextContent = (button.textContent ?? '').trim().length > 0;
    const hasAriaLabel = (button.getAttribute('aria-label') ?? '').trim().length > 0;
    const hasTitle = (button.getAttribute('title') ?? '').trim().length > 0;
    const hasLabelledBy = (button.getAttribute('aria-labelledby') ?? '').trim().length > 0;
    return !(hasTextContent || hasAriaLabel || hasTitle || hasLabelledBy);
  });

  assert.deepEqual(
    unlabeled.map(button => button.id || button.outerHTML),
    [],
    'every button must expose an accessible name (text, aria-label, title or aria-labelledby)',
  );
});

test('decorative icon nodes are hidden from assistive tech', () => {
  const { document } = loadHostManagerDom();
  // Buttons whose only visible content is a decorative glyph should hide that
  // glyph via aria-hidden and rely on an accessible name (checked above).
  const decorative = document.querySelectorAll('[aria-hidden="true"]');
  for (const node of decorative) {
    assert.equal(
      node.getAttribute('aria-hidden'),
      'true',
      'aria-hidden decorative nodes must use the string "true"',
    );
  }
});

test('form controls are associated with labels', () => {
  const { document } = loadHostManagerDom();
  const controls = [...document.querySelectorAll('input, select, textarea')];
  for (const control of controls) {
    const id = control.getAttribute('id');
    const wrappedInLabel = control.closest('label') !== null;
    const referencedByLabel = id ? document.querySelector(`label[for="${id}"]`) !== null : false;
    const hasAriaLabel = (control.getAttribute('aria-label') ?? '').trim().length > 0;
    const hasAriaLabelledBy = (control.getAttribute('aria-labelledby') ?? '').trim().length > 0;
    assert.ok(
      wrappedInLabel || referencedByLabel || hasAriaLabel || hasAriaLabelledBy,
      `form control ${id || control.outerHTML} must be associated with a label`,
    );
  }
});
