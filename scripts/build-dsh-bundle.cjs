// Build a dsh-bundle.tar.gz for SSH transfer to remote hosts.
// Includes @deepseek-ai/* and their non-@deepseek-ai transitive deps.
//
// Usage: node scripts/build-dsh-bundle.mjs

const { execFileSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');

// Collect all non-@deepseek-ai packages that any @deepseek-ai/dsh dep depends on
function collectNonDeepseekDeps() {
  const seen = new Set();
  const queue = ['@deepseek-ai/dsh'];
  const result = new Set();

  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const pkgPath = resolve(root, 'node_modules', name, 'package.json');
    let deps = {};
    try { deps = JSON.parse(readFileSync(pkgPath, 'utf8')).dependencies || {}; } catch { continue; }

    for (const [depName] of Object.entries(deps)) {
      if (depName.startsWith('@deepseek-ai/')) {
        queue.push(depName);
      } else {
        result.add(depName);
      }
    }
  }
  return [...result];
}

const nonDeepseekDeps = collectNonDeepseekDeps();
console.log(`Found ${nonDeepseekDeps.length} non-@deepseek-ai transitive deps`);

const dshPkg = JSON.parse(readFileSync(resolve(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
const version = dshPkg.version;

// Create tar.gz
const tarArgs = [
  '-czf', resolve(root, 'dsh-bundle.tar.gz'),
  '-C', resolve(root, 'node_modules'),
  '@deepseek-ai',
  '.bin',
  ...nonDeepseekDeps,
];
console.log('Creating dsh-bundle.tar.gz...');
execFileSync('tar', tarArgs, { stdio: 'inherit' });

writeFileSync(resolve(root, 'dsh-bundle.version'), `${version}\n`, 'utf8');
console.log(`dsh-bundle.tar.gz created (version ${version})`);