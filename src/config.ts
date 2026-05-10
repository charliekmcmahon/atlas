import { resolve } from "node:path";

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export const appConfig = {
  geminiApiKey: getRequiredEnv("GEMINI_API_KEY"),
  geminiModel: process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash",

  // The phone or Apple ID this bot will reply to. Must also be in the
  // imessage-api-catalina server's ALLOWED_RECIPIENTS list, or sends will be rejected.
  allowedContact: process.env.ALLOWED_CONTACT?.trim() || "",

  // imessage-api-catalina API
  imessageApiUrl: normalizeBaseUrl(process.env.IMESSAGE_API_URL?.trim() || "http://localhost:8787"),
  imessageApiKey: getRequiredEnv("IMESSAGE_API_KEY"),

  // CLI mode contact id (used as the memory key for /run -- mode=cli sessions)
  cliContact: process.env.CLI_CONTACT?.trim() || "terminal-user",

  // Local memory store
  dbPath: resolve(process.env.MEMORY_DB_PATH?.trim() || "./data/memories.sqlite"),

  // Behavior
  maxAttachmentBytes: toPositiveInt(process.env.MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024),
  maxIMessageChunk: toPositiveInt(process.env.MAX_IMESSAGE_CHUNK, 1000),
  startupMessage: process.env.STARTUP_MESSAGE?.trim() || "",

  // How often the reminder scheduler polls for due reminders.
  reminderTickMs: toPositiveInt(process.env.REMINDER_TICK_MS, 30_000),

  // How often the agent task scheduler polls for due tasks. If unset, falls back to reminderTickMs.
  agentTaskTickMs: process.env.AGENT_TASK_TICK_MS ? toPositiveInt(process.env.AGENT_TASK_TICK_MS, 30_000) : undefined,

  debug: toBool(process.env.DEBUG, false),
} as const;
