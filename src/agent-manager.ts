/**
 * Agent Manager for dual-agent system.
 *
 * Manages both Claude Code and GitHub Copilot sessions,
 * providing a unified interface for the bot.
 */

import { session as claudeSession } from "./session";
import { copilotSession } from "./copilot-session";
import type { AIProvider, StatusCallback } from "./types";
import type { Context } from "grammy";

export type AgentType = "claude" | "copilot";

/**
 * Manages multiple AI agents and provides unified access.
 */
class AgentManager {
  private currentAgent: AgentType = "claude";
  private userPreferences: Map<number, AgentType> = new Map();

  /**
   * Get the current active agent type for a user.
   */
  getCurrentAgent(userId?: number): AgentType {
    if (userId && this.userPreferences.has(userId)) {
      return this.userPreferences.get(userId)!;
    }
    return this.currentAgent;
  }

  /**
   * Set the preferred agent for a user.
   */
  setAgent(agentType: AgentType, userId?: number): void {
    if (userId) {
      this.userPreferences.set(userId, agentType);
      console.log(`User ${userId} switched to ${agentType}`);
    } else {
      this.currentAgent = agentType;
      console.log(`Global agent switched to ${agentType}`);
    }
  }

  /**
   * Get the active session based on current agent.
   */
  getSession(userId?: number): AIProvider {
    const agentType = this.getCurrentAgent(userId);
    return agentType === "claude" ? claudeSession : copilotSession;
  }

  /**
   * Get session info for status display.
   */
  getSessionInfo(userId?: number): {
    agent: AgentType;
    isActive: boolean;
    isRunning: boolean;
    lastActivity: Date | null;
    lastError: string | null;
    currentModel: string;
  } {
    const agentType = this.getCurrentAgent(userId);
    const session = this.getSession(userId);

    return {
      agent: agentType,
      isActive: session.isActive,
      isRunning: session.isRunning,
      lastActivity: session.lastActivity,
      lastError: session.lastError,
      currentModel: session.currentModel,
    };
  }

  /**
   * Send message to the current agent.
   */
  async sendMessage(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context
  ): Promise<string> {
    const session = this.getSession(userId);
    return session.sendMessageStreaming(
      message,
      username,
      userId,
      statusCallback,
      chatId,
      ctx
    );
  }

  /**
   * Stop current session.
   */
  async stop(userId?: number): Promise<"stopped" | "pending" | false> {
    const session = this.getSession(userId);
    return session.stop();
  }

  /**
   * Kill current session.
   */
  async kill(userId?: number): Promise<void> {
    const session = this.getSession(userId);
    return session.kill();
  }

  /**
   * Get agent display name with emoji.
   */
  getAgentDisplay(agentType: AgentType): string {
    return agentType === "claude" ? "🤖 Claude Code" : "🐙 GitHub Copilot";
  }

  /**
   * Get available agents list.
   */
  getAvailableAgents(): Array<{ type: AgentType; display: string }> {
    return [
      { type: "claude", display: this.getAgentDisplay("claude") },
      { type: "copilot", display: this.getAgentDisplay("copilot") },
    ];
  }
}

// Global agent manager instance
export const agentManager = new AgentManager();
