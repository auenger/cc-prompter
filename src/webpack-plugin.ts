/**
 * CC Prompter — Webpack Plugin
 *
 * 通用 webpack 插件，可在任意 webpack 项目中使用（不限于 Next.js）。
 *
 * 功能：
 *   1. 启动 Sidecar Express server 管理 PTY sessions
 *   2. 内置 code-inspector-plugin（Shift+Alt 悬停定位源码）
 *   3. 通过 DefinePlugin + entry 注入轻量脚本
 *
 * 仅在 dev 模式生效（可通过 dev 选项控制）。
 *
 * 用法：
 *   // webpack.config.js
 *   const { CcPromptWebpackPlugin } = require('cc-prompter/webpack');
 *   module.exports = {
 *     plugins: [
 *       new CcPromptWebpackPlugin(),
 *     ],
 *   };
 */

import type { Server } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import { startSidecar } from './sidecar.js';
import { getInjectScript } from './assets.js';

const _dirname = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

export interface CcPromptWebpackOptions {
  /** Sidecar 启动端口，默认 3456（被占用时自动 +1） */
  port?: number;
  /** 项目根目录，默认 process.cwd() */
  root?: string;
  /** 是否启用 code-inspector，默认 true */
  inspector?: boolean;
  /** 是否 dev 模式，默认 process.env.NODE_ENV !== 'production' */
  dev?: boolean;
}

export class CcPromptWebpackPlugin {
  private options: CcPromptWebpackOptions;
  private sidecarServer: Server | null = null;
  private sidecarStarted = false;
  private cleanedUp = false;

  constructor(options?: CcPromptWebpackOptions) {
    this.options = options || {};
  }

  apply(compiler: any): void {
    const isDev = this.options.dev !== undefined
      ? this.options.dev
      : process.env.NODE_ENV !== 'production';

    // Only activate in dev mode
    if (!isDev) return;

    const startPort = this.options.port || 3456;
    const clientEntryPath = join(_dirname, 'client-entry.js');

    // ── 1. Start sidecar server (once per plugin instance) ──
    if (!this.sidecarStarted) {
      this.sidecarStarted = true;
      const projectRoot = this.options.root || process.cwd();
      this.sidecarServer = startSidecar(projectRoot, { startPort });

      // Sidecar port will be logged by startSidecar itself
    }

    // Register cleanup hooks
    compiler.hooks.thisCompilation.tap('CcPromptWebpackPlugin', () => {
      // Ensure cleanup on process exit
      if (!this.cleanedUp) {
        this.setupCleanup();
      }
    });

    // ── 2. Add code-inspector-plugin ──
    if (this.options.inspector !== false) {
      const inspectorPlugin = codeInspectorPlugin({
        bundler: 'webpack',
        behavior: {
          locate: false,
          copy: false,
        },
        hideDomPathAttr: true,
        hideConsole: true,
      });
      // codeInspectorPlugin returns a webpack plugin instance
      if (inspectorPlugin && typeof inspectorPlugin.apply === 'function') {
        inspectorPlugin.apply(compiler);
      } else if (Array.isArray(inspectorPlugin)) {
        // Some versions return an array
        for (const p of inspectorPlugin) {
          if (p && typeof p.apply === 'function') p.apply(compiler);
        }
      }
    }

    // ── 3. Inject client script via DefinePlugin ──
    const webpack = require('webpack');
    const injectScript = getInjectScript();

    new webpack.DefinePlugin({
      '__CC_PROMPTER_INJECT_SCRIPT__': JSON.stringify(injectScript),
      '__CC_PROMPTER_PORT__': JSON.stringify(startPort),
    }).apply(compiler);

    // ── 4. Prepend client-entry.js to all entries ──
    const originalEntry = compiler.options.entry;
    compiler.options.entry = async () => {
      const entries: Record<string, any> = typeof originalEntry === 'function'
        ? await originalEntry()
        : originalEntry;

      // Handle both object entries ({ name: [...] }) and string/array entries
      if (typeof entries === 'string') {
        return { main: [clientEntryPath, entries] };
      }
      if (Array.isArray(entries)) {
        return { main: [clientEntryPath, ...entries] };
      }
      if (typeof entries === 'object') {
        for (const key in entries) {
          if (Array.isArray(entries[key])) {
            entries[key].unshift(clientEntryPath);
          } else if (typeof entries[key] === 'string') {
            entries[key] = [clientEntryPath, entries[key]];
          }
        }
      }
      return entries;
    };
  }

  private setupCleanup(): void {
    const cleanup = () => {
      if (this.cleanedUp) return;
      this.cleanedUp = true;
      if (this.sidecarServer) {
        this.sidecarServer.close();
        this.sidecarServer = null;
      }
    };
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);
  }
}
