#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const CHECKABLE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

function isCheckable(name) {
  return CHECKABLE_EXTENSIONS.some(ext => name.endsWith(ext));
}

async function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(target));
    else if (entry.isFile() && isCheckable(entry.name)) files.push(target);
  }
  return files;
}

// Directories whose JavaScript/ESM sources are syntax-checked. `src` keeps the
// original behaviour; `scripts` covers the build/verify tooling (.mjs/.cjs).
const ROOTS = ['src', 'scripts'];

const files = [];
for (const root of ROOTS) files.push(...await collectFiles(root));

const unique = [...new Set(files)].sort();
for (const file of unique) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Syntax checked ${unique.length} JavaScript files.`);
