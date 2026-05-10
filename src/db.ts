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

      CREATE INDEX IF NOT EXISTS idx_messages_contact_created
        ON messages(contact, datetime(created_at) DESC);

      CREATE INDEX IF NOT EXISTS idx_memories_contact_updated
        ON memories(contact, datetime(updated_at) DESC);
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
