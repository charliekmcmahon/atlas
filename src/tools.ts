import { Type, type FunctionDeclaration, GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { MemoryStore, Reminder, UserProfile, AgentTask } from "./db.js";
import { appConfig } from "./config.js";
import { getUpcomingEvents, getTodaysEvents } from "./calendar.js";
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
    name: "get_upcoming_events",
    description:
      "Get upcoming events from the user's Apple Calendar. Returns events starting within the next N hours. Use this when the user asks what's on their calendar, what they have coming up, or anything about their schedule.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        hours: {
          type: Type.INTEGER,
          description: "How many hours ahead to look. Default is 24. Max is 168 (one week).",
        },
      },
    },
  },
  {
    name: "get_todays_events",
    description:
      "Get all events on the user's Apple Calendar for today (from midnight to midnight local time). Use this when the user asks about today's schedule, plans for today, or what's on today.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
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
  {
    name: "google_maps",
    description:
      "Search Google Maps and return structured top results and a short summary. Use this for places, businesses, addresses, and location-specific queries.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Maps search query" },
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
    case "get_upcoming_events":
      return handleGetUpcomingEvents(args);
    case "get_todays_events":
      return handleGetTodaysEvents();
    case "google_search":
      return handleGoogleSearch(args, ctx);
    case "google_maps":
      return handleGoogleMaps(args, ctx);
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

function handleGetUpcomingEvents(args: Record<string, unknown>): ToolResult {
  const hours = typeof args.hours === "number" && args.hours > 0 ? Math.min(168, Math.floor(args.hours)) : 24;
  try {
    const events = getUpcomingEvents(hours, appConfig.calendarName);
    return {
      payload: { ok: true, events, count: events.length },
      log: `get_upcoming_events: ${events.length} events in next ${hours}h`,
    };
  } catch (error) {
    return {
      payload: { ok: false, error: toErrorMessage(error) },
      log: `get_upcoming_events error: ${toErrorMessage(error)}`,
    };
  }
}

function handleGetTodaysEvents(): ToolResult {
  try {
    const events = getTodaysEvents(appConfig.calendarName);
    return {
      payload: { ok: true, events, count: events.length },
      log: `get_todays_events: ${events.length} events today`,
    };
  } catch (error) {
    return {
      payload: { ok: false, error: toErrorMessage(error) },
      log: `get_todays_events error: ${toErrorMessage(error)}`,
    };
  }
}

async function handleGoogleSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(10, Math.floor(args.limit)) : 5;
  if (!query) return { payload: { ok: false, error: "query is required" } };

  try {
    const parsed = await runGoogleSearchSubagent(query, limit);

    return {
      payload: {
        ok: true,
        query,
        results: parsed.results,
        summary: parsed.summary,
      },
      log: `google_search: ${query} -> ${parsed.results.length} results`,
    };
  } catch (error) {
    return {
      payload: { ok: false, error: toErrorMessage(error) },
      log: `google_search error: ${toErrorMessage(error)}`,
    };
  }
}

async function handleGoogleMaps(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(10, Math.floor(args.limit)) : 5;
  if (!query) return { payload: { ok: false, error: "query is required" } };

  try {
    const parsed = await runGoogleMapsSubagent(query, limit);

    return {
      payload: {
        ok: true,
        query,
        results: parsed.results,
        summary: parsed.summary,
      },
      log: `google_maps: ${query} -> ${parsed.results.length} results`,
    };
  } catch (error) {
    return {
      payload: { ok: false, error: toErrorMessage(error) },
      log: `google_maps error: ${toErrorMessage(error)}`,
    };
  }
}

interface GoogleSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

interface GoogleMapsResultItem {
  name: string;
  address: string;
  url: string;
}

async function runGoogleSearchSubagent(
  query: string,
  limit: number
): Promise<{ summary: string; results: GoogleSearchResultItem[] }> {
  const responseSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
          },
          required: ["title", "url", "snippet"],
        },
      },
    },
    required: ["summary", "results"],
  };

  const response = await ai.models.generateContent({
    model: appConfig.geminiModel,
    config: {
      systemInstruction:
        "Use the google_search tool to find current results. Respond only with JSON containing summary and results (title, url, snippet).",
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
    contents: [
      {
        role: "user",
        parts: [{ text: `Search the web for: ${query}. Return up to ${limit} results.` }],
      },
    ],
  });

  const rawText =
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? "";
  const parsed = parseSearchResponse(rawText, limit);
  if (!parsed) {
    throw new Error("google search returned an unreadable response");
  }

  return parsed;
}

async function runGoogleMapsSubagent(
  query: string,
  limit: number
): Promise<{ summary: string; results: GoogleMapsResultItem[] }> {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-lite",
    config: {
      systemInstruction:
        "Use the google_maps tool to find current places and answer concisely.",
      tools: [{ googleMaps: {} }],
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
    contents: [
      {
        role: "user",
        parts: [{ text: `Search Google Maps for: ${query}. Return up to ${limit} results.` }],
      },
    ],
  });

  const rawText =
    response.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? "";
  const results = extractMapsResultsFromGrounding(response.candidates?.[0]?.groundingMetadata, limit);
  const summary = rawText || summarizeMapsResults(results);
  if (!summary && results.length === 0) {
    throw new Error("google maps returned an empty response");
  }

  return { summary, results };
}

function parseSearchResponse(rawText: string, limit: number): { summary: string; results: GoogleSearchResultItem[] } | null {
  const jsonText = extractJsonPayload(rawText);
  if (!jsonText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { summary?: unknown; results?: unknown };
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const results = normalizeSearchResults(record.results, limit);
  if (!summary && results.length === 0) return null;

  return { summary, results };
}

function extractJsonPayload(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function normalizeSearchResults(raw: unknown, limit: number): GoogleSearchResultItem[] {
  if (!Array.isArray(raw)) return [];

  const results: GoogleSearchResultItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as { title?: unknown; url?: unknown; snippet?: unknown };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const snippet = typeof record.snippet === "string" ? record.snippet.trim() : "";
    if (!title || !url) continue;
    results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }

  return results;
}

function extractMapsResultsFromGrounding(grounding: unknown, limit: number): GoogleMapsResultItem[] {
  if (!grounding || typeof grounding !== "object") return [];
  const record = grounding as { groundingChunks?: unknown };
  if (!Array.isArray(record.groundingChunks)) return [];

  const results: GoogleMapsResultItem[] = [];
  for (const chunk of record.groundingChunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const maps = (chunk as { maps?: unknown }).maps;
    if (!maps || typeof maps !== "object") continue;
    const mapsRecord = maps as { title?: unknown; uri?: unknown; text?: unknown };
    const name = typeof mapsRecord.title === "string" ? mapsRecord.title.trim() : "";
    const url = typeof mapsRecord.uri === "string" ? mapsRecord.uri.trim() : "";
    const address = typeof mapsRecord.text === "string" ? mapsRecord.text.trim() : "";
    if (!name) continue;
    results.push({ name, address, url });
    if (results.length >= limit) break;
  }

  return results;
}

function summarizeMapsResults(results: GoogleMapsResultItem[]): string {
  if (results.length === 0) return "";
  const names = results
    .map((result) => result.name)
    .filter((name) => name.length > 0)
    .slice(0, 3);
  if (names.length === 0) return "";
  return `top picks: ${names.join(", ")}`;
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
