import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { MemoryStore } from "./db.js";
import { getUpcomingEvents, getTodaysEvents, type CalendarEvent } from "./calendar.js";
import { runToolCall, toolDeclarations, type ToolContext } from "./tools.js";

const MAX_TOOL_ITERATIONS = 5;

// Tools the prep-message agent is allowed to use (research only, no side-effects).
const PREP_TOOL_NAMES = new Set(["google_search", "google_maps"]);

export interface CalendarWatcherOptions {
  store: MemoryStore;
  contact: string;
  chatId: string | null;
  calendarName: string;
  geminiApiKey: string;
  geminiModel: string;
  lookaheadHours?: number;  // how far ahead to sync events (default 48)
  intervalMs?: number;       // poll interval (default 5 min)
  deliver: (contact: string, chatId: string | null, text: string) => Promise<void>;
  onError?: (error: unknown, context: string) => void;
}

export class CalendarWatcher {
  private readonly store: MemoryStore;
  private readonly contact: string;
  private readonly chatId: string | null;
  private readonly calendarName: string;
  private readonly ai: GoogleGenAI;
  private readonly geminiModel: string;
  private readonly lookaheadHours: number;
  private readonly intervalMs: number;
  private readonly deliver: (contact: string, chatId: string | null, text: string) => Promise<void>;
  private readonly onError: (error: unknown, context: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: CalendarWatcherOptions) {
    this.store = opts.store;
    this.contact = opts.contact;
    this.chatId = opts.chatId;
    this.calendarName = opts.calendarName;
    this.ai = new GoogleGenAI({ apiKey: opts.geminiApiKey });
    this.geminiModel = opts.geminiModel;
    this.lookaheadHours = opts.lookaheadHours ?? 48;
    this.intervalMs = opts.intervalMs ?? 5 * 60_000;
    this.deliver = opts.deliver;
    this.onError = opts.onError ?? ((err, ctx) => console.error(`[atlas/calendar] ${ctx}:`, err));
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.syncUpcomingEvents();
      await this.deliverDueNotifications();
    } catch (error) {
      this.onError(error, "calendar tick");
    } finally {
      this.ticking = false;
    }
  }

  // Phase 1: discover new events and register their planned notify time.
  private async syncUpcomingEvents(): Promise<void> {
    let events: CalendarEvent[];
    try {
      // Lookahead for timed events + all-day events need a day extra (for "notify day before")
      events = getUpcomingEvents(this.lookaheadHours, this.calendarName);

      // Also grab today-start so we catch all-day events starting today (they may start at midnight UTC)
      const todayAllDay = getTodaysEvents(this.calendarName).filter((e) => e.allDay);
      const seen = new Set(events.map((e) => e.uid));
      for (const e of todayAllDay) {
        if (!seen.has(e.uid)) events.push(e);
      }
    } catch (error) {
      this.onError(error, "calendar read");
      return;
    }

    const nowMs = Date.now();
    for (const event of events) {
      const notifyAt = computeNotifyAt(event, nowMs);
      if (!notifyAt) continue;

      const isNew = this.store.registerCalendarEvent({
        contact: this.contact,
        chatId: this.chatId,
        eventUid: event.uid,
        eventData: JSON.stringify(event),
        notifyAt,
        allDay: event.allDay,
      });

      if (isNew) {
        console.log(`[atlas/calendar] queued: "${event.summary}" -> notify at ${notifyAt}`);
      }
    }
  }

  // Phase 2: for any due notifications, generate and send a prep message.
  private async deliverDueNotifications(): Promise<void> {
    const nowIso = new Date().toISOString();
    const due = this.store.getDueCalendarNotifications(nowIso);

    for (const notification of due) {
      // Mark sent immediately so a slow Gemini call doesn't re-trigger on the next tick.
      this.store.markCalendarNotificationSent(notification.id, nowIso);

      let event: CalendarEvent;
      try {
        event = JSON.parse(notification.eventData) as CalendarEvent;
      } catch {
        console.warn(`[atlas/calendar] could not parse event data for notification #${notification.id}`);
        continue;
      }

      try {
        const message = await this.generatePrepMessage(event);
        if (message.trim()) {
          await this.deliver(notification.contact, notification.chatId, message);
          console.log(`[atlas/calendar] sent prep for: "${event.summary}"`);
        }
      } catch (error) {
        this.onError(error, `prep message for "${event.summary}"`);
      }
    }
  }

  private async generatePrepMessage(event: CalendarEvent): Promise<string> {
    const profile = this.store.getProfile(this.contact);
    const tz = profile.timezone ?? "UTC";
    const userName = profile.name ?? "the user";

    const nowIso = new Date().toISOString();
    const minsUntil = Math.round((new Date(event.startDate).getTime() - Date.now()) / 60_000);
    const startLocal = formatEventTime(event.startDate, tz);
    const endLocal = formatEventTime(event.endDate, tz);

    const systemPrompt = [
      "you are atlas, a personal assistant texting over imessage.",
      "you spotted an upcoming event in the user's calendar and are proactively reaching out to help them prepare.",
      "",
      "style:",
      "- all lowercase, casual — like a real person texting",
      "- warm and practical, not stiff or corporate",
      "- no markdown formatting (imessage doesn't render it)",
      "- don't open with a greeting or the user's name",
      "- don't mention that you're automated, that you checked their calendar, or that you're an AI",
      "- sound like a smart, proactive friend who just thought of something useful",
      "",
      "what to do:",
      "- use google_search and/or google_maps tools if they'd give you genuinely useful info",
      "  - look up a location: get rough travel time, directions, parking, what to expect",
      "  - search for context on companies, people, venues, or topics if mentioned and relevant",
      "  - look up a restaurant/bar/venue to give atmosphere, cuisine, what to order",
      "  - skip searching for boring internal meetings (e.g. 'team standup') — not worth it",
      "- tell the user what the event is and when (in human terms, their local time)",
      "- if travel is involved, mention a rough 'leave by' time or travel time",
      "- share anything genuinely useful for preparation (things to bring, context, what to expect)",
      "- end with a helpful question or offer if there's something practical you could do",
      "  (e.g. 'want me to look up parking nearby?' or 'should i pull up their website?')",
      "- keep it tight — this is a text, not an essay. 2-4 short paragraphs max.",
      "",
      "output only the message text. no extra formatting, no intro, just the text to send.",
    ].join("\n");

    const userContent = [
      `current time (utc): ${nowIso}`,
      `user timezone: ${tz}`,
      `user name: ${userName}`,
      "",
      "upcoming calendar event:",
      `  title: ${event.summary}`,
      `  starts: ${startLocal} (in ~${minsUntil} min)`,
      `  ends: ${endLocal}`,
      `  location: ${event.location ?? "not specified"}`,
      `  notes/description: ${event.notes ?? "none"}`,
      `  all-day event: ${event.allDay}`,
      "",
      "generate the prep message now. use tools if they'd add real value.",
    ].join("\n");

    const searchTools = toolDeclarations.filter((t) => t.name != null && PREP_TOOL_NAMES.has(t.name));
    const toolCtx: ToolContext = { contact: this.contact, chatId: this.chatId, store: this.store };
    const contents: Content[] = [{ role: "user", parts: [{ text: userContent }] }];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await this.ai.models.generateContent({
        model: this.geminiModel,
        config: {
          systemInstruction: systemPrompt,
          tools: [{ functionDeclarations: searchTools }],
        },
        contents,
      });

      const candidate = response.candidates?.[0];
      const parts: Part[] = candidate?.content?.parts ?? [];
      const functionCalls = parts.filter((p) => p.functionCall);

      if (functionCalls.length === 0) {
        return parts
          .map((p) => p.text ?? "")
          .filter((t) => t.length > 0)
          .join("")
          .trim();
      }

      if (candidate?.content) contents.push(candidate.content);

      const responseParts: Part[] = [];
      for (const part of functionCalls) {
        const call = part.functionCall;
        if (!call?.name) continue;
        const args = (call.args ?? {}) as Record<string, unknown>;
        let result;
        try {
          result = await runToolCall(call.name, args, toolCtx);
        } catch (error) {
          result = { payload: { error: String(error) } };
        }
        if (result.log) console.log(`[atlas/calendar] tool ${call.name}: ${result.log}`);
        responseParts.push({ functionResponse: { name: call.name, response: result.payload } });
      }

      contents.push({ role: "user", parts: responseParts });
    }

    return "";
  }
}

