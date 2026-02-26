/**
 * Account pool management for Claude Telegram Bot.
 *
 * Reads CCS account list and manages account rotation on rate limit.
 * Supports:
 *   - CLAUDE_ACCOUNTS env var (comma-separated, explicit list)
 *   - Auto-detect from ~/.ccs/config.yaml (accounts section)
 *   - Auto-detect from ~/.ccs/profiles.json (fallback)
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

interface Account {
  name: string;
  configDir: string;
  rateLimitedUntil: number | null;
}

/**
 * Sanitize account name to match CCS instance directory naming.
 * Mirrors CCS logic: name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

/**
 * Get the CCS home directory.
 * Respects CCS_DIR or CCS_HOME env var, defaults to ~/.ccs.
 */
function getCcsDir(): string {
  return (
    process.env.CCS_DIR ||
    process.env.CCS_HOME ||
    join(homedir(), ".ccs")
  );
}

/**
 * Load account names from CLAUDE_ACCOUNTS env var.
 */
function loadFromEnv(): string[] | null {
  const raw = process.env.CLAUDE_ACCOUNTS;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse YAML accounts section manually (minimal parser).
 *
 * Supports two formats:
 *
 * Map format (CCS unified config):
 *   accounts:
 *     acct1:
 *       created: ...
 *     acct2:
 *       created: ...
 *
 * List format (legacy):
 *   accounts:
 *     - name: acct1
 *     - name: acct2
 *
 * Returns array of account names, or null if not found.
 */
function parseYamlAccountNames(content: string): string[] | null {
  const names: string[] = [];
  const lines = content.split("\n");
  let inAccounts = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect `accounts:` top-level key
    if (/^accounts\s*:/.test(line)) {
      inAccounts = true;
      continue;
    }

    if (!inAccounts) continue;

    // End of accounts section: new top-level key (no leading whitespace, not blank, not comment)
    if (trimmed && !trimmed.startsWith("#") && !/^\s/.test(line)) {
      break;
    }

    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Get indentation level
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;

    // Map format: direct children of accounts (indent = 2), key ends with ":"
    // e.g. "  acct1:"
    if (indent === 2 && /^\s{2}[a-zA-Z0-9_-]+\s*:/.test(line)) {
      const nameMatch = line.match(/^\s{2}([a-zA-Z0-9_-]+)\s*:/);
      if (nameMatch) {
        names.push(nameMatch[1]!);
      }
      continue;
    }

    // List format: "  - name: acct1" or "  - acct1"
    if (trimmed.startsWith("-")) {
      const inlineNameMatch = trimmed.match(/^-\s+name\s*:\s*(.+)/);
      if (inlineNameMatch) {
        const name = inlineNameMatch[1]!.trim().replace(/^["']|["']$/g, "");
        if (name) names.push(name);
        continue;
      }
      const plainMatch = trimmed.match(/^-\s+([a-zA-Z0-9_-]+)\s*$/);
      if (plainMatch) {
        names.push(plainMatch[1]!);
      }
    }
  }

  return names.length > 0 ? names : null;
}

/**
 * Load account names from ~/.ccs/config.yaml.
 */
function loadFromConfigYaml(ccsDir: string): string[] | null {
  const configPath = join(ccsDir, "config.yaml");
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, "utf-8");
    return parseYamlAccountNames(content);
  } catch {
    return null;
  }
}

/**
 * Load account names from ~/.ccs/profiles.json.
 */
