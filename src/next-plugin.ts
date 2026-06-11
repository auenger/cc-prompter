/**
 * CC Prompter — Next.js Plugin
 *
 * 为 Next.js dev server 提供：
 *   1. 启动 Sidecar Express server 管理 PTY sessions
 *   2. 内置 code-inspector-plugin（Shift+Alt 悬停定位源码）
 *   3. 通过 webpack entry + DefinePlugin 注入轻量脚本
 *
 * 仅在 dev 模式生效，build 时不注入脚本。
 *
 * 用法：
 *   const { withCcPrompt } = require('cc-prompter/next');
 *   module.exports = withCcPrompt()({ /* next config *\/ });
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

export interface CcPromptNextOptions {
  /** Sidecar 启动端口，默认 3456（被占用时自动 +1） */
  port?: number;
  /** 项目根目录，默认 process.cwd() */
  root?: string;
  /** 是否启用 code-inspector，默认 true */
  inspector?: boolean;
}

/**
 * Next.js plugin wrapper for cc-prompter.
 *
 * Usage:
 *   module.exports = withCcPrompt({ port: 3456 })({ ...nextConfig });
 */
export function withCcPrompt(options?: CcPromptNextOptions) {
  const startPort = options?.port || 3456;
  let sidecarServer: Server | null = null;
  let sidecarStarted = false;

  // Cleanup on process exit
  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (sidecarServer) {
      sidecarServer.close();
      sidecarServer = null;
    }
  }
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function(nextConfig: any = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.assign({}, nextConfig, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webpack(config: any, context: any) {
        // Only inject in dev mode, client-side bundles
        if (context.dev && !context.isServer) {
          // ── 1. Start sidecar server (once) ──
          if (!sidecarStarted) {
            sidecarStarted = true;
            const projectRoot = options?.root || process.cwd();
            sidecarServer = startSidecar(projectRoot, { startPort });

            const addr = sidecarServer.address();
            if (addr && typeof addr === 'object') {
              console.log(`[cc-prompter] Sidecar port: ${addr.port}`);
            } else {
              // Address not yet assigned — check again shortly
              setTimeout(() => {
                const a = sidecarServer?.address();
                if (a && typeof a === 'object') {
                  console.log(`[cc-prompter] Sidecar port: ${a.port}`);
                }
              }, 500);
            }
          }

          // ── 2. Add code-inspector-plugin (webpack bundler) ──
          if (options?.inspector !== false) {
            config.plugins = config.plugins || [];
            config.plugins.push(codeInspectorPlugin({
              bundler: 'webpack',
              behavior: {
                locate: false,
                copy: false,
              },
              hideDomPathAttr: true,
              hideConsole: true,
            }));
          }

          // ── 3. Inject client script via DefinePlugin + entry prepend ──
          const webpack = require('webpack');
          const injectScript = getInjectScript();

          // DefinePlugin replaces these identifiers at compile time
          config.plugins.push(new webpack.DefinePlugin({
            '__CC_PROMPTER_INJECT_SCRIPT__': JSON.stringify(injectScript),
            '__CC_PROMPTER_PORT__': JSON.stringify(startPort),
          }));

          // Prepend client-entry.js to all client webpack entries
          const clientEntryPath = join(_dirname, 'client-entry.js');
          const originalEntry = config.entry;
          config.entry = async () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const entries: Record<string, any> = typeof originalEntry === 'function'
              ? await originalEntry()
              : originalEntry;
            for (const key in entries) {
              if (Array.isArray(entries[key])) {
                entries[key].unshift(clientEntryPath);
              }
            }
            return entries;
          };
        }

        // Chain existing webpack config function
        if (typeof nextConfig.webpack === 'function') {
          return nextConfig.webpack(config, context);
        }
        return config;
      },
    });
  };
}
