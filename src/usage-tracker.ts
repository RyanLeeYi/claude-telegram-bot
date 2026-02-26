/**
 * Claude Code usage tracker - reads local JSONL files
 * 
 * This module provides functionality to track Claude Code usage by reading
 * local session JSONL files instead of requiring Admin API access.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface UsageStats {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreation: number;
  totalCacheRead: number;
  sessionCount: number;
  dateRange: {
    start: Date;
    end: Date;
  };
  recentSessions: Array<{
    timestamp: Date;
    inputTokens: number;
    outputTokens: number;
  }>;
}

interface MessageEvent {
  type: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  timestamp?: string;
}

/**
 * Get Claude Code data directory path
 */
function getClaudeDataDir(): string {
  return join(homedir(), ".claude");
}

/**
 * Parse a JSONL file and extract usage statistics
 */
function parseSessionFile(filePath: string): {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  timestamp: Date | null;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let timestamp: Date | null = null;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line) as MessageEvent;

        // Extract timestamp from first event
        if (!timestamp && event.timestamp) {
          timestamp = new Date(event.timestamp);
        }

        // Extract usage data
        if (event.usage) {
          inputTokens += event.usage.input_tokens || 0;
          outputTokens += event.usage.output_tokens || 0;
          cacheCreation += event.usage.cache_creation_input_tokens || 0;
          cacheRead += event.usage.cache_read_input_tokens || 0;
        }
      } catch (parseError) {
        // Skip invalid JSON lines
        continue;
      }
    }
  } catch (error) {
    console.warn(`Failed to parse session file ${filePath}:`, error);
  }

  return { inputTokens, outputTokens, cacheCreation, cacheRead, timestamp };
}

/**
 * Get usage statistics from local Claude Code files
 * @param daysBack Number of days to look back (default: 7)
 */
export function getLocalUsageStats(daysBack: number = 7): UsageStats | null {
  const claudeDir = getClaudeDataDir();
  const projectsDir = join(claudeDir, "projects");

  if (!existsSync(projectsDir)) {
    console.warn("Claude Code projects directory not found:", projectsDir);
    return null;
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let sessionCount = 0;
  let oldestDate: Date | null = null;
  let newestDate: Date | null = null;
  const recentSessions: Array<{
    timestamp: Date;
    inputTokens: number;
    outputTokens: number;
  }> = [];

  try {
    // Iterate through all project directories
    const projectDirs = readdirSync(projectsDir);

    for (const projectDir of projectDirs) {
      const projectPath = join(projectsDir, projectDir);

      // Check if it's a directory
      try {
        const stat = require("fs").statSync(projectPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Read session files in project directory
      const sessionFiles = readdirSync(projectPath).filter((f) =>
        f.endsWith(".jsonl")
      );

      for (const sessionFile of sessionFiles) {
        const sessionPath = join(projectPath, sessionFile);
        const stats = parseSessionFile(sessionPath);

        // Skip sessions without timestamp or outside date range
        if (!stats.timestamp || stats.timestamp < cutoffDate) {
          continue;
        }

        // Update totals
        totalInputTokens += stats.inputTokens;
        totalOutputTokens += stats.outputTokens;
        totalCacheCreation += stats.cacheCreation;
        totalCacheRead += stats.cacheRead;
        sessionCount++;

        // Track date range
        if (!oldestDate || stats.timestamp < oldestDate) {
          oldestDate = stats.timestamp;
        }
        if (!newestDate || stats.timestamp > newestDate) {
          newestDate = stats.timestamp;
        }

        // Add to recent sessions if it has usage
        if (stats.inputTokens > 0 || stats.outputTokens > 0) {
          recentSessions.push({
            timestamp: stats.timestamp,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
          });
        }
      }
    }

    // Sort recent sessions by timestamp (newest first) and keep top 5
    recentSessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    recentSessions.splice(5);

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreation,
      totalCacheRead,
      sessionCount,
      dateRange: {
        start: oldestDate || cutoffDate,
        end: newestDate || new Date(),
      },
      recentSessions,
    };
  } catch (error) {
    console.error("Failed to read Claude Code usage data:", error);
    return null;
  }
}
