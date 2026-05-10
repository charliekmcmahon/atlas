import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant";

export interface ConversationTurn {
  role: Role;
  text: string;
  createdAt: string;
}

export interface MemoryNote {
  kind: string;
  note: string;
  updatedAt: string;
}

export interface UserProfile {
  name: string | null;
  location: string | null;
  timezone: string | null;
  language: string | null;
  updatedAt: string | null;
}

export type ProfileField = keyof Omit<UserProfile, "updatedAt">;

export interface Reminder {
  id: number;
  contact: string;
  chatId: string | null;
  text: string;
  dueAt: string;
  createdAt: string;
  sentAt: string | null;
  cancelledAt: string | null;
}

interface IncomingMessageRecord {
  messageId: string;
  contact: string;
  chatId: string | null;
  text: string | null;
  hasAttachments: boolean;
  createdAt: string;
}

interface AssistantMessageRecord {
  messageId: string;
  contact: string;
  chatId: string | null;
  text: string;
  createdAt: string;
}

interface ExtractedMemory {
  kind: string;
  note: string;
}

interface CreateReminderInput {
  contact: string;
  chatId: string | null;
  text: string;
  dueAt: string;
}

const PROFILE_FIELDS: readonly ProfileField[] = ["name", "location", "timezone", "language"];

export class MemoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  registerIncomingMessage(record: IncomingMessageRecord): boolean {
    const stmt = this.db.prepare(
      `
      INSERT OR IGNORE INTO messages (
        message_id,
        contact,
        role,
        chat_id,
        text,
        has_attachments,
        is_read,
        created_at
      ) VALUES (?, ?, 'user', ?, ?, ?, 0, ?)
      `
    );

    const result = stmt.run(
      record.messageId,
      record.contact,
      record.chatId,
      record.text,
      record.hasAttachments ? 1 : 0,
      record.createdAt
    );