// Determines when to send the prep message based on event characteristics.
// Returns an ISO timestamp, or null if the event is already past / too imminent.
function computeNotifyAt(event: CalendarEvent, nowMs: number): string | null {
  const startMs = new Date(event.startDate).getTime();

  if (event.allDay) {
    // Notify at 3pm local time the day before
    const prevDay = new Date(event.startDate);
    prevDay.setDate(prevDay.getDate() - 1);
    prevDay.setHours(15, 0, 0, 0);
    const notifyMs = prevDay.getTime();
    // If that's already past, skip (would be redundant noise)
    return notifyMs > nowMs ? prevDay.toISOString() : null;
  }

  const title = (event.summary ?? "").toLowerCase();
  const hasLocation = !!(event.location?.trim());

  // Lead time is determined by event type — most specific rules first
  let leadMs: number;

  if (/\b(flight|airport|terminal|departs?|departing)\b/.test(title)) {
    leadMs = 3 * 3_600_000; // 3 hours — flights need real prep time
  } else if (/\b(interview|presentation|keynote|pitch|demo|conference)\b/.test(title)) {
    leadMs = 2 * 3_600_000; // 2 hours — high-stakes events
  } else if (/\b(dinner|lunch|brunch|breakfast|coffee|drinks|date)\b/.test(title) && hasLocation) {
    leadMs = 90 * 60_000; // 90 min — food/social with travel
  } else if (hasLocation) {
    leadMs = 90 * 60_000; // 90 min for any in-person event
  } else if (/\b(standup|stand-up|daily|scrum|check-in|1:1|one.on.one)\b/.test(title)) {
    leadMs = 10 * 60_000; // 10 min — routine virtual meetings
  } else if (/\b(call|zoom|teams|meet|webinar|hangout|facetime)\b/.test(title)) {
    leadMs = 20 * 60_000; // 20 min — virtual meetings
  } else {
    leadMs = 60 * 60_000; // 60 min default
  }

  const notifyMs = startMs - leadMs;
  const minNotify = nowMs + 2 * 60_000; // must be at least 2 min from now

  if (notifyMs < minNotify) {
    // Event is starting soon and we've never notified — send immediately
    if (startMs > nowMs) return new Date(nowMs + 8_000).toISOString();
    return null; // already started, skip
  }

  return new Date(notifyMs).toISOString();
}

function formatEventTime(isoString: string, timezone: string): string {
  try {
    return new Date(isoString).toLocaleString("en-AU", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return isoString;
  }
}
