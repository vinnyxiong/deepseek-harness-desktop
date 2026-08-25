'use strict';

// Shared jsdom helper for renderer UI contract tests.
//
// The native HTML renderer under src/renderer/host-manager/ is being
// refactored, so these helpers deliberately expose only structural / a11y
// contracts (roles, landmarks, aria-* attributes) rather than concrete
// class names or copy. Load the HTML with scripts disabled so we never
// execute renderer JS (which expects Electron preload globals).

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const HOST_MANAGER_HTML = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'renderer',
  'host-manager',
  'index.html',
);

function readHostManagerHtml() {
  return fs.readFileSync(HOST_MANAGER_HTML, 'utf8');
}

// Parse index.html into a jsdom document without running any scripts or
// fetching external resources. Returns { dom, document, window }.
function loadHostManagerDom() {
  const html = readHostManagerHtml();
  const dom = new JSDOM(html, {
    // Never execute renderer scripts: they reference Electron preload APIs.
    runScripts: undefined,
    resources: undefined,
    pretendToBeVisual: true,
  });
  return { dom, document: dom.window.document, window: dom.window };
}

module.exports = { HOST_MANAGER_HTML, readHostManagerHtml, loadHostManagerDom };
