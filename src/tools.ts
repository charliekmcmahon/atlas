import { Type, type FunctionDeclaration } from "@google/genai";
import type { MemoryStore, Reminder, UserProfile } from "./db.js";

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
    default:
      return {
        payload: { error: `unknown tool: ${name}` },
        log: `unknown tool: ${name}`,
      };
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
