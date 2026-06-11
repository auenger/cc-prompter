/**
 * CC Prompter — Sidecar API Server
 *
 * Express server 运行在端口 3456，管理 PTY session 生命周期。
 * 提供 REST API + SSE 流式响应。
 */

import express from 'express';
import { createServer, type Server } from 'http';
import { PtySession } from './pty-session.js';
import { getPanelHtml } from './assets.js';
import type {
  SessionInfo,
  CreateSessionRequest,
  SendMessageRequest,
  SendCommandRequest,
  SseEvent,
} from './types.js';

// ── Session Manager ─────────────────────────────────────

class SessionManager {
  private sessions = new Map<string, PtySession>();
  private counter = 0;

  async create(cwd: string): Promise<PtySession> {
    const id = `s${++this.counter}-${Date.now().toString(36)}`;
    const session = new PtySession(id, cwd);
    this.sessions.set(id, session);

    // Clean up on exit
    session.on('exit', () => {
      // Keep in map for history, but mark exited
    });

    await session.spawn();
    return session;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => {
      const info = s.getInfo();
      return {
        id: info.id,
        title: info.title,
        status: info.status,
        createdAt: info.createdAt,
        lastActivityAt: info.lastActivityAt,
        messageCount: info.messageCount,
        lastMessagePreview: info.lastMessagePreview,
      };
    });
  }

  destroy(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    return true;
  }

  destroyAll(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }
}

// ── Sidecar Server ──────────────────────────────────────

export interface SidecarOptions {
  startPort?: number;
}

export function startSidecar(projectRoot: string, options?: SidecarOptions): Server {
  const startPort = options?.startPort || 3456;
  const app = express();
  app.use(express.json());

  const manager = new SessionManager();

  // ── CORS for iframe ──
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // ── Panel HTML (served to iframe) ──
  app.get('/__panel/', (_req, res) => {
    const html = getPanelHtml();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    res.end(html);
  });

  // ── Panel favicon (no-op) ──
  app.get('/favicon.ico', (_req, res) => {
    res.sendStatus(204);
  });

  // ── List sessions ──
  app.get('/api/sessions', (_req, res) => {
    res.json(manager.list());
  });

  // ── Create session ──
  app.post<Record<string, string>, any, CreateSessionRequest>('/api/sessions', async (req, res) => {
    try {
      const cwd = req.body?.cwd || projectRoot;
      const session = await manager.create(cwd);
      res.json(session.getInfo());
    } catch (err: any) {
      console.error('[cc-prompter] Failed to create session:', err);
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // ── Send message (SSE stream) ──
  app.post<Record<string, string>, any, SendMessageRequest>(
    '/api/sessions/:id/message',
    async (req, res) => {
      const session = manager.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      if (session.status === 'exited') {
        res.status(410).json({ error: 'Session exited' });
        return;
      }
      if (session.status === 'busy') {
        res.status(409).json({ error: 'Session busy' });
        return;
      }

      const { content, sourceInfo } = req.body;
      if (!content) {
        res.status(400).json({ error: 'Missing content' });
        return;
      }

      // Build prompt with optional source context (single-line to avoid multi-line input mode)
      let prompt = content;
      if (sourceInfo) {
        const relPath = sourceInfo.path;
        const parts = [
          `[source: ${relPath}:${sourceInfo.line}:${sourceInfo.column}]`,
        ];
        if (sourceInfo.elementInfo) {
          parts.push(`[element: ${sourceInfo.elementInfo}]`);
        }
        prompt = parts.join(' ') + ' ' + content;
      }

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Forward session events as SSE
      const onMessage = (evt: SseEvent) => {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);

        // Stop streaming on 'done'
        if (evt.type === 'done') {
          cleanup();
        }
      };

      const onError = (err: Error) => {
        res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
        cleanup();
      };

      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        session.removeListener('message', onMessage);
        session.removeListener('error', onError);
        res.end();
      };

      session.on('message', onMessage);
      session.on('error', onError);

      // Client disconnect — delay registration to avoid premature close
      // (Express/Node HTTP can fire 'close' early on SSE connections)
      let cleanedUp = false;
      setTimeout(() => {
        req.on('close', () => {
          if (!cleanedUp) {
            cleanup();
          }
        });
      }, 3000);

      // Send to PTY
      try {
        await session.sendMessage(prompt);
      } catch (err: any) {
        res.write(`data: ${JSON.stringify({ type: 'error', content: err.message })}\n\n`);
        cleanup();
      }
    },
  );

  // ── Send command ──
  app.post<Record<string, string>, any, SendCommandRequest>(
    '/api/sessions/:id/command',
    (req, res) => {
      const session = manager.get(req.params.id);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const { command } = req.body;
      if (!command) {
        res.status(400).json({ error: 'Missing command' });
        return;
      }

      try {
        session.sendCommand(command);
        res.json({ ok: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    },
  );

  // ── Interrupt session (Escape key) ──
  app.post('/api/sessions/:id/interrupt', (req, res) => {
    const session = manager.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    try {
      session.interrupt();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Delete session ──
  app.delete('/api/sessions/:id', (req, res) => {
    if (manager.destroy(req.params.id)) {
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // ── Session history ──
  app.get('/api/sessions/:id/history', (req, res) => {
    const session = manager.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session.getHistory());
  });

  const server = createServer(app);
  let actualPort = startPort;

  // ── Port discovery endpoint (used by inject.js for Next.js and other setups) ──
  app.get('/__cc-port', (_req, res) => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : actualPort;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(String(port));
  });

  const MAX_PORT = startPort + 10;

  function tryListen(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      server.listen(port, () => {
        actualPort = port;
        console.log(`[cc-prompter] Sidecar running on http://localhost:${port}`);
        resolve(server);
      });
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && port < MAX_PORT) {
          console.log(`[cc-prompter] Port ${port} in use, trying ${port + 1}...`);
          tryListen(port + 1).then(resolve, reject);
        } else {
          reject(err);
        }
      });
    });
  }

  // Fire-and-forget listen (returns server immediately for API compat)
  tryListen(startPort).catch((err) => {
    console.error(`[cc-prompter] Failed to start sidecar:`, err.message);
  });

  // Graceful shutdown
  server.on('close', () => {
    manager.destroyAll();
  });

  return server;
}
