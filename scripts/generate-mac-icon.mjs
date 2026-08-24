import crypto from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const CACHE_VERSION = 1;
export const ICONSET_FILES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'], [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'], [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'], [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

export function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (code=${code}, signal=${signal})`)));
  });
}

async function fingerprintInputs(buildDir) {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ cacheVersion: CACHE_VERSION, files: ICONSET_FILES }));
  for (const [size, name] of ICONSET_FILES) hash.update(name).update(await readFile(join(buildDir, `icon-${size}.png`)));
  return hash.digest('hex');
}
async function validFile(path) { try { return (await stat(path)).size > 0; } catch { return false; } }
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function atomicWrite(path, data) {
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { await writeFile(temp, data); await rename(temp, path); } finally { await rm(temp, { force: true }); }
}

export async function generateMacIcon({ projectDir = join(scriptDir, '..'), force = false, platform = process.platform, runner = run } = {}) {
  const buildDir = join(projectDir, 'build');
  const outputPath = join(buildDir, 'icon.icns');
  if (platform !== 'darwin') {
    // On non-macOS, skip if the icns file already exists (e.g. pre-built or from a previous run).
    if (await validFile(outputPath)) {
      console.log('macOS icon is up to date (skipped: not on macOS)');
      return { cached: true };
    }
    throw new Error('macOS icon generation requires the system iconutil command');
  }
  const metadataPath = join(buildDir, '.mac-icon.cache.json');
  const fingerprint = await fingerprintInputs(buildDir);
  const metadata = await readJson(metadataPath);
  if (!force && metadata?.cacheVersion === CACHE_VERSION && metadata.fingerprint === fingerprint && await validFile(outputPath)) {
    console.log('macOS icon is up to date');
    return { cached: true, fingerprint };
  }

  // iconutil requires the input directory name to end in .iconset.
  const iconsetDir = join(buildDir, `.icon.tmp-${process.pid}-${crypto.randomUUID()}.iconset`);
  // iconutil requires the output path itself to end in .icns.
  const tempOutput = join(buildDir, `.icon.tmp-${process.pid}-${crypto.randomUUID()}.icns`);
  await mkdir(iconsetDir, { recursive: true });
  try {
    for (const [size, name] of ICONSET_FILES) await copyFile(join(buildDir, `icon-${size}.png`), join(iconsetDir, name));
    await runner('iconutil', ['--convert', 'icns', '--output', tempOutput, iconsetDir]);
    if (!await validFile(tempOutput)) throw new Error('generated macOS icon is empty');
    await rename(tempOutput, outputPath);
    await atomicWrite(metadataPath, `${JSON.stringify({ cacheVersion: CACHE_VERSION, fingerprint }, null, 2)}\n`);
  } finally {
    await rm(iconsetDir, { recursive: true, force: true });
    await rm(tempOutput, { force: true });
  }
  console.log(`Generated ${outputPath}`);
  return { cached: false, fingerprint };
}

function parseForce(args) {
  const unknown = args.filter((arg) => arg !== '--force');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  return args.includes('--force');
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateMacIcon({ force: parseForce(process.argv.slice(2)) }).catch((error) => {
    console.error(`macOS icon generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
export { atomicWrite, fingerprintInputs, parseForce, validFile };
