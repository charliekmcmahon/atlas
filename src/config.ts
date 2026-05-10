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

export const appConfig = {
  geminiApiKey: getRequiredEnv("GEMINI_API_KEY"),
  allowedContact: process.env.ALLOWED_CONTACT?.trim() || "",
  cliContact: process.env.CLI_CONTACT?.trim() || "terminal-user",
  model: process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview",
  dbPath: resolve(process.env.MEMORY_DB_PATH?.trim() || "./data/memories.sqlite"),
  sendEmojiReaction: toBool(process.env.SEND_EMOJI_REACTION, true),
  maxAttachmentBytes: toPositiveInt(process.env.MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024),
  debug: toBool(process.env.DEBUG, false),
  imessageApiKey: process.env.IMESSAGE_API_KEY?.trim() || "",
  imessageApiUrls: (process.env.IMESSAGE_API_URLS?.trim() || "http://localhost:5000,http://192.168.0.49:5000")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean),
  pollIntervalMs: toPositiveInt(process.env.POLL_INTERVAL_MS, 3000),
} as const;
