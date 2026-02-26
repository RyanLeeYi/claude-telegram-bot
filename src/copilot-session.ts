/**
 * Copilot session management for Claude Telegram Bot.
 *
 * Uses the @github/copilot-sdk to manage GitHub Copilot CLI sessions
 * with real streaming via JSON-RPC events.
 */

import {
  CopilotClient,
  CopilotSession as SdkSession,
  approveAll,
  type SessionEvent,
  type CopilotClientOptions,
} from "@github/copilot-sdk";
import type { Context } from "grammy";
import { WORKING_DIR, SAFETY_PROMPT, STREAMING_THROTTLE_MS } from "./config";
import type { AIProvider, StatusCallback, TokenUsage } from "./types";

/**
 * Manages GitHub Copilot CLI sessions using the Copilot SDK.
 */
class CopilotSessionManager implements AIProvider {
  private client: CopilotClient | null = null;
  private session: SdkSession | null = null;

  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;
  conversationTitle: string | null = null;
  currentModel: string = "claude-sonnet-4";

  private stopRequested = false;
  private _isProcessing = false;
  private interruptFlag = false;

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  get isActive(): boolean {
    return this.session !== null;
  }

  get isRunning(): boolean {
    return this._isProcessing;
  }

  /**
   * Initialize Copilot client if not already initialized.
   */
  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) return this.client;

    try {
      const options: CopilotClientOptions = {
        logLevel: "warning",
      };

      // Use explicit token if provided
      const githubToken =
        process.env.GITHUB_TOKEN || process.env.COPILOT_GITHUB_TOKEN;
      if (githubToken) {
        options.githubToken = githubToken;
      }

      this.client = new CopilotClient(options);
      await this.client.start();
      console.log("✅ Copilot client initialized");
      return this.client;
    } catch (error) {
      this.client = null;
      console.error("Failed to initialize Copilot client:", error);
      throw new Error(`Copilot initialization failed: ${error}`);
    }
  }

  /**
   * Create or reuse a Copilot session.
   */
  private async ensureSession(): Promise<SdkSession> {
    const client = await this.ensureClient();

    if (this.session) return this.session;

    this.session = await client.createSession({
      model: this.currentModel,
      workingDirectory: WORKING_DIR,
      streaming: true,
      systemMessage: {
        mode: "append",
        content: SAFETY_PROMPT,
      },
      onPermissionRequest: approveAll,
    });

    console.log(`✅ Copilot session created: ${this.session.sessionId.slice(0, 8)}...`);
    return this.session;
  }

  /**
   * Send a message to Copilot with streaming updates via callback.
   */
  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    const session = await this.ensureSession();
    const isNewSession = !this.lastActivity;

    // Inject current date/time at session start
    let messageToSend = message;
    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })}]\n\n`;
      messageToSend = datePrefix + message;
    }

    console.log(`${isNewSession ? "STARTING" : "CONTINUING"} Copilot session`);

    this._isProcessing = true;
    this.stopRequested = false;
    this.queryStarted = new Date();
    this.currentTool = null;

    let fullContent = "";
    let receivedDelta = false;
    // Track per-segment accumulated text, segment counter, and last UI update time.
    // lastUpdate prevents concurrent fire-and-forget callbacks from racing to create
    // multiple new messages (mirrors the source-level throttle in session.ts).
    const segment = { text: "", id: 0, lastUpdate: 0 };

    // Timeout to prevent infinite hanging (5 minutes)
    const TIMEOUT_MS = 5 * 60 * 1000;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeoutTimer);
        return true;
      };

      // Timeout guard
      const timeoutTimer = setTimeout(() => {
        if (!settle()) return;
        unsubAll();
        unsubIdle();
        unsubError();
        this._isProcessing = false;
        this.queryStarted = null;
        this.currentTool = null;
        console.error("Copilot session timed out after 5 minutes");
        reject(new Error("Copilot response timed out"));
      }, TIMEOUT_MS);

      // Subscribe to all session events for streaming
      const unsubAll = session.on((event: SessionEvent) => {
        try {
          console.log(`[Copilot event] ${event.type}`);
          this.handleEvent(event, statusCallback, {
            onTextDelta: (delta) => {
              fullContent += delta;
              receivedDelta = true;
            },
            hasReceivedDelta: () => receivedDelta,
          }, segment);
        } catch (err) {
          console.error("Error handling Copilot event:", err);
        }
      });

      // Listen for idle (response complete)
      const unsubIdle = session.on("session.idle", async () => {
        console.log("[Copilot] session.idle received");
        if (!settle()) return;
        unsubAll();
        unsubIdle();
        unsubError();

        this._isProcessing = false;
        this.queryStarted = null;
        this.currentTool = null;
        this.lastActivity = new Date();
        this.lastError = null;
        this.lastErrorTime = null;

        // Emit final segment with accumulated text (not fullContent which is total)
        if (segment.text) {
          await statusCallback("segment_end", segment.text, segment.id);
        }
        await statusCallback("done", "");

        resolve(fullContent || "No response from Copilot.");
      });

      // Listen for errors
      const unsubError = session.on("session.error", async (event) => {
        console.error("[Copilot] session.error received:", event.data);
        if (!settle()) return;
        unsubAll();
        unsubIdle();
        unsubError();

        const errMsg = event.data.message || "Unknown Copilot error";
        this._isProcessing = false;
        this.queryStarted = null;
        this.currentTool = null;
        this.lastError = errMsg.slice(0, 100);
        this.lastErrorTime = new Date();

        reject(new Error(errMsg));
      });

      // Send the message
      console.log("[Copilot] Sending message...");
      session.send({ prompt: messageToSend }).then((msgId) => {
        console.log(`[Copilot] Message sent, id: ${msgId}`);
      }).catch((err) => {
        console.error("[Copilot] send() failed:", err);
        if (!settle()) return;
        unsubAll();
        unsubIdle();
        unsubError();
        this._isProcessing = false;
        this.queryStarted = null;
        reject(err);
      });
    });
  }

  /**
   * Handle individual session events and route to statusCallback.
   * segment tracks accumulated text, segment id, and last UI update timestamp.
   * lastUpdate mirrors the source-level throttle in session.ts to prevent concurrent
   * fire-and-forget statusCallback calls from racing to create duplicate messages.
   */
  private handleEvent(
    event: SessionEvent,
    statusCallback: StatusCallback,
    hooks: { onTextDelta: (delta: string) => void; hasReceivedDelta: () => boolean },
    segment: { text: string; id: number; lastUpdate: number }
  ): void {
    switch (event.type) {
      case "assistant.message_delta": {
        const { deltaContent } = event.data;
        hooks.onTextDelta(deltaContent);
        segment.text += deltaContent;
        // Throttle streaming updates — mirrors session.ts source-level throttle.
        // Without this, rapid-fire deltas produce concurrent callbacks that all
        // see textMessages.has(segmentId) === false and each create a new message.
        const now = Date.now();
        if (now - segment.lastUpdate > STREAMING_THROTTLE_MS && segment.text.length > 20) {
          statusCallback("text", segment.text, segment.id).catch(() => {});
          segment.lastUpdate = now;
        }
        break;
      }

      case "assistant.message": {
        // Fallback: only use complete message if no streaming deltas were received
        if (!hooks.hasReceivedDelta()) {
          const { content } = event.data;
          if (content) {
            hooks.onTextDelta(content);
            segment.text += content;
            statusCallback("text", segment.text, segment.id).catch(() => {});
            segment.lastUpdate = Date.now();
          }
        }
        break;
      }

      case "tool.execution_start": {
        // Close current text segment before starting tool (aligns with session.ts)
        if (segment.text) {
          statusCallback("segment_end", segment.text, segment.id).catch(() => {});
          segment.id++;
          segment.text = "";
          segment.lastUpdate = 0;
        }
        this.currentTool = event.data.toolName;
        statusCallback("tool", `⚙️ ${event.data.toolName}`).catch(() => {});
        break;
      }

      case "tool.execution_complete": {
        this.lastTool = this.currentTool;
        this.currentTool = null;
        break;
      }

      case "assistant.usage": {
        this.lastUsage = {
          input_tokens: event.data.inputTokens ?? 0,
          output_tokens: event.data.outputTokens ?? 0,
          cache_read_input_tokens: event.data.cacheReadTokens ?? 0,
          cache_creation_input_tokens: event.data.cacheWriteTokens ?? 0,
        };
        break;
      }

      case "session.title_changed": {
        this.conversationTitle = event.data.title;
        break;
      }

      case "assistant.reasoning_delta": {
        statusCallback("thinking", event.data.deltaContent).catch(() => {});
        break;
      }
    }
  }

  /**
   * Stop the currently running query.
   */
  async stop(): Promise<"stopped" | "pending" | false> {
    if (this._isProcessing && this.session) {
      this.stopRequested = true;
      try {
        await this.session.abort();
        console.log("Copilot query aborted");
        return "stopped";
      } catch {
        return "pending";
      }
    }
    return false;
  }

  /**
   * Kill the current session (destroy session and clear state).
   */
  async kill(): Promise<void> {
    if (this.session) {
      try {
        await this.session.destroy();
      } catch (err) {
        console.debug("Error destroying Copilot session:", err);
      }
      this.session = null;
    }

    this.lastActivity = null;
    this.conversationTitle = null;
    this.lastMessage = null;
    this._isProcessing = false;

    console.log("Copilot session cleared");
  }

  /**
   * Mark processing as started.
   */
  startProcessing(): () => void {
    this._isProcessing = true;
    return () => {
      this._isProcessing = false;
    };
  }

  /**
   * Clear the stopRequested flag.
   */
  clearStopRequested(): void {
    this.stopRequested = false;
  }

  /**
   * Check and consume interrupt flag.
   */
  consumeInterruptFlag(): boolean {
    const was = this.interruptFlag;
    this.interruptFlag = false;
    return was;
  }

  /**
   * Mark interrupt.
   */
  markInterrupt(): void {
    this.interruptFlag = true;
    this.stopRequested = true;
  }

  /**
   * Gracefully shut down the Copilot client.
   */
  async shutdown(): Promise<void> {
    await this.kill();
    if (this.client) {
      try {
        await this.client.stop();
      } catch (err) {
        console.debug("Error stopping Copilot client:", err);
      }
      this.client = null;
    }
  }
}

// Global Copilot session instance
export const copilotSession = new CopilotSessionManager();
