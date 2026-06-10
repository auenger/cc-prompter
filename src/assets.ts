/**
 * CC Prompter — Asset Loader
 *
 * 运行时从包根目录读取 panel.html 和 inject.js。
 * 兼容 ESM（import.meta.url）和 CJS（__dirname）。
 *
 * 解析策略：
 *   - tsup 构建后：资产文件复制到 dist/，__dirname 是 dist/
 *   - Vite 直接引用 TS：__dirname 是 src/，资产文件在上一级
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve __dirname in both ESM and CJS contexts
const _dirname = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

/** Resolve asset path — checks dist/ (build) then parent (dev) */
function assetPath(filename: string): string {
  // 1. Same dir as this file (dist/ after build, or src/ in dev)
  const here = join(_dirname, filename);
  if (existsSync(here)) return here;

  // 2. Parent dir (package root — when running from src/ via vite)
  const parent = join(_dirname, '..', filename);
  if (existsSync(parent)) return parent;

  // 3. Fallback — let it throw with a clear message
  throw new Error(
    `[cc-prompter] Asset not found: ${filename}\n` +
    `  Tried: ${here}\n` +
    `  Tried: ${parent}\n` +
    `  __dirname: ${_dirname}`
  );
}

export function getPanelHtml(): string {
  return readFileSync(assetPath('panel.html'), 'utf8');
}

export function getInjectScript(): string {
  return readFileSync(assetPath('inject.js'), 'utf8');
}
