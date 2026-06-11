/**
 * CC Prompter — Next.js Plugin
 *
 * 为 Next.js dev server 提供集成。直接操作 webpack config（不通过 plugin.apply，
 * 因为 Next.js webpack 配置阶段没有 compiler 对象）。
 *
 * 用法：
 *   const { withCcPrompt } = require('cc-prompter/next');
 *   module.exports = withCcPrompt()({ /* next config *\/ });
 */

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

// Sidecar singleton — prevent duplicate starts across hot reloads
declare global {
  // eslint-disable-next-line no-var
  var __ccPrompterSidecarStarted: boolean | undefined;
}

/**
 * Next.js plugin wrapper for cc-prompter.
 *
 * Directly manipulates webpack config object (adds plugins to config.plugins,
 * modifies config.entry) instead of using plugin.apply() — because Next.js's
 * webpack() config function receives the config object, not the compiler.
 *
 * Usage:
 *   module.exports = withCcPrompt({ port: 3456 })({ ...nextConfig });
 */
export function withCcPrompt(options?: CcPromptNextOptions) {
  const startPort = options?.port || 3456;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function(nextConfig: any = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.assign({}, nextConfig, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webpack(config: any, context: any) {
        // Only inject in dev mode, client-side bundles
        if (context.dev && !context.isServer) {
          const projectRoot = options?.root || process.cwd();

          // ── 1. Start sidecar server (once, doesn't need webpack compiler) ──
          if (!globalThis.__ccPrompterSidecarStarted) {
            globalThis.__ccPrompterSidecarStarted = true;
            startSidecar(projectRoot, { startPort });
          }

          config.plugins = config.plugins || [];
          const webpack = require('webpack');

          // ── 2. Add code-inspector-plugin (webpack bundler) ──
          if (options?.inspector !== false) {
            config.plugins.push(codeInspectorPlugin({
              bundler: 'webpack',
              behavior: { locate: false, copy: false },
              hideDomPathAttr: true,
              hideConsole: true,
            }));
          }

          // ── 3. Inject client script via DefinePlugin ──
          const injectScript = getInjectScript();
          config.plugins.push(new webpack.DefinePlugin({
            '__CC_PROMPTER_INJECT_SCRIPT__': JSON.stringify(injectScript),
            '__CC_PROMPTER_PORT__': JSON.stringify(startPort),
          }));

          // ── 4. Prepend client-entry.js to all client entries ──
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
