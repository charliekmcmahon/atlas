import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");

export interface IncomingMessage {
  rowid: number;
  handleId: string;
  text: string;
}

export function getMaxRowId(): number {
  const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS max_rowid FROM message").get() as {
      max_rowid: number;
    };
    return row.max_rowid;
  } finally {
    db.close();
  }
}

export function getNewIncomingMessages(contact: string, sinceRowId: number): IncomingMessage[] {
  const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `
        SELECT
          message.ROWID        AS rowid,
          COALESCE(handle.id, '') AS handleId,
          message.text
        FROM message
        LEFT JOIN handle ON message.handle_id = handle.ROWID
        WHERE handle.id = ?
          AND message.is_from_me = 0
          AND message.text IS NOT NULL
          AND TRIM(message.text) != ''
          AND message.ROWID > ?
        ORDER BY message.ROWID ASC
        `
      )
      .all(contact, sinceRowId) as IncomingMessage[];
    return rows;
  } finally {
    db.close();
  }
}
