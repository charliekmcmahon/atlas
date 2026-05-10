import type { MemoryStore, Reminder } from "./db.js";

export type ReminderDeliverer = (reminder: Reminder) => Promise<void>;

interface ReminderSchedulerOptions {
  store: MemoryStore;
  deliver: ReminderDeliverer;
  intervalMs?: number;
  onError?: (error: unknown, reminder: Reminder) => void;
}

// Polls the reminders table and fires anything that's due.
// Reminders that came due while atlas was offline fire on the first tick.
export class ReminderScheduler {
  private readonly store: MemoryStore;
  private readonly deliver: ReminderDeliverer;
  private readonly intervalMs: number;
  private readonly onError: (error: unknown, reminder: Reminder) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: ReminderSchedulerOptions) {
    this.store = opts.store;
    this.deliver = opts.deliver;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.onError =
      opts.onError ??
      ((error, reminder) =>
        console.error(`[atlas] reminder ${reminder.id} delivery failed:`, toErrorMessage(error)));
  }

  start(): void {
    if (this.timer) return;
    // Fire once immediately to flush any reminders that came due while offline.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
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
      const nowIso = new Date().toISOString();
      const due = this.store.getDueReminders(nowIso);
      for (const reminder of due) {
        try {
          await this.deliver(reminder);
          this.store.markReminderSent(reminder.id, new Date().toISOString());
        } catch (error) {
          this.onError(error, reminder);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
