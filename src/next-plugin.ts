/**
 * CC Prompter — Next.js Plugin
 *
 * 为 Next.js dev server 提供集成。内部复用 CcPromptWebpackPlugin。
 *
 * 用法：
 *   const { withCcPrompt } = require('cc-prompter/next');
 *   module.exports = withCcPrompt()({ /* next config *\/ });
 */

import { CcPromptWebpackPlugin } from './webpack-plugin.js';

export type { CcPromptWebpackOptions as CcPromptNextOptions } from './webpack-plugin.js';

/**
 * Next.js plugin wrapper for cc-prompter.
 *
 * Creates a webpack plugin instance per call, and applies it
 * inside Next.js's webpack config hook (dev + client-side only).
 *
 * Usage:
 *   module.exports = withCcPrompt({ port: 3456 })({ ...nextConfig });
 */
export function withCcPrompt(options?: import('./webpack-plugin.js').CcPromptWebpackOptions) {
  return function(nextConfig: any = {}) {
    return Object.assign({}, nextConfig, {
      webpack(config: any, context: any) {
        // Only inject in dev mode, client-side bundles
        if (context.dev && !context.isServer) {
          const plugin = new CcPromptWebpackPlugin({
            ...options,
            dev: true,
          });
          plugin.apply(config._compiler || { options: config, hooks: {} });

          // Fallback: directly manipulate config if apply() couldn't access compiler
          // (Next.js passes the webpack config, not the compiler instance)
          const startPort = options?.port || 3456;
          const webpack = require('webpack');

          if (options?.inspector !== false) {
            const { codeInspectorPlugin } = require('code-inspector-plugin');
            config.plugins = config.plugins || [];
            config.plugins.push(codeInspectorPlugin({
              bundler: 'webpack',
              behavior: { locate: false, copy: false },
              hideDomPathAttr: true,
              hideConsole: true,
            }));
          }

          const { getInjectScript } = require('./assets.js');
          config.plugins.push(new webpack.DefinePlugin({
            '__CC_PROMPTER_INJECT_SCRIPT__': JSON.stringify(getInjectScript()),
            '__CC_PROMPTER_PORT__': JSON.stringify(startPort),
          }));

          // Prepend client-entry to entries
          const { join, dirname } = require('path');
          const _dirname = typeof __dirname !== 'undefined' ? __dirname : dirname(require('url').fileURLToPath(import.meta.url));
          const clientEntryPath = join(_dirname, 'client-entry.js');
          const originalEntry = config.entry;
          config.entry = async () => {
            const entries = typeof originalEntry === 'function'
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
