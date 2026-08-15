import { copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(scriptDir, '..');
const buildDir = join(projectDir, 'build');
const iconsetDir = join(buildDir, 'icon.iconset');
const outputPath = join(buildDir, 'icon.icns');

const ICONSET_FILES = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (code=${code}, signal=${signal})`));
    });
  });
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS icon generation requires the system iconutil command');
  }

  await rm(iconsetDir, { recursive: true, force: true });
  await mkdir(iconsetDir, { recursive: true });

  for (const [size, name] of ICONSET_FILES) {
    await copyFile(join(buildDir, `icon-${size}.png`), join(iconsetDir, name));
  }

  await run('iconutil', ['--convert', 'icns', '--output', outputPath, iconsetDir]);
  await rm(iconsetDir, { recursive: true, force: true });
  console.log(`Generated ${outputPath}`);
}

main().catch((error) => {
  console.error(`macOS icon generation failed: ${error.message}`);
  process.exit(1);
});
