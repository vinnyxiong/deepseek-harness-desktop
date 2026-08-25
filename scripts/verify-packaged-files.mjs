#!/usr/bin/env node

// Verifies that every file the desktop app relies on at runtime is present.
//
// Two modes:
//   node scripts/verify-packaged-files.mjs                 # verify the source tree (default, no build needed)
//   node scripts/verify-packaged-files.mjs --source
//   node scripts/verify-packaged-files.mjs --asar <path>   # verify a packaged app.asar via `npx asar list`
//
// The manifest below is the single source of truth shared by local runs and CI.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');

// Repo-relative POSIX paths that MUST ship inside the packaged app.asar.
// Keep this in sync with the actual module layout under src/.
export const REQUIRED_PACKAGED_FILES = Object.freeze([
  'src/main.js',
  'src/main/auto-updater.js',
  'src/main/completion-watcher.js',
  'src/main/connection-actions.js',
  'src/main/dsh-api-client.js',
  'src/main/dsh-health.js',
  'src/main/host-manager.js',
  'src/main/host-store.js',
  'src/main/i18n.js',
  'src/main/ipc.js',
  'src/main/local-dsh.js',
  'src/main/locale-service.js',
  'src/main/managed-ssh.js',
  'src/main/process-utils.js',
  'src/main/remote-dsh.js',
  'src/main/windows.js',
  'src/preload/host-manager.js',
  'src/renderer/host-manager/index.html',
  'src/renderer/host-manager/index.js',
  'src/renderer/host-manager/index.css',
  'src/locales/en.json',
  'src/locales/zh.json',
]);

export function verifySourceTree(root = repoRoot) {
  const missing = REQUIRED_PACKAGED_FILES.filter(rel => !existsSync(join(root, rel)));
  return missing;
}

function listAsarEntries(asarPath) {
  const output = execFileSync('npx', ['asar', 'list', asarPath], { encoding: 'utf8' });
  return new Set(
    output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
}

export function verifyAsar(asarPath) {
  const entries = listAsarEntries(asarPath);
  return REQUIRED_PACKAGED_FILES.filter(rel => !entries.has(`/${rel}`));
}

function parseArgs(argv) {
  const args = { mode: 'source', asarPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      args.mode = 'source';
    } else if (arg === '--asar') {
      args.mode = 'asar';
      args.asarPath = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--asar=')) {
      args.mode = 'asar';
      args.asarPath = arg.slice('--asar='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let missing;
  let target;
  if (args.mode === 'asar') {
    if (!args.asarPath) {
      console.error('Usage: node scripts/verify-packaged-files.mjs --asar <path-to-app.asar>');
      process.exit(2);
    }
    target = `app.asar (${args.asarPath})`;
    missing = verifyAsar(resolve(args.asarPath));
  } else {
    target = `source tree (${repoRoot})`;
    missing = verifySourceTree();
  }

  if (missing.length > 0) {
    console.error(`Missing packaged files in ${target}:`);
    for (const rel of missing) console.error(`  - ${rel}`);
    process.exit(1);
  }

  console.log(`Verified ${REQUIRED_PACKAGED_FILES.length} packaged files in ${target}.`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === scriptPath;
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}
