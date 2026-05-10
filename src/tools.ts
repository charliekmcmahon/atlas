import { Type, type FunctionDeclaration, GoogleGenAI } from "@google/genai";
import type { MemoryStore, Reminder, UserProfile, AgentTask } from "./db.js";
import { appConfig } from "./config.js";
import { computeNextFromCron } from "./agent-tasks.js";

const ai = new GoogleGenAI({ apiKey: appConfig.geminiApiKey });

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ToolContext {
  contact: string;
  chatId: string | null;
  store: MemoryStore;
}

export interface ToolResult {
  // Returned to the model as the function response. Should be JSON-serializable.
  payload: Record<string, unknown>;
  // Optional human-readable note for the local console log.
  log?: string;
}

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "set_user_info",
    description:
      "Save durable facts about the user to their profile. Call this any time the user shares their name, where they live, their timezone, or their preferred language. Only include the fields the user actually mentioned in this message — do not guess or invent values.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: "What to call the user, e.g. 'Charlie'.",
        },
        location: {
          type: Type.STRING,
          description: "City and region/country, e.g. 'Brooklyn, NY' or 'London, UK'.",
        },
        timezone: {
          type: Type.STRING,
          description: "IANA timezone identifier, e.g. 'America/New_York' or 'Europe/London'. If the user gives a city, infer the IANA zone.",
        },
        language: {
          type: Type.STRING,
          description: "Preferred reply language, e.g. 'English', 'Spanish'.",
        },
      },
    },
  },
  {
    name: "set_reminder",
    description:
      "Schedule a reminder. At the due time, atlas will text the reminder back to the user. Use this whenever the user asks to be reminded, nudged, pinged, or to set a timer/alarm. The due_at value MUST be an ISO 8601 timestamp that includes a timezone offset (e.g. '2026-05-11T15:00:00-04:00'). Compute it using the user's timezone — if it's unknown, ask before scheduling.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The reminder text that will be sent back to the user. Write it in second person, e.g. 'call mom' or 'leave for the airport'.",
        },
        due_at: {
          type: Type.STRING,
          description: "ISO 8601 timestamp with timezone offset. Must be in the future.",
        },
      },
      required: ["text", "due_at"],
    },
  },
  {
    name: "list_reminders",
    description: "List the user's pending (not yet fired, not cancelled) reminders.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel one of the user's pending reminders by id (use list_reminders first if you don't have the id).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: {
          type: Type.INTEGER,
          description: "The reminder id returned from list_reminders or set_reminder.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "create_agent_task",
    description: "Create a background agent task. Use 'name' to identify the task and 'payload' to store JSON arguments. Provide either 'due_at' for one-off tasks (ISO timestamp) or 'schedule' as a cron expression for recurring tasks.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Short task name" },
        payload: { type: Type.STRING, description: "JSON-serialized payload (tool + args)" },
        due_at: { type: Type.STRING, description: "ISO timestamp for a one-off run" },
        schedule: { type: Type.STRING, description: "Cron expression for recurring runs" },
        is_recurring: { type: Type.BOOLEAN, description: "Whether the task should recur (if schedule is provided)" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_agent_tasks",
    description: "List the user's active (not cancelled) agent tasks.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "cancel_agent_task",
    description: "Cancel one of the user's agent tasks by id.",
    parameters: { type: Type.OBJECT, properties: { id: { type: Type.INTEGER } }, required: ["id"] },
  },
  {
    name: "google_search",
    description: "Search Google and return structured top results and a short summary. The tool will perform the search and use the assistant to synthesize results.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search query" },
        limit: { type: Type.INTEGER, description: "Max number of results to return" },
      },
      required: ["query"],
    },
  },
];

export async function runToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (name) {
    case "set_user_info":
      return handleSetUserInfo(args, ctx);
    case "set_reminder":
      return handleSetReminder(args, ctx);
    case "list_reminders":
      return handleListReminders(ctx);
    case "cancel_reminder":
      return handleCancelReminder(args, ctx);
    case "create_agent_task":
      return handleCreateAgentTask(args, ctx);
    case "list_agent_tasks":
      return handleListAgentTasks(ctx);
    case "cancel_agent_task":
      return handleCancelAgentTask(args, ctx);
    case "google_search":
      return handleGoogleSearch(args, ctx);
    default:
      return {
        payload: { error: `unknown tool: ${name}` },
        log: `unknown tool: ${name}`,
      };
  }
}

async function handleCreateAgentTask(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const payload = typeof args.payload === "string" ? args.payload : args.payload ? JSON.stringify(args.payload) : null;
  const dueAt = typeof args.due_at === "string" ? args.due_at.trim() : null;
  const schedule = typeof args.schedule === "string" ? args.schedule.trim() : null;
  const isRecurring = Boolean(args.is_recurring) || Boolean(schedule);

  if (!name) return { payload: { ok: false, error: "name is required" } };

  let nextRun: string | null = null;
  if (dueAt) {
    const parsed = new Date(dueAt);
    if (Number.isNaN(parsed.getTime())) return { payload: { ok: false, error: `could not parse due_at: ${dueAt}` } };
    if (parsed.getTime() <= Date.now()) return { payload: { ok: false, error: "due_at must be in the future" } };
    nextRun = parsed.toISOString();
  } else if (schedule) {
    try {
      nextRun = computeNextFromCron(schedule);
    } catch (error) {
      return { payload: { ok: false, error: `invalid schedule: ${toErrorMessage(error)}` } };
    }
  }

  const task = ctx.store.createAgentTask({
    contact: ctx.contact,
    chatId: ctx.chatId,
    name,
    payload,
    schedule: schedule ?? null,
    nextRunAt: nextRun,
    isRecurring,
  });

  return { payload: { ok: true, task }, log: `created agent task #${task.id} "${task.name}"` };
}