    return result.changes > 0;
  }

  markMessageRead(messageId: string, readAtIso: string): void {
    const stmt = this.db.prepare(
      `
      UPDATE messages
      SET is_read = 1,
          read_at = ?
      WHERE message_id = ?
      `
    );

    stmt.run(readAtIso, messageId);
  }

  storeAssistantMessage(record: AssistantMessageRecord): void {
    const stmt = this.db.prepare(
      `
      INSERT OR REPLACE INTO messages (
        message_id,
        contact,
        role,
        chat_id,
        text,
        has_attachments,
        is_read,
        created_at,
        read_at
      ) VALUES (?, ?, 'assistant', ?, ?, 0, 1, ?, ?)
      `
    );

    stmt.run(record.messageId, record.contact, record.chatId, record.text, record.createdAt, record.createdAt);
  }

  extractAndStoreMemories(contact: string, text: string, sourceMessageId: string): void {
    const memories = MemoryStore.extractMemoryHints(text);
    if (memories.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `
      INSERT INTO memories (
        contact,
        kind,
        note,
        source_message_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact, note)
      DO UPDATE SET
        updated_at = excluded.updated_at,
        source_message_id = excluded.source_message_id,
        kind = excluded.kind
      `
    );

    const tx = this.db.transaction((rows: ExtractedMemory[]) => {
      for (const row of rows) {
        upsert.run(contact, row.kind, row.note, sourceMessageId, now, now);
      }
    });

    tx(memories);
  }

  recentConversation(contact: string, limit = 12): ConversationTurn[] {
    const stmt = this.db.prepare(
      `
      SELECT role, text, created_at
      FROM messages
      WHERE contact = ?
        AND role IN ('user', 'assistant')
        AND text IS NOT NULL
        AND length(trim(text)) > 0
      ORDER BY datetime(created_at) DESC
      LIMIT ?
      `
    );

    const rows = stmt.all(contact, limit) as Array<{
      role: Role;
      text: string;
      created_at: string;
    }>;

    return rows
      .reverse()
      .map((row) => ({ role: row.role, text: row.text, createdAt: row.created_at }));
  }

  getMemories(contact: string, limit = 8): MemoryNote[] {
    const stmt = this.db.prepare(
      `
      SELECT kind, note, updated_at
      FROM memories
      WHERE contact = ?
      ORDER BY datetime(updated_at) DESC
      LIMIT ?
      `
    );

    const rows = stmt.all(contact, limit) as Array<{ kind: string; note: string; updated_at: string }>;
    return rows.map((row) => ({ kind: row.kind, note: row.note, updatedAt: row.updated_at }));
  }

  getProfile(contact: string): UserProfile {
    const stmt = this.db.prepare(
      `SELECT name, location, timezone, language, updated_at FROM profiles WHERE contact = ?`
    );
    const row = stmt.get(contact) as
      | {
          name: string | null;
          location: string | null;
          timezone: string | null;
          language: string | null;
          updated_at: string | null;
        }
      | undefined;

    if (!row) {
      return { name: null, location: null, timezone: null, language: null, updatedAt: null };
    }
    return {
      name: row.name,
      location: row.location,
      timezone: row.timezone,
      language: row.language,
      updatedAt: row.updated_at,
    };
  }

  setProfileFields(contact: string, fields: Partial<Record<ProfileField, string>>): UserProfile {
    const provided = PROFILE_FIELDS.filter((field) => {
      const value = fields[field];
      return typeof value === "string" && value.trim().length > 0;
    });

    if (provided.length === 0) {
      return this.getProfile(contact);
    }

    const now = new Date().toISOString();
    const cleaned: Record<string, string> = {};
    for (const field of provided) {
      cleaned[field] = (fields[field] as string).trim();
    }

    const insertCols = ["contact", ...provided, "updated_at"];
    const insertPlaceholders = insertCols.map(() => "?").join(", ");
    const updateAssignments = [...provided.map((field) => `${field} = excluded.${field}`), "updated_at = excluded.updated_at"].join(", ");

    const stmt = this.db.prepare(
      `
      INSERT INTO profiles (${insertCols.join(", ")})
      VALUES (${insertPlaceholders})
      ON CONFLICT(contact) DO UPDATE SET
        ${updateAssignments}
      `
    );

    const values: unknown[] = [contact, ...provided.map((field) => cleaned[field]), now];
    stmt.run(...values);

    return this.getProfile(contact);
  }

  createReminder(input: CreateReminderInput): Reminder {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `
      INSERT INTO reminders (contact, chat_id, text, due_at, created_at)
      VALUES (?, ?, ?, ?, ?)
      `
    );
    const result = stmt.run(input.contact, input.chatId, input.text, input.dueAt, now);
    const id = Number(result.lastInsertRowid);
    return {
      id,
      contact: input.contact,
      chatId: input.chatId,
      text: input.text,
      dueAt: input.dueAt,
      createdAt: now,
      sentAt: null,
      cancelledAt: null,
    };
  }

  listPendingReminders(contact: string): Reminder[] {
    const stmt = this.db.prepare(
      `
      SELECT id, contact, chat_id, text, due_at, created_at, sent_at, cancelled_at
      FROM reminders
      WHERE contact = ?
        AND sent_at IS NULL
        AND cancelled_at IS NULL
      ORDER BY datetime(due_at) ASC
      `
    );
    const rows = stmt.all(contact) as Array<{
      id: number;
      contact: string;
      chat_id: string | null;
      text: string;
      due_at: string;
      created_at: string;
      sent_at: string | null;
      cancelled_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      contact: row.contact,
      chatId: row.chat_id,
      text: row.text,
      dueAt: row.due_at,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      cancelledAt: row.cancelled_at,
    }));
  }

  getDueReminders(nowIso: string): Reminder[] {
    const stmt = this.db.prepare(
      `
      SELECT id, contact, chat_id, text, due_at, created_at, sent_at, cancelled_at
      FROM reminders
      WHERE sent_at IS NULL
        AND cancelled_at IS NULL
        AND datetime(due_at) <= datetime(?)
      ORDER BY datetime(due_at) ASC
      `
    );
    const rows = stmt.all(nowIso) as Array<{
      id: number;
      contact: string;
      chat_id: string | null;
      text: string;
      due_at: string;
      created_at: string;
      sent_at: string | null;
      cancelled_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      contact: row.contact,
      chatId: row.chat_id,
      text: row.text,
      dueAt: row.due_at,
      createdAt: row.created_at,
      sentAt: row.sent_at,
      cancelledAt: row.cancelled_at,
    }));
  }

  markReminderSent(id: number, sentAtIso: string): void {
    const stmt = this.db.prepare(`UPDATE reminders SET sent_at = ? WHERE id = ?`);
    stmt.run(sentAtIso, id);
  }

  cancelReminder(contact: string, id: number): boolean {
    const stmt = this.db.prepare(
      `
      UPDATE reminders
      SET cancelled_at = ?
      WHERE id = ?
        AND contact = ?
        AND sent_at IS NULL
        AND cancelled_at IS NULL
      `
    );
    const result = stmt.run(new Date().toISOString(), id, contact);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id TEXT PRIMARY KEY,
        contact TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        chat_id TEXT,
        text TEXT,
        has_attachments INTEGER NOT NULL DEFAULT 0,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        read_at TEXT
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT NOT NULL,
        source_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(contact, note)
      );

      CREATE TABLE IF NOT EXISTS profiles (
        contact TEXT PRIMARY KEY,
        name TEXT,
        location TEXT,
        timezone TEXT,
        language TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact TEXT NOT NULL,
        chat_id TEXT,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        cancelled_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_contact_created
        ON messages(contact, datetime(created_at) DESC);

      CREATE INDEX IF NOT EXISTS idx_memories_contact_updated
        ON memories(contact, datetime(updated_at) DESC);

      CREATE INDEX IF NOT EXISTS idx_reminders_pending_due
        ON reminders(due_at)
        WHERE sent_at IS NULL AND cancelled_at IS NULL;
    `);
  }

  private static extractMemoryHints(text: string): ExtractedMemory[] {
    const normalized = text.trim();
    if (normalized.length < 3) {
      return [];
    }

    const patterns: Array<{
      kind: string;
      regex: RegExp;
      format: (match: RegExpMatchArray) => string;
    }> = [
      {
        kind: "identity",
        regex: /\b(?:my name is|call me)\s+([a-z][a-z\s'\-]{1,40})/i,
        format: (match) => `their name is ${cleanText(match[1])}`,
      },
      {
        kind: "location",
        regex: /\bi live in\s+([a-z0-9 ,.'\-]{2,60})/i,
        format: (match) => `they live in ${cleanText(match[1])}`,
      },
      {
        kind: "work",
        regex: /\bi work (?:as|at)\s+([a-z0-9 ,.'\-]{2,70})/i,
        format: (match) => `they work ${cleanText(match[1])}`,
      },
      {
        kind: "preference",
        regex: /\bi (?:really )?(love|like|prefer)\s+([a-z0-9 ,.'\-]{2,70})/i,
        format: (match) => `they ${match[1].toLowerCase()} ${cleanText(match[2])}`,
      },
      {
        kind: "dislike",
        regex: /\bi (?:really )?(hate|dislike)\s+([a-z0-9 ,.'\-]{2,70})/i,
        format: (match) => `they ${match[1].toLowerCase()} ${cleanText(match[2])}`,
      },
      {
        kind: "timezone",
        regex: /\bmy timezone is\s+([a-z0-9_./+\-]{2,40})/i,
        format: (match) => `their timezone is ${cleanText(match[1])}`,
      },
    ];

    const found = new Map<string, ExtractedMemory>();
    for (const pattern of patterns) {
      const match = normalized.match(pattern.regex);
      if (!match) {
        continue;
      }

      const note = pattern.format(match).slice(0, 120);
      if (!note) {
        continue;
      }

      found.set(note.toLowerCase(), { kind: pattern.kind, note });
    }

    return [...found.values()];
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
