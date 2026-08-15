import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
const ASSETS = join(__dirname, '..', 'assets');
const BUILD = join(__dirname, '..', 'build');
const SVG_PATH = join(ASSETS, 'icon.svg');

async function generate() {
  mkdirSync(BUILD, { recursive: true });

  const pngs = {};
  for (const size of SIZES) {
    const buf = await sharp(SVG_PATH).resize(size, size).png().toBuffer();
    pngs[size] = buf;
    writeFileSync(join(BUILD, `icon-${size}.png`), buf);
    console.log(`  Generated icon-${size}.png`);
  }

  // ICO for Windows (from 256x256 PNG)
  const icoBuf = await pngToIco([pngs[256]]);
  writeFileSync(join(BUILD, 'icon.ico'), icoBuf);
  console.log('  Generated icon.ico');

  // Default icon for Linux (512x512 PNG)
  writeFileSync(join(BUILD, 'icon.png'), pngs[512]);
  console.log('  Generated icon.png');
}

generate().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});