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
  type Content,
  type Part,
} from "@google/genai";

import { appConfig } from "./config.js";
import { MemoryStore, type Reminder } from "./db.js";
import { buildSystemPrompt, buildUserContext } from "./prompt.js";
import { ReminderScheduler } from "./scheduler.js";
import { runToolCall, toolDeclarations } from "./tools.js";
import { IMessageClient, type IMessage, type SseEvent } from "./imessage-client.js";

type BotMode = "imessage" | "cli";

interface AttachmentInput {
  label: string;
  localPath: string;
  fileName: string | null;
  mimeType: string | null;
}

const MAX_TOOL_ITERATIONS = 5;

const ai = new GoogleGenAI({ apiKey: appConfig.geminiApiKey });
const memoryStore = new MemoryStore(appConfig.dbPath);
const imessage = new IMessageClient({
  baseUrl: appConfig.imessageApiUrl,
  apiKey: appConfig.imessageApiKey,
});

let cliInterface: ReadlineInterface | null = null;
let memoryClosed = false;
let isShuttingDown = false;
let stopSubscription: (() => void) | null = null;
let scheduler: ReminderScheduler | null = null;
let queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(task).catch((error: unknown) => {
    console.error("[atlas] task failed:", toErrorMessage(error));
  });
}

function questionAsync(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function handleInbound(message: IMessage): Promise<void> {
  const contact = message.participant;
  if (!contact) return;
  if (appConfig.allowedContact && normalizeContact(contact) !== normalizeContact(appConfig.allowedContact)) {
    if (appConfig.debug) {
      console.log(`[atlas] ignoring inbound from non-allowed contact: ${contact}`);
    }
    return;
  }

  const text = message.text ?? "";
  if (!text.trim()) return;

  // Built-in chat commands take precedence over Gemini.
  if (await maybeHandleCommand(contact, text)) return;

  const messageId = message.id ?? `row-${message.rowId}`;
  const nowIso = message.createdAt ?? new Date().toISOString();

  const inserted = memoryStore.registerIncomingMessage({
    messageId,
    contact,
    chatId: message.chatId,
    text,
    hasAttachments: message.hasAttachments,
    createdAt: nowIso,
  });

  if (!inserted) return; // already processed

  memoryStore.extractAndStoreMemories(contact, text, messageId);
  memoryStore.markMessageRead(messageId, new Date().toISOString());

  const reply = await generateAssistantReply(contact, message.chatId, text, []);

  for (const chunk of splitForIMessage(reply, appConfig.maxIMessageChunk)) {
    await imessage.send(contact, chunk);
    memoryStore.storeAssistantMessage({
      messageId: createLocalMessageId(),
      contact,
      chatId: message.chatId,
      text: chunk,
      createdAt: new Date().toISOString(),
    });
  }
}

// Inbound text starting with "/" is treated as a control command, not a prompt.
// Returns true if the text was handled (no Gemini reply should follow).
async function maybeHandleCommand(contact: string, rawText: string): Promise<boolean> {
  const cmd = rawText.trim().toLowerCase();
  if (!cmd.startsWith("/")) return false;

  if (cmd === "/reboot") {
    console.log("[atlas] /reboot received — pulling latest code and restarting");
    try {
      await imessage.send(contact, "rebooting...");
    } catch (error) {
      console.error("[atlas] could not send reboot ack:", toErrorMessage(error));
    }
    void shutdown("reboot", 42);
    return true;
  }

  if (cmd === "/ping") {
    try {
      await imessage.send(contact, "pong");
    } catch (error) {
      console.error("[atlas] could not send pong:", toErrorMessage(error));
    }
    return true;
  }

  // Unknown slash command — let it fall through to Gemini so the user gets feedback.
  return false;
}

async function generateAssistantReply(
  contact: string,
  chatId: string | null,
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
    profile: memoryStore.getProfile(contact),
  });

  const contents: Content[] = [
    createUserContent([createPartFromText(promptText), ...attachmentParts]),
  ];

  const toolCtx = { contact, chatId, store: memoryStore };
  let finalText = "";

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const response = await ai.models.generateContent({
      model: appConfig.geminiModel,
      config: {
        systemInstruction: buildSystemPrompt(),
        tools: [{ functionDeclarations: toolDeclarations }],
      },
      contents,
    });

    const candidate = response.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];
    const functionCalls = parts.filter((part) => part.functionCall);

    if (functionCalls.length === 0) {
      finalText = parts
        .map((part) => part.text ?? "")
        .filter((text) => text.length > 0)
        .join("");
      break;
    }

    if (candidate?.content) {
      contents.push(candidate.content);
    }

    const responseParts: Part[] = [];
    for (const part of functionCalls) {
      const call = part.functionCall;
      if (!call?.name) continue;

      const args = (call.args ?? {}) as Record<string, unknown>;
      let result;
      try {
        result = await runToolCall(call.name, args, toolCtx);
      } catch (error) {
        result = {
          payload: { error: toErrorMessage(error) },
          log: `tool ${call.name} threw: ${toErrorMessage(error)}`,
        };
      }

      if (result.log) {
        console.log(`[atlas] tool ${call.name}: ${result.log}`);
      } else if (appConfig.debug) {
        console.log(`[atlas] tool ${call.name} called`);
      }

      responseParts.push({
        functionResponse: {
          name: call.name,
          response: result.payload,
        },
      });
    }

    contents.push({ role: "user", parts: responseParts });
  }

  return finalizeReply(finalText);
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
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  // Strip everything but digits, then re-prefix `+` if it looks like E.164.
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return trimmed.toLowerCase();
  return `+${digits}`;
}

function createLocalMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatReminderForDelivery(reminder: Reminder): string {
  return `reminder: ${reminder.text}`;
}

async function deliverReminderToIMessage(reminder: Reminder): Promise<void> {
  const body = formatReminderForDelivery(reminder);
  for (const chunk of splitForIMessage(body, appConfig.maxIMessageChunk)) {
    await imessage.send(reminder.contact, chunk);
    memoryStore.storeAssistantMessage({
      messageId: createLocalMessageId(),
      contact: reminder.contact,
      chatId: reminder.chatId,
      text: chunk,
      createdAt: new Date().toISOString(),
    });
  }
  console.log(`[atlas] reminder #${reminder.id} delivered: "${reminder.text}"`);
}

async function deliverReminderToCli(reminder: Reminder): Promise<void> {
  const body = formatReminderForDelivery(reminder);
  console.log(`\n[atlas] ${body}`);
  memoryStore.storeAssistantMessage({
    messageId: createLocalMessageId(),
    contact: reminder.contact,
    chatId: reminder.chatId,
    text: body,
    createdAt: new Date().toISOString(),
  });
}

async function start(): Promise<void> {
  const mode = resolveMode();
  console.log(`[atlas] mode: ${mode}`);
  console.log(`[atlas] model: ${appConfig.geminiModel}`);

  if (mode === "cli") {
    await startCliMode();
    return;
  }

  await startIMessageMode();
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[atlas] shutting down (${signal}, exit=${exitCode})`);
  cliInterface?.close();
  stopSubscription?.();
  scheduler?.stop();

  await Promise.allSettled([queue, Promise.resolve().then(() => closeMemoryStore())]);
  process.exit(exitCode);
}

async function startIMessageMode(): Promise<void> {
  if (!appConfig.allowedContact) {
    throw new Error("ALLOWED_CONTACT is required when running in imessage mode");
  }

  const allowedContact = normalizeContact(appConfig.allowedContact);
  console.log(`[atlas] allowed contact: ${allowedContact}`);
  console.log(`[atlas] imessage api: ${appConfig.imessageApiUrl}`);

  // Verify the API is reachable and the bearer token works before subscribing.
  try {
    await imessage.health();
    console.log("[atlas] imessage api health ok");
  } catch (error) {
    throw new Error(`imessage api not reachable at ${appConfig.imessageApiUrl}: ${toErrorMessage(error)}`);
  }

  scheduler = new ReminderScheduler({
    store: memoryStore,
    deliver: deliverReminderToIMessage,
    intervalMs: appConfig.reminderTickMs,
  });
  scheduler.start();
  console.log(`[atlas] reminder scheduler started (tick: ${appConfig.reminderTickMs}ms)`);

  // Pick the boot greeting:
  //   - post-reboot (supervisor set ATLAS_REBOOTING=1) → "back online!"
  //   - cold start with STARTUP_MESSAGE configured → that message
  //   - otherwise → silent
  const bootMessage = process.env.ATLAS_REBOOTING === "1"
    ? "back online!"
    : appConfig.startupMessage || "";

  if (bootMessage) {
    try {
      await imessage.send(allowedContact, bootMessage);
      console.log(`[atlas] sent boot message: ${bootMessage}`);
    } catch (error) {
      console.error("[atlas] could not send boot message:", toErrorMessage(error));
    }
  }

  stopSubscription = imessage.subscribe({
    onConnect: () => console.log("[atlas] event stream connected"),
    onDisconnect: (reason) => console.warn(`[atlas] event stream disconnected: ${reason}`),
    onError: (err) => {
      if (appConfig.debug) console.error("[atlas] stream error:", err.message);
    },
    onMessage: (event: SseEvent) => {
      if (event.type !== "inbound") return;
      const msg = event.data as IMessage;
      if (msg.kind !== "text") return;

      if (appConfig.debug) {
        console.log(
          `[atlas] inbound rowid=${msg.rowId} text="${(msg.text ?? "").slice(0, 60)}"`
        );
      }
      enqueue(() => handleInbound(msg));
    },
  });

  // Park the event loop. Shutdown handlers will resolve.
  await new Promise<void>(() => {
    /* runs until shutdown calls process.exit */
  });
}

async function startCliMode(): Promise<void> {
  const contact = normalizeContact(appConfig.cliContact);
  const pendingAttachments: string[] = [];

  cliInterface = createInterface({ input: process.stdin, output: process.stdout });

  scheduler = new ReminderScheduler({
    store: memoryStore,
    deliver: deliverReminderToCli,
    intervalMs: appConfig.reminderTickMs,
  });
  scheduler.start();

  console.log(`[atlas] cli contact id: ${contact}`);
  console.log("[atlas] commands: /help, /file <path>, /files, /clearfiles, /exit");

  while (true) {
    const input = await questionAsync(cliInterface, "you> ");
    const line = input.trim();
    if (!line) continue;

    if (line === "/exit" || line === "/quit") break;

    if (line === "/help") {
      console.log("[atlas] /file <path> adds an attachment for the next prompt");
      console.log("[atlas] /files shows queued attachments");
      console.log("[atlas] /clearfiles clears queued attachments");
      console.log("[atlas] /exit quits");
      continue;
    }

    if (line === "/files") {
      if (pendingAttachments.length === 0) {
        console.log("[atlas] no queued attachments");
      } else {
        for (const path of pendingAttachments) {
          console.log(`[atlas] queued: ${path}`);
        }
      }
      continue;
    }

    if (line === "/clearfiles") {
      pendingAttachments.length = 0;
      console.log("[atlas] cleared queued attachments");
      continue;
    }

    if (line.startsWith("/file ")) {
      const rawPath = line.slice(6).trim();
      if (!rawPath) {
        console.log("[atlas] usage: /file <path>");
        continue;
      }

      const filePath = resolve(rawPath);
      try {
        await access(filePath);
        pendingAttachments.push(filePath);
        console.log(`[atlas] queued attachment: ${filePath}`);
      } catch (error) {
        console.log(`[atlas] could not read file: ${toErrorMessage(error)}`);
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

    console.log("[atlas] thinking...");

    try {
      const reply = await generateAssistantReply(contact, "cli", line, toCliAttachmentInputs(attachmentPaths));
      console.log(`bot> ${reply}\n`);

      for (const chunk of splitForIMessage(reply, appConfig.maxIMessageChunk)) {
        memoryStore.storeAssistantMessage({
          messageId: createLocalMessageId(),
          contact,
          chatId: "cli",
          text: chunk,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.log(`[atlas] failed to generate reply: ${toErrorMessage(error)}`);
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

  if (normalized === "imessage") return "imessage";
  if (normalized === "cli" || normalized === "terminal") return "cli";

  throw new Error(`Unsupported BOT mode: ${rawMode}. Use 'imessage' or 'cli'.`);
}

function closeMemoryStore(): void {
  if (memoryClosed) return;
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
  console.error("[atlas] startup failed:", error);
  closeMemoryStore();
  process.exit(1);
});
