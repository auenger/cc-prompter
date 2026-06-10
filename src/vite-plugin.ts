/**
 * CC Prompter — Vite Plugin
 *
 * 为 Vite dev server 提供：
 *   1. 内置 code-inspector-plugin（Shift+Alt 悬停定位源码）
 *   2. 启动 Sidecar Express server 管理 PTY sessions（自动选择空闲端口）
 *   3. 注入轻量脚本监听 code-inspector 事件，弹出 Claude 面板
 *   4. 提供 /__panel/ HTML 给 iframe
 *
 * 仅在 dev 模式生效，build 时不注入脚本。
 *
 * 用法：plugins: [ccPromptPlugin()]
 * 等同于同时配置 codeInspectorPlugin + cc-prompt-plugin。
 */

import type { Plugin } from 'vite';
import type { Server } from 'http';
import { codeInspectorPlugin } from 'code-inspector-plugin';
import { startSidecar } from './sidecar.js';
import { getPanelHtml, getInjectScript } from './assets.js';

export interface CcPromptOptions {
  /** Sidecar 启动端口，默认 3456（被占用时自动 +1） */
  port?: number;
  /** 项目根目录，默认 vite config.root */
  root?: string;
  /** 是否启用 code-inspector，默认 true */
  inspector?: boolean;
}

export function ccPromptPlugin(options?: CcPromptOptions): Plugin[] {
  const enableInspector = options?.inspector !== false;
  let projectRoot = process.cwd();
  let sidecarServer: Server | null = null;
  let actualPort = 0;

  const startPort = options?.port || 3456;

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (sidecarServer) {
      sidecarServer.close();
      sidecarServer = null;
    }
  }

  // ── 1. code-inspector plugin ──
  const inspectorPlugin = enableInspector
    ? codeInspectorPlugin({
        bundler: 'vite',
        behavior: {
          locate: false,
          copy: false,
        },
        hideDomPathAttr: true,
        hideConsole: true,
      })
    : null;

  // ── 2. cc-prompter plugin ──
  const promptPlugin: Plugin = {
    name: 'cc-prompt-plugin',

    configResolved(config) {
      projectRoot = options?.root || config.root;
    },

    configureServer(server) {
      // Start sidecar — auto-picks available port
      sidecarServer = startSidecar(projectRoot, { startPort });

      // Wait for sidecar to actually start, then grab port
      const checkPort = () => {
        const addr = sidecarServer?.address();
        if (addr && typeof addr === 'object') {
          actualPort = addr.port;
          console.log(`[cc-prompter] Sidecar port: ${actualPort}`);
        }
      };
      setTimeout(checkPort, 200);
      setTimeout(checkPort, 1000);

      // Expose actual sidecar port to inject script
      server.middlewares.use('/__cc-port', (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(String(actualPort || startPort));
      });

      // Clean up on dev server close
      server.httpServer?.on('close', cleanup);
      process.on('SIGTERM', () => { cleanup(); process.exit(0); });
      process.on('SIGINT', () => { cleanup(); process.exit(0); });
      process.on('exit', cleanup);
    },

    // Only inject in dev mode (ctx.server is undefined during build)
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.server) return html;
        const script = getInjectScript();
        return html.replace('</body>', `<script>${script}</script></body>`);
      },
    },

    closeBundle() {
      cleanup();
    },
  };

  // Return composed plugin array
  const plugins: Plugin[] = [promptPlugin];
  if (inspectorPlugin) plugins.unshift(inspectorPlugin);
  return plugins;
}
