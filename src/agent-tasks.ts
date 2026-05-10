import type { MemoryStore, AgentTask } from "./db.js";
import * as cronParser from "cron-parser";

export type AgentTaskDeliverer = (task: AgentTask) => Promise<void>;

interface AgentTaskSchedulerOptions {
  store: MemoryStore;
  deliver: AgentTaskDeliverer;
  intervalMs?: number;
  onError?: (error: unknown, task: AgentTask) => void;
}

export class AgentTaskScheduler {
  private readonly store: MemoryStore;
  private readonly deliver: AgentTaskDeliverer;
  private readonly intervalMs: number;
  private readonly onError: (error: unknown, task: AgentTask) => void;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: AgentTaskSchedulerOptions) {
    this.store = opts.store;
    this.deliver = opts.deliver;
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.onError = opts.onError ?? ((error) => console.error("[atlas] agent task delivery failed:", error));
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
      const nowIso = new Date().toISOString();
      const due = this.store.getDueAgentTasks(nowIso);
      for (const task of due) {
        try {
          await this.deliver(task);

          // compute next run: if task.schedule present, calculate next occurrence
          let nextRun: string | null = null;
          if (task.schedule) {
            try {
              const iter = (cronParser as any).parse(task.schedule, { currentDate: new Date() });
              nextRun = iter.next().toISOString();
            } catch (e) {
              console.error("[atlas] invalid cron for task", task.id, task.schedule, e);
              nextRun = null;
            }
          }

          this.store.markAgentTaskRun(task.id, new Date().toISOString(), nextRun);
        } catch (error) {
          this.onError(error, task);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

export function computeNextFromCron(schedule: string, from?: Date): string {
  const iter = (cronParser as any).parse(schedule, { currentDate: from ?? new Date() });
  return iter.next().toISOString();
}
