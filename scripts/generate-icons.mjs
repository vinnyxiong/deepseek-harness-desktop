import crypto from 'node:crypto';
import { readFile, rename, rm, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const CACHE_VERSION = 1;

export async function fingerprintIcon(sourcePath, sizes = SIZES) {
  const source = await readFile(sourcePath);
  return crypto.createHash('sha256').update(source).update(JSON.stringify({ cacheVersion: CACHE_VERSION, sizes })).digest('hex');
}

async function validFile(path) {
  try { return (await stat(path)).isFile() && (await stat(path)).size > 0; } catch { return false; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

export async function atomicWrite(path, data) {
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try { await writeFile(temp, data); await rename(temp, path); } finally { await rm(temp, { force: true }); }
}

export async function generateIcons({
  projectDir = join(scriptDir, '..'), force = false, sharpFactory = sharp, icoFactory = pngToIco,
} = {}) {
  const sourcePath = join(projectDir, 'assets', 'icon.svg');
  const buildDir = join(projectDir, 'build');
  const metadataPath = join(buildDir, '.icons.cache.json');
  const outputs = [...SIZES.map((size) => join(buildDir, `icon-${size}.png`)), join(buildDir, 'icon.ico'), join(buildDir, 'icon.png')];
  const fingerprint = await fingerprintIcon(sourcePath);
  const metadata = await readJson(metadataPath);
  if (!force && metadata?.cacheVersion === CACHE_VERSION && metadata.fingerprint === fingerprint
      && (await Promise.all(outputs.map(validFile))).every(Boolean)) {
    console.log('Icons are up to date');
    return { cached: true, fingerprint };
  }

  await mkdir(buildDir, { recursive: true });
  const pngs = {};
  for (const size of SIZES) {
    const buffer = await sharpFactory(sourcePath).resize(size, size).png().toBuffer();
    pngs[size] = buffer;
    await atomicWrite(join(buildDir, `icon-${size}.png`), buffer);
    console.log(`  Generated icon-${size}.png`);
  }
  await atomicWrite(join(buildDir, 'icon.ico'), await icoFactory([pngs[256]]));
  await atomicWrite(join(buildDir, 'icon.png'), pngs[512]);
  await atomicWrite(metadataPath, `${JSON.stringify({ cacheVersion: CACHE_VERSION, fingerprint }, null, 2)}\n`);
  console.log('  Generated icon.ico and icon.png');
  return { cached: false, fingerprint };
}

function parseForce(args) {
  const unknown = args.filter((arg) => arg !== '--force');
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  return args.includes('--force');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateIcons({ force: parseForce(process.argv.slice(2)) }).catch((error) => {
    console.error('Icon generation failed:', error);
    process.exitCode = 1;
  });
}

export { parseForce, validFile };