function handleListAgentTasks(ctx: ToolContext): ToolResult {
  const tasks = ctx.store.listActiveAgentTasks(ctx.contact);
  return { payload: { tasks }, log: `listed ${tasks.length} agent tasks` };
}

function handleCancelAgentTask(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const idRaw = args.id;
  const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    return { payload: { ok: false, error: "id is required and must be a positive number" } };
  }

  const cancelled = ctx.store.cancelAgentTask(ctx.contact, id);
  if (!cancelled) return { payload: { ok: false, error: `no active agent task with id ${id}` } };
  return { payload: { ok: true, id }, log: `cancelled agent task #${id}` };
}

async function handleGoogleSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(10, Math.floor(args.limit)) : 5;
  if (!query) return { payload: { ok: false, error: "query is required" } };

  try {
    // Use the native search tool provided by the Google GenAI client when available.
    // Fall back to any available search method names to be robust across SDK versions.
    // Typing is intentionally loose because the SDK surface can vary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any = null;
    if (typeof (ai as any).tools?.search === "function") {
      raw = await (ai as any).tools.search({ query, limit });
    } else if (typeof (ai as any).search === "function") {
      raw = await (ai as any).search({ query, limit });
    } else if (typeof (ai as any).web?.search === "function") {
      raw = await (ai as any).web.search({ query, limit });
    } else {
      throw new Error("Google GenAI search API not available in this SDK version");
    }

    const resultsList = raw?.results ?? raw?.items ?? raw?.organic_results ?? [];
    const top = (Array.isArray(resultsList) ? resultsList.slice(0, limit) : []).map((r: any) => ({
      title: r.title ?? r.headline ?? r.name ?? "",
      snippet: (r.snippet ?? r.snippet_text ?? r.snippetHtml ?? r.snippet) || "",
      url: r.url ?? r.link ?? r.href ?? r.uri ?? "",
    }));

    // Ask Gemini to synthesize a short summary for the user
    const contents = [
      { role: "system", text: `You are a concise web search summarizer.` },
      { role: "user", text: `Summarize the following search results for the query: ${query}\n\nResults:\n${top
          .map((t: any) => `- ${t.title}: ${t.snippet} (${t.url})`)
          .join("\n")}` },
    ];

    const response = await ai.models.generateContent({
      model: appConfig.geminiModel,
      config: { systemInstruction: "Summarize search results briefly and provide a short actionable answer." },
      contents,
    });

    const summary = response.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";

    return { payload: { ok: true, query, results: top, summary }, log: `google_search: ${query} -> ${top.length} results` };
  } catch (error) {
    return { payload: { ok: false, error: toErrorMessage(error) }, log: `google_search error: ${toErrorMessage(error)}` };
  }
}

function handleSetUserInfo(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const fields: Partial<Record<keyof Omit<UserProfile, "updatedAt">, string>> = {};
  for (const key of ["name", "location", "timezone", "language"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      fields[key] = value.trim();
    }
  }

  if (Object.keys(fields).length === 0) {
    return { payload: { ok: false, reason: "no recognized fields provided" } };
  }

  const profile = ctx.store.setProfileFields(ctx.contact, fields);
  return {
    payload: { ok: true, profile: profileToPayload(profile) },
    log: `profile updated (${Object.keys(fields).join(", ")})`,
  };
}

function handleSetReminder(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const dueAtRaw = typeof args.due_at === "string" ? args.due_at.trim() : "";

  if (!text) {
    return { payload: { ok: false, error: "text is required" } };
  }
  if (!dueAtRaw) {
    return { payload: { ok: false, error: "due_at is required" } };
  }

  const parsed = new Date(dueAtRaw);
  if (Number.isNaN(parsed.getTime())) {
    return { payload: { ok: false, error: `could not parse due_at: ${dueAtRaw}` } };
  }
  if (parsed.getTime() <= Date.now()) {
    return { payload: { ok: false, error: "due_at must be in the future" } };
  }

  const reminder = ctx.store.createReminder({
    contact: ctx.contact,
    chatId: ctx.chatId,
    text,
    dueAt: parsed.toISOString(),
  });

  return {
    payload: {
      ok: true,
      reminder: reminderToPayload(reminder),
    },
    log: `scheduled reminder #${reminder.id} for ${reminder.dueAt}: "${text}"`,
  };
}

function handleListReminders(ctx: ToolContext): ToolResult {
  const reminders = ctx.store.listPendingReminders(ctx.contact);
  return {
    payload: {
      reminders: reminders.map(reminderToPayload),
    },
  };
}

function handleCancelReminder(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const idRaw = args.id;
  const id = typeof idRaw === "number" ? idRaw : Number(idRaw);
  if (!Number.isFinite(id) || id <= 0) {
    return { payload: { ok: false, error: "id is required and must be a positive number" } };
  }

  const cancelled = ctx.store.cancelReminder(ctx.contact, id);
  if (!cancelled) {
    return { payload: { ok: false, error: `no pending reminder with id ${id}` } };
  }

  return {
    payload: { ok: true, id },
    log: `cancelled reminder #${id}`,
  };
}

function profileToPayload(profile: UserProfile): Record<string, unknown> {
  return {
    name: profile.name,
    location: profile.location,
    timezone: profile.timezone,
    language: profile.language,
    updated_at: profile.updatedAt,
  };
}

function reminderToPayload(reminder: Reminder): Record<string, unknown> {
  return {
    id: reminder.id,
    text: reminder.text,
    due_at: reminder.dueAt,
    created_at: reminder.createdAt,
  };
}
