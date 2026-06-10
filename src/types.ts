/**
 * CC Prompter — Shared Types
 */

/** Source info from code-inspector event */
export interface SourceInfo {
  name: string;
  path: string;
  line: number;
  column: number;
}

/** PTY session status */
export type SessionStatus = 'spawning' | 'ready' | 'busy' | 'exited';

/** A single chat message in history */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolUse?: ToolUseInfo[];
  timestamp: number;
}

export interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

/** Session metadata exposed to API */
export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  lastMessagePreview: string;
}

/** API request: create session */
export interface CreateSessionRequest {
  cwd?: string;
}

/** API request: send message */
export interface SendMessageRequest {
  content: string;
  sourceInfo?: SourceInfo & { elementInfo?: string };
}

/** API request: send command */
export interface SendCommandRequest {
  command: string; // /new, /compact, /clear, etc.
}

/** JSONL event types (simplified) */
export interface JsonlEvent {
  type: string;
  subtype?: string;
  sessionId?: string;
  message?: {
    role: string;
    content?: any;
    model?: string;
  };
  durationMs?: number;
  timestamp?: string;
}

/** SSE event sent to client */
export interface SseEvent {
  type: 'session_ready' | 'user' | 'assistant_text' | 'assistant_tool' | 'system' | 'done' | 'error' | 'progress';
  content?: string;
  tool?: ToolUseInfo;
  sessionId?: string;
  durationMs?: number;
  cost?: number;
}
