/**
 * CC Prompter — PTY Session
 *
 * 每个实例管理一个常驻的 claude CLI 进程（通过 node-pty）。
 *
 * 输出解析策略（双通道）：
 *   1. PTY 输出解析（主要）— 实时从 TUI 输出提取响应文本
 *   2. JSONL transcript（辅助）— 结构化事件，用于 tool_use 等
 *
 * 就绪检测：解析 PTY 输出中的提示符（"for shortcuts"、"/effort"）。
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const _metaUrl = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const require = createRequire(_metaUrl);
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { IPty } from 'node-pty-prebuilt-multiarch';
import type {
  SessionStatus,
  ChatMessage,
  ToolUseInfo,
  JsonlEvent,
  SseEvent,
} from './types.js';

// node-pty-prebuilt-multiarch uses CJS internally — must use require()
function loadPty(): typeof import('node-pty-prebuilt-multiarch') {
  return require('node-pty-prebuilt-multiarch');
}

// ── Helpers ─────────────────────────────────────────────

function resolveClaudeBin(cwd: string): string {
  const local = path.resolve(cwd, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  if (fs.existsSync(local)) return local;
  return 'claude';
}

function findClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/** Convert a cwd path to the Claude projects directory name */
function cwdToProjectDir(cwd: string): string {
  // /Users/ryan/mycode/AgentPlat/demo → -Users-ryan-mycode-AgentPlat-demo
  return '-' + cwd.replace(/^\//, '').replace(/\//g, '-');
}

/** Scan for the most recently modified .jsonl in a specific project dir */
function findRecentJsonl(cwd: string, afterMs: number): string | null {
  const projectsDir = findClaudeProjectsDir();
  const projectSubdir = cwdToProjectDir(cwd);
  const targetDir = path.join(projectsDir, projectSubdir);

  if (!fs.existsSync(targetDir)) return null;

  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.jsonl'));
  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const fp = path.join(targetDir, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.mtimeMs > afterMs) {
        if (!best || stat.mtimeMs > best.mtime) {
          best = { path: fp, mtime: stat.mtimeMs };
        }
      }
    } catch { continue; }
  }
  return best?.path || null;
}

function sessionIdFromJsonlPath(jsonPath: string): string | null {
  const base = path.basename(jsonPath, '.jsonl');
  const match = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  return match ? match[0] : null;
}

/** Strip ANSI escape sequences for analysis */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\].*?\x07/g, '')
    .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\r/g, '');
}

// ── PtySession ──────────────────────────────────────────

export class PtySession extends EventEmitter {
  readonly id: string;
  readonly cwd: string;
  status: SessionStatus = 'spawning';

  private pty: IPty | null = null;
  private jsonlPath: string | null = null;
  private sessionId: string | null = null;
  private history: ChatMessage[] = [];
  private jsonlOffset = 0;
  private jsonlWatcher: fs.FSWatcher | null = null;
  private spawnTime: number;
  private messageSentAt = 0;
  private title = 'New Session';
  private lastActivityAt: number;
  private killed = false;
  private ptyBuffer = '';         // accumulated for prompt detection
  private jsonlDiscoverPromise: Promise<void> | null = null;

  // ── PTY streaming fields ──
  private busyBuffer = '';        // accumulated during busy state
  private lastUserContent = '';   // last user message text
  private ptyResponseText = '';   // extracted response text so far
  private ptyResponseEmitted = 0; // chars already emitted
  private usedJsonl = false;      // JSONL events received this turn
  private ptyDoneEmitted = false;
  private lastProgress = '';      // last emitted progress text
  private interrupted = false;    // set when user sends interrupt

