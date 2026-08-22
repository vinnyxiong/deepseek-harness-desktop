// Build a dsh-bundle.tar.gz for SSH transfer to remote hosts.
// Includes all node_modules except dev-only packages.
//
// Usage: node scripts/build-dsh-bundle.cjs

const { execFileSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');

const dshPkg = JSON.parse(readFileSync(resolve(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
const version = dshPkg.version;

// Exclude dev-only packages to keep the bundle small.
// These are needed for building/developing but not at runtime.
const exclude = [
  'electron',
  'electron-builder',
  'electron-updater',
  'sharp',
  'png-to-ico',
  '.cache',
  '.package-lock.json',
];

const tarArgs = [
  '-czf', resolve(root, 'dsh-bundle.tar.gz'),
  '-C', resolve(root, 'node_modules'),
  ...exclude.flatMap(e => ['--exclude', e]),
  '.',
];

console.log('Creating dsh-bundle.tar.gz...');
execFileSync('tar', tarArgs, { stdio: 'inherit' });

writeFileSync(resolve(root, 'dsh-bundle.version'), `${version}\n`, 'utf8');

const { statSync } = require('fs');
const size = statSync(resolve(root, 'dsh-bundle.tar.gz')).size;
console.log(`dsh-bundle.tar.gz created (version ${version}, ${(size / 1024 / 1024).toFixed(1)} MB)`);