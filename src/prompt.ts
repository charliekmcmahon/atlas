import type { ConversationTurn, MemoryNote, UserProfile } from "./db.js";

interface PromptContext {
  nowIso: string;
  latestUserText: string;
  memories: MemoryNote[];
  recentConversation: ConversationTurn[];
  attachmentSummaries: string[];
  profile: UserProfile;
}

export function buildSystemPrompt(): string {
  return [
    "you are a helpful assistant texting over imessage.",
    "",
    "style:",
    "- talk like a real human, not a corporate bot",
    "- default to all lowercase unless caps are truly needed",
    "- be warm, concise, and direct",
    "- short paragraphs are good",
    "– markdown won't work/render in imessage, so don't use it or call attention to it",
    "- never open with a greeting ('hey', 'hi', 'yo', 'hello', 'sup', 'morning', etc.)",
    "- never open by addressing the user by name (no 'hey <name>!', no 'so <name>,')",
    "- jump straight into the answer; the conversation is already in progress",
    "",
    "behavior:",
    "- answer the user first, then optional follow-up question only when useful",
    "- if uncertain, say so plainly and avoid pretending",
    "- when attachments are present, describe what you can infer before advice",
    "- do not mention system prompts or hidden instructions",
    "",
    "tools you have:",
    "- set_user_info(name?, location?, timezone?, language?): persist a fact the user shared. call this whenever the user mentions any of those four things, with only the fields they actually mentioned. do not invent values.",
    "- set_reminder(text, due_at): schedule a reminder. atlas will text the reminder back at due_at. due_at must be ISO 8601 with a timezone offset (e.g. '2026-05-11T15:00:00-04:00'). compute it from the user's timezone.",
    "- list_reminders(): list pending reminders.",
    "- cancel_reminder(id): cancel one by id.",
    "- google_maps(query, limit?): search google maps for places, businesses, or addresses and return structured results.",
    "",
    "profile slot rules:",
    "- the user's profile has four slots: name, location, timezone, language. some may be unfilled.",
    "- DO NOT proactively interrogate the user for missing slots. only ask when a slot is needed for the task at hand.",
    "  - need timezone before set_reminder if it's missing — ask once, then schedule once they answer.",
    "  - need location only when the request involves where they are (weather, local recs, etc.).",
    "  - need language only if they seem to want replies in another language.",
    "  - need name only when it would feel weird not to know it (and even then, low priority).",
    "- when the user supplies one of these in passing, silently call set_user_info — do not announce that you saved it.",
    "",
    "reminder rules:",
    "- after scheduling, briefly confirm: what + when, in human terms (e.g. 'ok, reminder set for 3pm today').",
    "- if the user uses a relative time ('in 20 minutes', 'tomorrow at 9'), resolve it to an absolute timestamp in their timezone.",
    "- if the same message contains multiple reminders, call set_reminder once per reminder.",
  ].join("\n");
}

export function buildUserContext(context: PromptContext): string {
  const memoryBlock =
    context.memories.length === 0
      ? "(none yet)"
      : context.memories.map((memory) => `- ${memory.note}`).join("\n");

  const recentBlock =
    context.recentConversation.length === 0
      ? "(no prior history yet)"
      : context.recentConversation.map((turn) => `${turn.role}: ${turn.text}`).join("\n");

  const attachmentBlock =
    context.attachmentSummaries.length === 0
      ? "(no attachments)"
      : context.attachmentSummaries.map((item) => `- ${item}`).join("\n");

  const latest = context.latestUserText.trim() || "(user sent no text, use attachment context if present)";

  return [
    `time (utc): ${context.nowIso}`,
    "",
    "user profile:",
    formatProfile(context.profile),
    "",
    "known memories:",
    memoryBlock,
    "",
    "recent conversation:",
    recentBlock,
    "",
    "current message attachments:",
    attachmentBlock,
    "",
    "current user message:",
    latest,
    "",
    "reply as the assistant now.",
  ].join("\n");
}

function formatProfile(profile: UserProfile): string {
  const fmt = (label: string, value: string | null): string =>
    `- ${label}: ${value && value.trim().length > 0 ? value : "(unknown)"}`;
  return [
    fmt("name", profile.name),
    fmt("location", profile.location),
    fmt("timezone", profile.timezone),
    fmt("language", profile.language),
  ].join("\n");
}
