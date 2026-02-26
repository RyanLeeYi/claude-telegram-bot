/**
 * Shared TypeScript types for the Claude Telegram Bot.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";

// Status callback for streaming updates
export type StatusCallback = (
  type: "thinking" | "tool" | "text" | "segment_end" | "done",
  content: string,
  segmentId?: number
) => Promise<void>;

// Rate limit bucket for token bucket algorithm
export interface RateLimitBucket {
  tokens: number;
  lastUpdate: number;
}

// Session persistence
export interface SavedSession {
  session_id: string;
  saved_at: string;
  working_dir: string;
  title: string; // First message truncated (max ~50 chars)
}

export interface SessionHistory {
  sessions: SavedSession[];
}

// Token usage from Claude
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// MCP server configuration types
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

// Audit log event types
export type AuditEventType =
  | "message"
  | "auth"
  | "tool_use"
  | "error"
  | "rate_limit";

export interface AuditEvent {
  timestamp: string;
  event: AuditEventType;
  user_id: number;
  username?: string;
  [key: string]: unknown;
}

// Pending media group for buffering albums
export interface PendingMediaGroup {
  items: string[];
  ctx: Context;
  caption?: string;
  statusMsg?: Message;
  timeout: Timer;
}

// Bot context with optional message
export type BotContext = Context;

/**
 * Unified interface for AI provider sessions (Claude, Copilot, etc.)
 * Both ClaudeSession and CopilotSessionManager implement this.
 */
export interface AIProvider {
  sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string>;

  stop(): Promise<"stopped" | "pending" | false>;
  kill(): Promise<void>;

  startProcessing(): () => void;
  clearStopRequested(): void;
  consumeInterruptFlag(): boolean;
  markInterrupt(): void;

  readonly isActive: boolean;
  readonly isRunning: boolean;
  lastActivity: Date | null;
  lastError: string | null;
  lastUsage: TokenUsage | null;
  currentModel: string;
  lastMessage: string | null;
  conversationTitle: string | null;
}