  constructor(id: string, cwd: string) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.spawnTime = Date.now();
    this.lastActivityAt = this.spawnTime;
  }

  /** Spawn the claude process via PTY */
  async spawn(): Promise<void> {
    const ptyModule = loadPty();
    const bin = resolveClaudeBin(this.cwd);

    console.log(`[pty-session ${this.id}] spawning: ${bin} cwd: ${this.cwd}`);

    this.pty = ptyModule.spawn(bin, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: this.cwd,
      env: { ...process.env } as Record<string, string>,
    });

    console.log(`[pty-session ${this.id}] PID: ${this.pty.pid}`);

    // Watch PTY output
    this.pty.onData((data: string) => {
      const clean = stripAnsi(data);
      this.ptyBuffer += clean;

      this.detectPrompt();

      // Parse for streaming response when busy and JSONL not active
      if (this.status === 'busy' && !this.usedJsonl) {
        this.busyBuffer += clean;
        this.parseBusyOutput();
      }
    });

    this.pty.onExit(({ exitCode }) => {
      console.log(`[pty-session ${this.id}] exited with code: ${exitCode}`);
      this.status = 'exited';
      this.lastActivityAt = Date.now();
      this.emit('exit', exitCode);
      this.cleanup();
    });
  }

  // ── Prompt Detection ──────────────────────────────────

  private detectPrompt(): void {
    const indicators = [
      /for shortcuts/,
      /\/effort/,
      /refactor/,
    ];

    for (const re of indicators) {
      if (re.test(this.ptyBuffer) && this.status === 'spawning') {
        console.log(`[pty-session ${this.id}] detected prompt → ready`);
        this.status = 'ready';
        this.emit('ready');
        return;
      }
    }

    // After interrupt, detect prompt returning to finish the stream
    if (this.interrupted && this.status === 'busy') {
      for (const re of indicators) {
        if (re.test(this.ptyBuffer)) {
          console.log(`[pty-session ${this.id}] detected prompt after interrupt → done`);
          this.interrupted = false;
          this.ptyDoneEmitted = true;
          this.status = 'ready';
          this.lastActivityAt = Date.now();
          this.emit('message', { type: 'done', durationMs: 0 } as SseEvent);
          return;
        }
      }
    }
  }

  private async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.status === 'ready') return;
    if (this.status === 'exited') throw new Error('Session exited');

    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (this.status === 'ready') {
          clearInterval(timer);
          resolve();
        } else if (this.status === 'exited') {
          clearInterval(timer);
          reject(new Error('Session exited while waiting'));
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('Timeout waiting for session to be ready'));
        }
      }, 100);
    });
  }

  // ── Send Message ──────────────────────────────────────

  async sendMessage(content: string): Promise<void> {
    if (!this.pty || this.status === 'exited') {
      throw new Error('Session not active');
    }
    if (this.status === 'busy') {
      throw new Error('Session busy');
    }

    // Wait for claude prompt to be ready
    if (this.status !== 'ready') {
      console.log(`[pty-session ${this.id}] waiting for prompt before sending message...`);
      await this.waitUntilReady();
    }

    await new Promise(r => setTimeout(r, 200));

    this.status = 'busy';
    this.lastActivityAt = Date.now();

    // Reset streaming state for this turn
    this.busyBuffer = '';
    this.lastUserContent = content;
    this.ptyResponseText = '';
    this.ptyResponseEmitted = 0;
    this.usedJsonl = false;
    this.ptyDoneEmitted = false;
    this.lastProgress = '';
    this.interrupted = false;

    // JSONL discovery in background
    if (!this.messageSentAt) {
      this.messageSentAt = Date.now();
      console.log(`[pty-session ${this.id}] first message, starting JSONL discovery`);
      this.jsonlDiscoverPromise = this.discoverJsonl();
    }

    console.log(`[pty-session ${this.id}] writing to PTY: ${JSON.stringify(content.slice(0, 100))}`);

    // Write content + double Enter for reliable submission
    this.pty.write(content + '\r');
    await new Promise(r => setTimeout(r, 150));
    this.pty.write('\r');
  }

  /** Send a slash command to the PTY */
  sendCommand(command: string): void {
    if (!this.pty || this.status === 'exited') {
      throw new Error('Session not active');
    }

    this.pty.write(command + '\r');

    if (command === '/new') {
      this.history = [];
      this.title = 'New Session';
      this.jsonlPath = null;
      this.jsonlOffset = 0;
      this.jsonlWatcher?.close();
      this.jsonlWatcher = null;
      this.sessionId = null;
      this.messageSentAt = 0;
      this.status = 'ready';
      this.ptyBuffer = '';
    }
  }

  /** Send Escape to PTY to interrupt current generation */
  interrupt(): void {
    if (!this.pty || this.status === 'exited') {
      throw new Error('Session not active');
    }
    if (this.status !== 'busy') return;
    this.interrupted = true;
    this.pty.write('\x1b');

    // Safety timeout: if prompt detection fails, force finish after 5s
    setTimeout(() => {
      if (this.interrupted && this.status === 'busy') {
        console.log(`[pty-session ${this.id}] interrupt timeout → force done`);
        this.interrupted = false;
        this.ptyDoneEmitted = true;
        this.status = 'ready';
        this.lastActivityAt = Date.now();
        this.emit('message', { type: 'done', durationMs: 0 } as SseEvent);
      }
    }, 5000);
  }

  // ── PTY Output Parsing (streaming fallback) ───────────

  /**
   * Parse PTY output during busy state to extract streaming response.
   *
   * Claude Code TUI patterns:
   *   - Spinner frames: ✳ ✶ ✻ ✽ ✢ · (ignore — just animation)
   *   - Response text:  ⏺<text>  or  ●<text>
   *   - Tool use:       ⚡<tool_name> or ✢ editing <file>
   *   - Completion:     "Brewed for Xs" (ONLY reliable indicator)
   *   - ⚠️  ❯ appears in input echo too — NOT a completion signal!
   *   - Timing:         (Xs · ↓NNN tokens)
   */
  private parseBusyOutput(): void {
    // ── 0. Extract progress for UI feedback ──
    this.emitProgress();

    // ── 1. Try to extract response text ──
    const respMatch = this.busyBuffer.match(/⏺([一-鿿　-〿＀-￯].+)/s);
    if (respMatch) {
      let raw = respMatch[1];
      raw = raw.replace(/[✳✶✻✽✢·].*$/s, '').trim();
      raw = raw.replace(/─{3,}.*$/s, '').trim();
      raw = raw.replace(/Brewed for.*$/s, '').trim();
      raw = raw.replace(/Sautéed for.*$/s, '').trim();
      raw = raw.replace(/esctointerrupt.*$/s, '').trim();

      if (raw.length > this.ptyResponseText.length) {
        this.ptyResponseText = raw;
        this.emitIncrementalText();
      }
    }

    // ── 2. Extract tool calls (Update/Read/Edit) ──
    const toolCallMatch = this.busyBuffer.match(/⏺(Update|Read|Edit|Write|Bash)\(([^)]+)\)/);
    if (toolCallMatch) {
      const toolName = toolCallMatch[1];
      const filePath = toolCallMatch[2];
      this.emit('message', {
        type: 'assistant_tool',
        tool: { name: toolName, input: { file: filePath } },
      } as SseEvent);
    }

    // ── 3. Detect completion ──
    if (!this.ptyDoneEmitted && /(?:Brewed|Sautéed) for/.test(this.busyBuffer)) {
      this.ptyDoneEmitted = true;

      // Final flush: emit any remaining text
      if (this.ptyResponseText.length > this.ptyResponseEmitted) {
        this.emitIncrementalText();
      }

      // If no response was emitted at all, try one more aggressive extraction
      if (this.ptyResponseEmitted === 0) {
        const finalMatch = this.busyBuffer.match(/⏺(.+)/s);
        if (finalMatch) {
          let text = finalMatch[1]
            .replace(/[✳✶✻✽✢·].*$/s, '')
            .replace(/─{3,}.*$/s, '')
            .replace(/Brewed for.*$/s, '')
            .replace(/esctointerrupt.*$/s, '')
            .trim();
          if (text.length > 0) {
            this.emitUserIfNeeded();
            this.history.push({
              role: 'assistant', content: text, timestamp: Date.now(),
            });
            this.emit('message', { type: 'assistant_text', content: text } as SseEvent);
            this.ptyResponseEmitted = text.length;
          }
        }
      }

      // Extract duration
      const durMatch = this.busyBuffer.match(/Brewed for (\d+)s/);
      const durationMs = durMatch ? parseInt(durMatch[1]) * 1000 : 0;

      // Update title from first user message
      if (this.history.filter(m => m.role === 'user').length <= 1 && this.lastUserContent) {
        this.title = this.lastUserContent.slice(0, 60);
        this.emit('title-change', this.title);
      }

      this.status = 'ready';
      this.lastActivityAt = Date.now();
      this.emit('message', { type: 'done', durationMs } as SseEvent);
    }
  }

  /** Emit only the newly arrived characters (incremental streaming) */
  private emitIncrementalText(): void {
    const newText = this.ptyResponseText.slice(this.ptyResponseEmitted);
    if (newText.length === 0) return;

    // First chunk → emit user message + start assistant
    if (this.ptyResponseEmitted === 0) {
      this.emitUserIfNeeded();
    }

    this.ptyResponseEmitted = this.ptyResponseText.length;
    this.emit('message', { type: 'assistant_text', content: newText } as SseEvent);
  }

  /**
   * Extract and emit progress updates from busyBuffer.
   *
   * Parses PTY output for Claude Code's progress indicators:
   *   - "Thinking for Xs, reading N files"
   *   - "Thought for Xs, read N files"
   *   - "Crafting… (Xs · ↓NN tokens)"
   *   - "Update(file)" / "Read(file)"
   *   - "⎿ Removed N lines"
   *   - "(Xs · ↓NN tokens)" timing
   */
  private emitProgress(): void {
    // Strip spinner chars + noise, collapse whitespace
    const text = this.busyBuffer
      .replace(/[✳✶✻✽✢·][a-zA-Z0-9…]{0,4}/g, '')
      .replace(/\s+/g, ' ');

    // Ordered by specificity — last match wins (most recent progress)
    const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
      // Thinking phase
      [/Thinking for (\d+s)[^─]{0,60}(reading \d+ file[^)]*)?/, (m) => {
        return m[0].replace(/\s+/g, ' ').replace(/\s*\(ctrl.*$/, '').trim();
      }],
      // Thought completed
      [/Thought for (\d+s)[^─]{0,60}(read \d+ file[^)]*)?/, (m) => {
        return m[0].replace(/\s+/g, ' ').replace(/\s*\(ctrl.*$/, '').trim();
      }],
      // Tool call: Update(file) / Read(file)
      [/⏺(Update|Read|Edit|Write|Bash)\(([^)]+)\)/, (m) => {
        return m[1] + ': ' + m[2].split('/').slice(-2).join('/');
      }],
      // Tool result: ⎿ Removed N lines
      [/⎿\s*(Removed|Added|Modified|Created)\s+(\d+)\s+(lines?)/, (m) => {
        return m[1] + ' ' + m[2] + ' ' + m[3];
      }],
      // Crafting with timing
      [/Crafting[^─]{0,30}\(\d+s[^)]*\)/, (m) => {
        return m[0].replace(/\s+/g, ' ').trim();
      }],
      // Simple timing: (5s · ↓9 tokens)
      [/\((\d+s)\s*·\s*[↓↑]\s*(\d+)\s*tokens?\)/, (m) => {
        return m[1] + ' · ' + m[2] + ' tokens';
      }],
    ];

    // Find the last matching pattern
    let progress = '';
    for (const [re, fn] of patterns) {
      const m = text.match(re);
      if (m) progress = fn(m);
    }

    // Emit only if changed
    if (progress && progress !== this.lastProgress) {
      this.lastProgress = progress;
      this.emit('message', { type: 'progress', content: progress } as SseEvent);
    }
  }

  /** Emit user message event (only if not already emitted this turn) */
  private emitUserIfNeeded(): void {
    if (!this.lastUserContent) return;
    // Check if user message already in history
    const already = this.history.some(
      m => m.role === 'user' && m.content === this.lastUserContent,
    );
    if (!already) {
      this.history.push({
        role: 'user',
        content: this.lastUserContent,
        timestamp: Date.now(),
      });
      this.emit('message', { type: 'user', content: this.lastUserContent } as SseEvent);
    }
  }

  // ── JSONL Discovery & Parsing (structured events) ─────

  private async discoverJsonl(): Promise<void> {
    const searchStart = this.messageSentAt - 2000;

    // Poll for up to 60 seconds (120 × 500ms)
    for (let i = 0; i < 120; i++) {
      if (this.killed) return;
      const jsonl = findRecentJsonl(this.cwd, searchStart);
      if (jsonl) {
        this.jsonlPath = jsonl;
        this.sessionId = sessionIdFromJsonlPath(jsonl) || null;
        console.log(`[pty-session ${this.id}] found JSONL: ${jsonl} (session: ${this.sessionId})`);
        this.startTailingJsonl();
        return;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    console.warn(`[pty-session ${this.id}] JSONL not found after 60s — using PTY output parsing`);
  }

  private startTailingJsonl(): void {
    if (!this.jsonlPath) return;

    this.readNewJsonlLines();

    try {
      this.jsonlWatcher = fs.watch(
        path.dirname(this.jsonlPath),
        (eventType, filename) => {
          if (filename === path.basename(this.jsonlPath!)) {
            this.readNewJsonlLines();
          }
        },
      );
    } catch (err) {
      console.warn(`[pty-session ${this.id}] fs.watch failed:`, err);
    }
  }

  private readNewJsonlLines(): void {
    if (!this.jsonlPath) return;

    try {
      const stat = fs.statSync(this.jsonlPath);
      if (stat.size <= this.jsonlOffset) return;

      const fd = fs.openSync(this.jsonlPath, 'r');
      const buf = Buffer.alloc(stat.size - this.jsonlOffset);
      fs.readSync(fd, buf, 0, buf.length, this.jsonlOffset);
      fs.closeSync(fd);
      this.jsonlOffset = stat.size;

      const text = buf.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt: JsonlEvent = JSON.parse(trimmed);
          this.processJsonlEvent(evt);
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file might be temporarily unavailable
    }
  }

  /** Process a JSONL event — marks usedJsonl to disable PTY parsing */
  private processJsonlEvent(evt: JsonlEvent): void {
    // Once JSONL events arrive, disable PTY output parsing
    this.usedJsonl = true;

    if (!this.sessionId && evt.sessionId) {
      this.sessionId = evt.sessionId;
    }

    switch (evt.type) {
      case 'user': {
        const text = typeof evt.message?.content === 'string'
          ? evt.message.content
          : Array.isArray(evt.message?.content)
            ? evt.message.content
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n')
            : '';
        this.history.push({
          role: 'user',
          content: text,
          timestamp: evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now(),
        });
        this.lastActivityAt = Date.now();
        this.emit('message', { type: 'user', content: text } as SseEvent);
        if (this.history.filter(m => m.role === 'user').length === 1 && text) {
          this.title = text.slice(0, 60);
          this.emit('title-change', this.title);
        }
        break;
      }
      case 'assistant': {
        const content = evt.message?.content;
        if (!Array.isArray(content)) break;

        const texts = content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('\n')
          .trim();

        const tools: ToolUseInfo[] = content
          .filter((c: any) => c.type === 'tool_use')
          .map((c: any) => ({
            name: c.name,
            input: c.input || {},
          }));

        if (texts || tools.length) {
          this.history.push({
            role: 'assistant',
            content: texts,
            toolUse: tools.length ? tools : undefined,
            timestamp: evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now(),
          });
        }

        if (texts) {
          this.emit('message', { type: 'assistant_text', content: texts } as SseEvent);
        }
        for (const t of tools) {
          this.emit('message', { type: 'assistant_tool', tool: t } as SseEvent);
        }
        break;
      }
      case 'system': {
        if (evt.subtype === 'tool_result') {
          const lastAssistant = [...this.history].reverse().find(m => m.role === 'assistant' && m.toolUse?.length);
          if (lastAssistant?.toolUse?.length) {
            const lastTool = lastAssistant.toolUse[lastAssistant.toolUse.length - 1];
            const resultText = typeof evt.message?.content === 'string'
              ? evt.message.content : '';
            lastTool.result = resultText.slice(0, 500);
          }
          const resultContent = typeof evt.message?.content === 'string'
            ? evt.message.content
            : Array.isArray(evt.message?.content)
              ? evt.message.content.map((c: any) => c.text || '').join('')
              : '';
          this.emit('message', { type: 'system', content: resultContent.slice(0, 200) } as SseEvent);
        } else if (evt.subtype === 'turn_duration') {
          this.status = 'ready';
          this.lastActivityAt = Date.now();
          this.emit('message', { type: 'done', durationMs: evt.durationMs } as SseEvent);
        }
        break;
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────

  kill(): void {
    this.killed = true;
    this.cleanup();
    if (this.pty) {
      try { this.pty.kill(); } catch { /* already dead */ }
      this.pty = null;
    }
    this.status = 'exited';
  }

  private cleanup(): void {
    if (this.jsonlWatcher) {
      this.jsonlWatcher.close();
      this.jsonlWatcher = null;
    }
  }

  getInfo(): {
    id: string;
    title: string;
    status: SessionStatus;
    createdAt: number;
    lastActivityAt: number;
    messageCount: number;
    lastMessagePreview: string;
    sessionId: string | null;
  } {
    const lastMsg = this.history[this.history.length - 1];
    return {
      id: this.id,
      title: this.title,
      status: this.status,
      createdAt: this.spawnTime,
      lastActivityAt: this.lastActivityAt,
      messageCount: this.history.length,
      lastMessagePreview: lastMsg ? lastMsg.content.slice(0, 80) : '',
      sessionId: this.sessionId,
    };
  }

  getHistory(): ChatMessage[] {
    return [...this.history];
  }
}
