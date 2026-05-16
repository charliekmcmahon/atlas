import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CalendarEvent {
  uid: string;       // uid|startMs — unique per occurrence
  summary: string;
  startDate: string; // ISO 8601 UTC
  endDate: string;   // ISO 8601 UTC
  location: string | null;
  notes: string | null;
  allDay: boolean;
}

// Written to a temp file and run via `osascript -l JavaScript` to avoid
// shell-quoting issues with long scripts.
function buildJxaScript(fromMs: number, toMs: number, calendarName: string): string {
  return `
function run() {
  var cal = Application("Calendar");
  var targetName = ${JSON.stringify(calendarName)};
  var targetLower = targetName.toLowerCase();

  // List all calendar names for diagnostics
  var allCalendars = cal.calendars();
  var allNames = allCalendars.map(function(c) { try { return c.name(); } catch(e) { return ""; } });

  // First try exact match, then case-insensitive fallback
  var targetCal = null;
  for (var i = 0; i < allCalendars.length; i++) {
    if (allNames[i] === targetName) { targetCal = allCalendars[i]; break; }
  }
  if (!targetCal) {
    for (var i = 0; i < allCalendars.length; i++) {
      if (allNames[i].toLowerCase() === targetLower) { targetCal = allCalendars[i]; break; }
    }
  }

  if (!targetCal) {
    return JSON.stringify({
      error: "calendar not found: " + targetName,
      availableCalendars: allNames.filter(function(n) { return n.length > 0; })
    });
  }

  var from = ${fromMs};
  var to = ${toMs};
  var events = [];
  var seen = {};

  try {
    var allEvents = targetCal.events();
    for (var i = 0; i < allEvents.length && i < 600; i++) {
      try {
        var evt = allEvents[i];
        var startMs = evt.startDate().getTime();
        if (startMs < from || startMs > to) continue;

        var uid = "";
        try { uid = evt.uid() || ""; } catch(e) {}

        var key = uid + "|" + startMs;
        if (seen[key]) continue;
        seen[key] = true;

        var endMs = startMs;
        try { endMs = evt.endDate().getTime(); } catch(e) {}

        var loc = null;
        try { var l = evt.location(); if (l && l.length > 0) loc = l; } catch(e) {}

        var notes = null;
        try { var n = evt.description(); if (n && n.length > 0) notes = n; } catch(e) {}

        var allDay = false;
        try { allDay = evt.alldayEvent() === true; } catch(e) {}

        var summary = "(no title)";
        try { summary = evt.summary() || "(no title)"; } catch(e) {}

        events.push({
          uid: key,
          summary: summary,
          startDate: new Date(startMs).toISOString(),
          endDate: new Date(endMs).toISOString(),
          location: loc,
          notes: notes,
          allDay: allDay
        });
      } catch(innerErr) {}
    }
  } catch(err) {
    return JSON.stringify({ error: String(err) });
  }

  events.sort(function(a, b) { return a.startDate < b.startDate ? -1 : 1; });
  return JSON.stringify({ events: events });
}
`;
}

// Lists all calendar names visible to the Calendar app. Used at startup for diagnostics.
function buildListCalendarsScript(): string {
  return `
function run() {
  var cal = Application("Calendar");
  var names = cal.calendars().map(function(c) { try { return c.name(); } catch(e) { return ""; } });
  return JSON.stringify({ names: names.filter(function(n) { return n.length > 0; }) });
}
`;
}

function runJxaScript(script: string): unknown {
  const scriptPath = join(tmpdir(), `atlas-calendar-${process.pid}-${Date.now()}.js`);
  try {
    writeFileSync(scriptPath, script, "utf-8");
    const raw = execFileSync("osascript", ["-l", "JavaScript", scriptPath], {
      timeout: 20_000,
      encoding: "utf-8",
    }).trim();
    return JSON.parse(raw);
  } finally {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }
}

export function listCalendarNames(): string[] {
  try {
    const result = runJxaScript(buildListCalendarsScript()) as { names?: string[] };
    return Array.isArray(result?.names) ? result.names : [];
  } catch {
    return [];
  }
}

export function getCalendarEvents(fromMs: number, toMs: number, calendarName: string): CalendarEvent[] {
  const script = buildJxaScript(fromMs, toMs, calendarName);
  const parsed = runJxaScript(script) as { error?: unknown; availableCalendars?: string[]; events?: unknown };

  if (parsed.error) {
    const hint = Array.isArray(parsed.availableCalendars) && parsed.availableCalendars.length > 0
      ? ` (available: ${parsed.availableCalendars.join(", ")})`
      : "";
    throw new Error(String(parsed.error) + hint);
  }

  if (!Array.isArray(parsed.events)) return [];
  return parsed.events.filter(isValidCalendarEvent);
}

export function getUpcomingEvents(hoursAhead: number, calendarName: string): CalendarEvent[] {
  const now = Date.now();
  return getCalendarEvents(now, now + hoursAhead * 3_600_000, calendarName);
}

export function getTodaysEvents(calendarName: string): CalendarEvent[] {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  return getCalendarEvents(startOfDay.getTime(), endOfDay.getTime(), calendarName);
}

function isValidCalendarEvent(item: unknown): item is CalendarEvent {
  if (!item || typeof item !== "object") return false;
  const r = item as Record<string, unknown>;
  return (
    typeof r.uid === "string" &&
    typeof r.summary === "string" &&
    typeof r.startDate === "string" &&
    typeof r.endDate === "string"
  );
}
