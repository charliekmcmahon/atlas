import "dotenv/config";

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { access, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import mime from "mime";
import {
  GoogleGenAI,
  createPartFromText,
  createPartFromUri,
  createUserContent,
  type Part,
} from "@google/genai";

import { appConfig } from "./config.js";
import { MemoryStore } from "./db.js";
import { buildSystemPrompt, buildUserContext, chooseReaction } from "./prompt.js";
import { sendViaAppleScript } from "./imessage-client.js";
import { getMaxRowId, getNewIncomingMessages } from "./messages-db.js";

type BotMode = "imessage" | "cli";

interface AttachmentInput {
  label: string;
  localPath: string;
  fileName: string | null;
  mimeType: string | null;
}

const ai = new GoogleGenAI({ apiKey: appConfig.geminiApiKey });
const memoryStore = new MemoryStore(appConfig.dbPath);

let cliInterface: ReadlineInterface | null = null;
let memoryClosed = false;
let isShuttingDown = false;
let allowedContact = "";
let queue = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((error: unknown) => {
    console.error("[bot] task failed:", toErrorMessage(error));
  });
}

// Node 16 compatible readline question wrapper
function questionAsync(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleMessage(contact: string, text: string, messageId: string): Promise<void> {
  const nowIso = new Date().toISOString();

  const inserted = memoryStore.registerIncomingMessage({
    messageId,
    contact,
    chatId: null,
    text,
    hasAttachments: false,
    createdAt: nowIso,
  });

  if (!inserted) {
    return;
  }

  memoryStore.extractAndStoreMemories(contact, text, messageId);
  memoryStore.markMessageRead(messageId, nowIso);

  if (appConfig.sendEmojiReaction) {
    try {
      await sendViaAppleScript(contact, chooseReaction(text, 0));
    } catch (error) {
      console.error("[bot] failed to send reaction:", toErrorMessage(error));
    }
  }

  const reply = await generateAssistantReply(contact, text, []);

  for (const chunk of splitForIMessage(reply, 1000)) {
    await sendViaAppleScript(contact, chunk);
    memoryStore.storeAssistantMessage({
      messageId: createLocalMessageId(),
      contact,
      chatId: null,
      text: chunk,
      createdAt: new Date().toISOString(),
    });
  }
}

async function generateAssistantReply(
  contact: string,
  latestUserText: string,
  attachments: readonly AttachmentInput[]
): Promise<string> {
  const { parts: attachmentParts, summaries } = await buildAttachmentParts(attachments);

  const promptText = buildUserContext({
    nowIso: new Date().toISOString(),
    latestUserText,
    memories: memoryStore.getMemories(contact, 8),
    recentConversation: memoryStore.recentConversation(contact, 14),
    attachmentSummaries: summaries,
  });

  const response = await ai.models.generateContentStream({
    model: appConfig.model,
    config: {
      systemInstruction: buildSystemPrompt(),
      tools: [{ googleSearch: {} }],
    },
    contents: [createUserContent([createPartFromText(promptText), ...attachmentParts])],
  });

  let reply = "";
  for await (const chunk of response) {
    if (chunk.text) {
      reply += chunk.text;
    }
  }

  return finalizeReply(reply);
}

async function buildAttachmentParts(
  attachments: readonly AttachmentInput[]
): Promise<{ parts: Part[]; summaries: string[] }> {
  const parts: Part[] = [];
  const summaries: string[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const label = `attachment ${index + 1}`;
    const localPath = attachment.localPath;

    if (!localPath) {
      summaries.push(`${label}: unavailable local file path`);
      continue;
    }

    try {
      await access(localPath);
      const fileStat = await stat(localPath);
      if (fileStat.size > appConfig.maxAttachmentBytes) {
        summaries.push(`${label}: skipped (too large: ${fileStat.size} bytes)`);
        continue;
      }

      const mimeType = attachment.mimeType || mime.getType(localPath) || "application/octet-stream";
      const uploaded = await ai.files.upload({
        file: localPath,
        config: { mimeType },
      });

      if (!uploaded.uri || !uploaded.mimeType) {
        summaries.push(`${label}: upload returned missing URI metadata`);
        continue;
      }

      parts.push(createPartFromUri(uploaded.uri, uploaded.mimeType));
      const name = attachment.fileName || basename(localPath) || "file";
      summaries.push(`${label}: ${name} (${uploaded.mimeType})`);
    } catch (error) {
      summaries.push(`${label}: failed to process (${toErrorMessage(error)})`);
    }
  }

  return { parts, summaries };
}

function toCliAttachmentInputs(paths: readonly string[]): AttachmentInput[] {
  return paths.map((path, index) => ({
    label: `attachment ${index + 1}`,
    localPath: path,
    fileName: basename(path),
    mimeType: mime.getType(path),
  }));
}

function finalizeReply(raw: string): string {
  const cleaned = raw.replace(/\r\n/g, "\n").trim();
  if (cleaned.length > 0) {
    return cleaned;
  }
  return "hmm i blanked for a sec. can you resend that?";
}

function splitForIMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < Math.floor(maxLength * 0.5)) {
      splitAt = maxLength;
    }

    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim()) {
    chunks.push(remaining.trim());
  }

  return chunks.length > 0 ? chunks : [text];
}

function normalizeContact(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }

  const digits = trimmed.replace(/\D/g, "");
  if (!digits) {
    return trimmed.toLowerCase();
  }

  // Australian local format: 10 digits starting with 0 → +61XXXXXXXXX
  if (digits.length === 10 && digits.startsWith("0")) {
    return `+61${digits.slice(1)}`;
  }

  return `+${digits}`;
}

function createLocalMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function start(): Promise<void> {
  const mode = resolveMode();
  console.log(`[bot] mode: ${mode}`);
  console.log(`[bot] model: ${appConfig.model}`);

  if (mode === "cli") {
    await startCliMode();
    return;
  }

  await startIMessageMode();
}

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`[bot] shutting down (${signal})`);
  cliInterface?.close();

  await Promise.allSettled([queue, Promise.resolve().then(() => closeMemoryStore())]);
  process.exit(0);
}

async function startIMessageMode(): Promise<void> {
  if (!appConfig.allowedContact) {
    throw new Error("ALLOWED_CONTACT is required when running in imessage mode");
  }

  allowedContact = normalizeContact(appConfig.allowedContact);
  console.log(`[bot] allowed contact: ${allowedContact}`);

  // Seed lastRowId so we skip all messages that existed before this session started
  let lastRowId = getMaxRowId();
  console.log(`[bot] starting from Messages DB rowid ${lastRowId}`);
  console.log(`[bot] polling every ${appConfig.pollIntervalMs}ms for messages from ${allowedContact}`);

  try {
    await sendViaAppleScript(allowedContact, "im online");
    console.log("[bot] sent startup message");
  } catch (error) {
    console.error("[bot] could not send startup message:", toErrorMessage(error));
  }

  while (!isShuttingDown) {
    await sleep(appConfig.pollIntervalMs);

    try {
      const fresh = getNewIncomingMessages(allowedContact, lastRowId);

      for (const msg of fresh) {
        if (msg.rowid > lastRowId) {
          lastRowId = msg.rowid;
        }

        if (appConfig.debug) {
          console.log(`[bot] incoming rowid=${msg.rowid} text="${msg.text.slice(0, 60)}"`);
        }

        const capturedMsg = msg;
        enqueue(() => handleMessage(allowedContact, capturedMsg.text, String(capturedMsg.rowid)));
      }
    } catch (error) {
      console.error(`[bot] poll error: ${toErrorMessage(error)}`);
    }
  }
}

async function startCliMode(): Promise<void> {
  const contact = normalizeContact(appConfig.cliContact);
  const pendingAttachments: string[] = [];

  cliInterface = createInterface({ input: process.stdin, output: process.stdout });

  console.log(`[bot] cli contact id: ${contact}`);
  console.log("[bot] commands: /help, /file <path>, /files, /clearfiles, /exit");

  while (true) {
    const input = await questionAsync(cliInterface, "you> ");
    const line = input.trim();
    if (!line) {
      continue;
    }

    if (line === "/exit" || line === "/quit") {
      break;
    }

    if (line === "/help") {
      console.log("[bot] /file <path> adds an attachment for the next prompt");
      console.log("[bot] /files shows queued attachments");
      console.log("[bot] /clearfiles clears queued attachments");
      console.log("[bot] /exit quits");
      continue;
    }

    if (line === "/files") {
      if (pendingAttachments.length === 0) {
        console.log("[bot] no queued attachments");
      } else {
        for (const path of pendingAttachments) {
          console.log(`[bot] queued: ${path}`);
        }
      }
      continue;
    }

    if (line === "/clearfiles") {
      pendingAttachments.length = 0;
      console.log("[bot] cleared queued attachments");
      continue;
    }

    if (line.startsWith("/file ")) {
      const rawPath = line.slice(6).trim();
      if (!rawPath) {
        console.log("[bot] usage: /file <path>");
        continue;
      }

      const filePath = resolve(rawPath);
      try {
        await access(filePath);
        pendingAttachments.push(filePath);
        console.log(`[bot] queued attachment: ${filePath}`);
      } catch (error) {
        console.log(`[bot] could not read file: ${toErrorMessage(error)}`);
      }
      continue;
    }

    const nowIso = new Date().toISOString();
    const userMessageId = createLocalMessageId();
    const attachmentPaths = pendingAttachments.splice(0, pendingAttachments.length);

    memoryStore.registerIncomingMessage({
      messageId: userMessageId,
      contact,
      chatId: "cli",
      text: line,
      hasAttachments: attachmentPaths.length > 0,
      createdAt: nowIso,
    });
    memoryStore.markMessageRead(userMessageId, nowIso);
    memoryStore.extractAndStoreMemories(contact, line, userMessageId);

    console.log("[bot] thinking...");

    try {
      const reply = await generateAssistantReply(contact, line, toCliAttachmentInputs(attachmentPaths));
      console.log(`bot> ${reply}\n`);

      for (const chunk of splitForIMessage(reply, 1000)) {
        memoryStore.storeAssistantMessage({
          messageId: createLocalMessageId(),
          contact,
          chatId: "cli",
          text: chunk,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.log(`[bot] failed to generate reply: ${toErrorMessage(error)}`);
    }
  }

  await shutdown("cli-exit");
}

function resolveMode(): BotMode {
  const args = process.argv.slice(2);

  const modeFlag = args.find((arg) => arg.startsWith("--mode="));
  const fromFlag = modeFlag ? modeFlag.slice("--mode=".length) : "";

  const positionalMode = args.find((arg) => arg === "imessage" || arg === "cli") || "";
  const fromEnv = process.env.BOT_MODE?.trim() || "";

  const rawMode = fromFlag || positionalMode || fromEnv || "imessage";
  const normalized = rawMode.toLowerCase();

  if (normalized === "imessage") {
    return "imessage";
  }
  if (normalized === "cli" || normalized === "terminal") {
    return "cli";
  }

  throw new Error(`Unsupported BOT mode: ${rawMode}. Use 'imessage' or 'cli'.`);
}

function closeMemoryStore(): void {
  if (memoryClosed) {
    return;
  }
  memoryClosed = true;
  memoryStore.close();
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void start().catch(async (error) => {
  console.error("[bot] startup failed:", error);
  closeMemoryStore();
  process.exit(1);
});
