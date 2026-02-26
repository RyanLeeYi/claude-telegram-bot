/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { session } from "../session";
import { agentManager } from "../agent-manager";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";
import { accountPool } from "../account-pool";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = agentManager.getSession(userId).isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `Status: ${status}\n` +
      `Working directory: <code>${workDir}</code>\n\n` +
      `<b>Commands:</b>\n` +
      `/new - Start fresh session\n` +
      `/stop - Stop current query\n` +
      `/status - Show detailed status\n` +
      `/resume - Resume last session\n` +
      `/retry - Retry last message\n` +
      `/model - Switch Claude model\n` +
      `/agent - Switch AI agent (Claude/Copilot)\n` +
      `/account - Show account pool status\n` +
      `/restart - Restart the bot\n\n` +
      `<b>Tips:</b>\n` +
      `• Prefix with <code>!</code> to interrupt current query\n` +
      `• Use "think" keyword for extended reasoning\n` +
      `• Send photos, voice, or documents`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const activeSession = agentManager.getSession(userId);

  // Stop any running query
  if (activeSession.isRunning) {
    const result = await activeSession.stop();
    if (result) {
      await Bun.sleep(100);
      activeSession.clearStopRequested();
    }
  }

  // Clear session
  await activeSession.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const activeSession = agentManager.getSession(userId);

  if (activeSession.isRunning) {
    const result = await activeSession.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      activeSession.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const agentType = agentManager.getCurrentAgent(userId);
  const activeSession = agentManager.getSession(userId);
  // Cast to any for fields not in AIProvider but present on both session classes
  const sessionAny = activeSession as any;

  const lines: string[] = ["📊 <b>Bot Status</b>\n"];
  lines.push(`🤖 Agent: ${agentManager.getAgentDisplay(agentType)}\n`);

  // Session status
  if (activeSession.isActive) {
    // sessionId is Claude-specific
    const sessionIdStr = agentType === "claude" && session.sessionId
      ? ` (${session.sessionId.slice(0, 8)}...)`
      : "";
    lines.push(`✅ Session: Active${sessionIdStr}`);
  } else {
    lines.push("⚪ Session: None");
  }

  // Query status
  if (activeSession.isRunning) {
    const elapsed = sessionAny.queryStarted
      ? Math.floor((Date.now() - sessionAny.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`🔄 Query: Running (${elapsed}s)`);
    if (sessionAny.currentTool) {
      lines.push(`   └─ ${sessionAny.currentTool}`);
    }
  } else {
    lines.push("⚪ Query: Idle");
    if (sessionAny.lastTool) {
      lines.push(`   └─ Last: ${sessionAny.lastTool}`);
    }
  }

  // Last activity
  if (activeSession.lastActivity) {
    const ago = Math.floor(
      (Date.now() - activeSession.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏱️ Last activity: ${ago}s ago`);
  }

  // Usage stats
  if (activeSession.lastUsage) {
    const usage = activeSession.lastUsage;
    lines.push(
      `\n📈 Last query usage:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // Error status
  if (activeSession.lastError) {
    const ago = sessionAny.lastErrorTime
      ? Math.floor((Date.now() - sessionAny.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(`\n⚠️ Last error (${ago}s ago):`, `   ${activeSession.lastError}`);
  }

  // Account pool status (Claude only, shown if multiple accounts configured)
  if (agentType === "claude" && accountPool.accountCount() > 1) {
    lines.push(`\n👤 Account: ${accountPool.getCurrentName()}`);
    lines.push(`   Pool: ${accountPool.getStatus()}`);
  }

  // Working directory
  lines.push(`\n📁 Working dir: <code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Sessione già attiva. Usa /new per iniziare da capo.");
    return;
  }

  // Get saved sessions
  const sessions = session.getSessionList();

  if (sessions.length === 0) {
    await ctx.reply("❌ Nessuna sessione salvata.");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "18/01 10:30"
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate title for button (max ~40 chars to fit)
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply("📋 <b>Sessioni salvate</b>\n\nSeleziona una sessione da riprendere:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const activeSession = agentManager.getSession(userId);

  // Check if there's a message to retry
  if (!activeSession.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (activeSession.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = activeSession.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}

/**
 * /model - Show supported models and let user pick one.
 */
export async function handleModel(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const loadingMsg = await ctx.reply("Fetching supported models...");

  let models;
  try {
    models = await session.getSupportedModels();
  } catch (error) {
    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      `Failed to fetch models: ${String(error).slice(0, 100)}`
    );
    return;
  }

  if (!models || models.length === 0) {
    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      "No models available."
    );
    return;
  }

  // Build inline keyboard — one button per model
  const buttons = models.map((m) => {
    const isCurrent = m.value === session.currentModel;
    const label = isCurrent
      ? `* ${m.displayName} — ${m.description}`
      : `${m.displayName} — ${m.description}`;
    return [{ text: label, callback_data: `model:${m.value}` }];
  });

  await ctx.api.editMessageText(
    loadingMsg.chat.id,
    loadingMsg.message_id,
    `Current model: <b>${session.currentModel}</b>\n\nSelect a model:`,
    {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

/**
 * /account - Show account pool details.
 */
export async function handleAccount(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const count = accountPool.accountCount();

  if (count === 0) {
    await ctx.reply(
      "👤 <b>Account Pool</b>\n\nNo CCS accounts configured.\nRunning with default Claude account.",
      { parse_mode: "HTML" }
    );
    return;
  }

  const now = Date.now();
  const lines: string[] = [`👤 <b>Account Pool</b> (${count} accounts)\n`];

  for (let i = 0; i < accountPool.accounts.length; i++) {
    const acct = accountPool.accounts[i]!;
    const isCurrent = i === accountPool.currentIndex;
    const marker = isCurrent ? "▶" : "  ";

    if (acct.rateLimitedUntil && acct.rateLimitedUntil > now) {
      const secsLeft = Math.ceil((acct.rateLimitedUntil - now) / 1000);
      const minsLeft = Math.floor(secsLeft / 60);
      const cooldown =
        minsLeft > 0 ? `${minsLeft}m ${secsLeft % 60}s` : `${secsLeft}s`;
      lines.push(`${marker} <code>${acct.name}</code> — ⏳ limited (${cooldown} left)`);
    } else {
      lines.push(`${marker} <code>${acct.name}</code> — ✅ available`);
    }
  }

  lines.push(`\nCurrent: <b>${accountPool.getCurrentName()}</b>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}


/**
 * /usage - Show Claude Code account usage statistics.
 * 
 * Priority:
 * 1. Try local JSONL file reading (no API key needed)
 * 2. Fallback to Admin API if local reading fails
 */
export async function handleUsage(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const loadingMsg = await ctx.reply("📊 正在查詢使用量資訊...");

  try {
    // First, try to read from local Claude Code files
    const { getLocalUsageStats } = await import("../usage-tracker");
    const localStats = getLocalUsageStats(7); // Last 7 days

    if (localStats) {
      // Successfully read local data
      const lines: string[] = [
        "📊 <b>Claude Code 使用量統計</b>",
        "📁 來源：本地檔案\n",
        "📅 期間：" + localStats.dateRange.start.toLocaleDateString('zh-TW') + " 至 " + localStats.dateRange.end.toLocaleDateString('zh-TW'),
        "🗂️ 對話數：" + localStats.sessionCount + " 個\n",
        "📥 輸入 Token：" + localStats.totalInputTokens.toLocaleString(),
        "📤 輸出 Token：" + localStats.totalOutputTokens.toLocaleString(),
      ];

      if (localStats.totalCacheCreation > 0) {
        lines.push("💾 Cache 建立：" + localStats.totalCacheCreation.toLocaleString());
      }

      if (localStats.totalCacheRead > 0) {
        lines.push("📖 Cache 讀取：" + localStats.totalCacheRead.toLocaleString());
      }

      const totalTokens = localStats.totalInputTokens + localStats.totalOutputTokens + 
                          localStats.totalCacheCreation + localStats.totalCacheRead;
      lines.push("\n🔢 總計：" + totalTokens.toLocaleString() + " tokens");

      // Show recent sessions
      if (localStats.recentSessions.length > 0) {
        lines.push("\n📈 <b>最近對話</b>");
        for (let i = 0; i < Math.min(3, localStats.recentSessions.length); i++) {
          const sess = localStats.recentSessions[i];
          if (!sess) continue;
          const date = sess.timestamp.toLocaleString('zh-TW', { 
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
          });
          lines.push("   " + date + " - 輸入: " + sess.inputTokens.toLocaleString() + " / 輸出: " + sess.outputTokens.toLocaleString());
        }
      }

      // Show current session usage if available
      if (session.lastUsage) {
        const lastUsage = session.lastUsage;
        lines.push(
          "\n💬 <b>當前對話最近一次查詢</b>",
          "   輸入：" + (lastUsage.input_tokens?.toLocaleString() || '?') + " tokens",
          "   輸出：" + (lastUsage.output_tokens?.toLocaleString() || '?') + " tokens"
        );
        if (lastUsage.cache_read_input_tokens) {
          lines.push("   Cache 讀取：" + lastUsage.cache_read_input_tokens.toLocaleString());
        }
      }

      await ctx.api.editMessageText(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        lines.join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    // If local reading failed, try Admin API
    const adminApiKey = process.env.ANTHROPIC_ADMIN_API_KEY;

    if (!adminApiKey) {
      await ctx.api.editMessageText(
        loadingMsg.chat.id,
        loadingMsg.message_id,
        "❌ <b>無法查詢使用量</b>\n\n" +
        "本地檔案讀取失敗，且未設定 Admin API Key。\n\n" +
        "• 確認 Claude Code 資料目錄存在 (~/.claude/projects/)\n" +
        "• 或設定 ANTHROPIC_ADMIN_API_KEY 環境變數\n\n" +
        "詳情請到 <a href='https://console.anthropic.com'>Anthropic Console</a>",
        { parse_mode: "HTML" }
      );
      return;
    }

    // Fallback to Admin API
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    const response = await fetch(
      "https://api.anthropic.com/v1/organizations/usage_report/messages?start_date=" + startDateStr + "&end_date=" + endDateStr + "&time_bucket=1d",
      {
        method: 'GET',
        headers: {
          'x-api-key': adminApiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Usage API error:', response.status, errorText);

      if (response.status === 401 || response.status === 403) {
        await ctx.api.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          "❌ <b>驗證失敗</b>\n\nAdmin API Key 無效或權限不足。\n請確認 Key 正確且具有管理員權限。",
          { parse_mode: "HTML" }
        );
      } else {
        await ctx.api.editMessageText(
          loadingMsg.chat.id,
          loadingMsg.message_id,
          "❌ <b>查詢失敗</b>\n\nAPI 錯誤: " + response.status,
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    const usageData = await response.json() as {
      data: Array<{
        start_time: string;
        end_time: string;
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      }>;
    };

    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheCreation = 0;
    let totalCacheRead = 0;

    for (const day of usageData.data) {
      totalInput += day.input_tokens || 0;
      totalOutput += day.output_tokens || 0;
      totalCacheCreation += day.cache_creation_input_tokens || 0;
      totalCacheRead += day.cache_read_input_tokens || 0;
    }

    const lines: string[] = [
      "📊 <b>Claude Code 使用量統計</b>",
      "🔑 來源：Admin API\n",
      "📅 期間：" + startDateStr + " 至 " + endDateStr + "\n",
      "📥 輸入 Token：" + totalInput.toLocaleString(),
      "📤 輸出 Token：" + totalOutput.toLocaleString(),
    ];

    if (totalCacheCreation > 0) {
      lines.push("💾 Cache 建立：" + totalCacheCreation.toLocaleString());
    }

    if (totalCacheRead > 0) {
      lines.push("📖 Cache 讀取：" + totalCacheRead.toLocaleString());
    }

    const totalTokens = totalInput + totalOutput + totalCacheCreation + totalCacheRead;
    lines.push("\n🔢 總計：" + totalTokens.toLocaleString() + " tokens");

    if (session.lastUsage) {
      const lastUsage = session.lastUsage;
      lines.push(
        "\n📈 <b>最近一次查詢</b>",
        "   輸入：" + (lastUsage.input_tokens?.toLocaleString() || '?') + " tokens",
        "   輸出：" + (lastUsage.output_tokens?.toLocaleString() || '?') + " tokens"
      );
      if (lastUsage.cache_read_input_tokens) {
        lines.push("   Cache 讀取：" + lastUsage.cache_read_input_tokens.toLocaleString());
      }
    }

    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      lines.join("\n"),
      { parse_mode: "HTML" }
    );

  } catch (error) {
    console.error('Usage command error:', error);
    await ctx.api.editMessageText(
      loadingMsg.chat.id,
      loadingMsg.message_id,
      "❌ <b>發生錯誤</b>\n\n" + String(error),
      { parse_mode: "HTML" }
    );
  }
}

/**
 * /agent - Switch between Claude and Copilot agents.
 */
export async function handleAgent(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Import here to avoid circular dependencies
  const { agentManager } = await import("../agent-manager");

  // Get current agent
  const currentAgent = agentManager.getCurrentAgent(userId);
  const agents = agentManager.getAvailableAgents();

  // Build inline keyboard
  const keyboard = agents.map((agent) => {
    const marker = agent.type === currentAgent ? "✅" : "⚪";
    return [
      {
        text: `${marker} ${agent.display}`,
        callback_data: `agent:${agent.type}`,
      },
    ];
  });

  await ctx.reply(
    "🤖 <b>選擇 AI Agent</b>\n\n" +
      "目前使用：" +
      agentManager.getAgentDisplay(currentAgent) +
      "\n\n" +
      "點擊下方按鈕切換：",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: keyboard,
      },
    }
  );
}
