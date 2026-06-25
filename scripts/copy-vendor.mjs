import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'public');

async function copyFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function copyDir(srcDir, dstDir) {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (ent) => {
      const src = path.join(srcDir, ent.name);
      const dst = path.join(dstDir, ent.name);
      if (ent.isDirectory()) return copyDir(src, dst);
      if (ent.isFile()) return copyFile(src, dst);
    })
  );
}

async function main() {
  const chartSrc = path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
  const chartDst = path.join(publicDir, 'vendor', 'chartjs', 'chart.umd.min.js');
  await copyFile(chartSrc, chartDst);

  const faCssSrc = path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'css', 'all.min.css');
  const faCssDst = path.join(publicDir, 'vendor', 'fontawesome', 'css', 'all.min.css');
  await copyFile(faCssSrc, faCssDst);

  const faWebfontsSrc = path.join(root, 'node_modules', '@fortawesome', 'fontawesome-free', 'webfonts');
  const faWebfontsDst = path.join(publicDir, 'vendor', 'fontawesome', 'webfonts');
  await copyDir(faWebfontsSrc, faWebfontsDst);
}

main().catch((e) => {
  console.error('[copy-vendor] failed:', e);
  process.exitCode = 1;
});