function loadFromProfilesJson(ccsDir: string): string[] | null {
  const profilesPath = join(ccsDir, "profiles.json");
  if (!existsSync(profilesPath)) return null;

  try {
    const content = readFileSync(profilesPath, "utf-8");
    const profiles = JSON.parse(content) as unknown;

    if (Array.isArray(profiles)) {
      return (profiles as Array<{ name?: string }>)
        .map((p) => p.name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
    }

    if (profiles && typeof profiles === "object") {
      return Object.keys(profiles as Record<string, unknown>);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build Account objects from names, checking that instance dirs exist.
 */
function buildAccounts(names: string[], ccsDir: string): Account[] {
  const accounts: Account[] = [];
  for (const name of names) {
    const sanitized = sanitizeName(name);
    const configDir = join(ccsDir, "instances", sanitized);
    if (existsSync(configDir)) {
      accounts.push({ name, configDir, rateLimitedUntil: null });
    } else {
      console.warn(
        `[AccountPool] Instance dir not found for "${name}": ${configDir} — skipping`
      );
    }
  }
  return accounts;
}

/**
 * Manages a pool of CCS accounts for automatic rotation on rate limit.
 */
class AccountPool {
  readonly accounts: Account[];
  private _currentIndex: number = 0;
  private readonly cooldownMs: number;

  constructor() {
    this.cooldownMs = parseInt(
      process.env.ACCOUNT_COOLDOWN_MS || "300000",
      10
    );

    const ccsDir = getCcsDir();
    const names =
      loadFromEnv() ||
      loadFromConfigYaml(ccsDir) ||
      loadFromProfilesJson(ccsDir) ||
      [];

    this.accounts = buildAccounts(names, ccsDir);

    if (this.accounts.length === 0) {
      console.log("[AccountPool] No CCS accounts found — using default env");
    } else {
      console.log(
        `[AccountPool] Loaded ${this.accounts.length} account(s): ${this.accounts.map((a) => a.name).join(", ")}`
      );
    }
  }

  get currentIndex(): number {
    return this._currentIndex;
  }

  /**
   * Get the current account (or undefined if pool is empty).
   */
  private get currentAccount(): Account | undefined {
    return this.accounts[this._currentIndex];
  }

  /**
   * Returns env vars to inject for the current account.
   * Empty object if no accounts configured.
   */
  getCurrentEnv(): Record<string, string> {
    const acct = this.currentAccount;
    if (!acct) return {};
    return { CLAUDE_CONFIG_DIR: acct.configDir };
  }

  /**
   * Returns the name of the current account, or "default" if no pool.
   */
  getCurrentName(): string {
    return this.currentAccount?.name ?? "default";
  }

  /**
   * Total number of configured accounts.
   */
  accountCount(): number {
    return this.accounts.length;
  }

  /**
   * Mark the current account as rate limited and rotate to the next available.
   * Returns true if a new account is available, false if all are limited.
   * @param cooldownMs Optional override for cooldown duration
   */
  markLimitedAndRotate(cooldownMs?: number): boolean {
    const cd = cooldownMs ?? this.cooldownMs;
    const acct = this.currentAccount;

    if (acct) {
      acct.rateLimitedUntil = Date.now() + cd;
      console.log(
        `[AccountPool] Account "${acct.name}" rate limited for ${cd / 1000}s`
      );
    }

    // Try to find next available account (not limited, or limit expired)
    const now = Date.now();
    const startIndex = this._currentIndex;

    for (let i = 1; i <= this.accounts.length; i++) {
      const nextIndex = (startIndex + i) % this.accounts.length;
      const candidate = this.accounts[nextIndex]!;

      if (
        candidate.rateLimitedUntil === null ||
        candidate.rateLimitedUntil <= now
      ) {
        this._currentIndex = nextIndex;
        console.log(
          `[AccountPool] Rotated to account "${candidate.name}" (index ${nextIndex})`
        );
        return true;
      }
    }

    console.warn("[AccountPool] All accounts are rate limited");
    return false;
  }

  /**
   * Returns a human-readable status summary.
   */
  getStatus(): string {
    if (this.accounts.length === 0) {
      return "No pool configured";
    }

    const now = Date.now();
    const parts = this.accounts.map((acct, idx) => {
      const isCurrent = idx === this._currentIndex;
      const prefix = isCurrent ? ">" : " ";
      if (acct.rateLimitedUntil && acct.rateLimitedUntil > now) {
        const secsLeft = Math.ceil((acct.rateLimitedUntil - now) / 1000);
        return `${prefix} ${acct.name} [limited ${secsLeft}s]`;
      }
      return `${prefix} ${acct.name} [ok]`;
    });

    return parts.join(", ");
  }
}

// Singleton instance
export const accountPool = new AccountPool();
