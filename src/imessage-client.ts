// HTTP + SSE client for the imessage-api-catalina server.
// Contract: bearer auth on every request, JSON bodies, SSE event stream for inbound.

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export interface IMessage {
  rowId: number;
  id: string | null;
  text: string | null;
  participant: string | null;
  chatId: string | null;
  chatKind: "group" | "dm" | "unknown";
  service: string | null;
  kind: "text" | "reaction";
  isFromMe: boolean;
  isRead: boolean;
  isSent: boolean;
  isDelivered: boolean;
  createdAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  hasAttachments: boolean;
}

export interface IMessageClientConfig {
  baseUrl: string;
  apiKey: string;
}

export type SseEvent =
  | { type: "hello"; data: { ok: boolean; ts: number } }
  | { type: "ping"; data: number }
  | { type: "inbound"; data: IMessage }
  | { type: "outbound"; data: IMessage }
  | { type: "debug"; data: unknown };

export interface SseHandlers {
  onMessage?: (event: SseEvent) => void;
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onError?: (error: Error) => void;
}

interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

interface FetchResult {
  status: number;
  body: string;
}

function fetchJson(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res: IncomingMessage) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );

    req.on("error", reject);

    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error(`Request to ${url} timed out after ${opts.timeoutMs}ms`));
      });
    }

    if (opts.body) {
      req.write(opts.body);
    }

    req.end();
  });
}

export class IMessageClient {
  constructor(private readonly cfg: IMessageClientConfig) {}

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      ...extra,
    };
  }

  async health(timeoutMs = 5000): Promise<unknown> {
    const { status, body } = await fetchJson(`${this.cfg.baseUrl}/health`, {
      headers: this.authHeaders(),
      timeoutMs,
    });
    if (status < 200 || status >= 300) {
      throw new Error(`Health check failed (HTTP ${status}): ${body}`);
    }
    return JSON.parse(body);
  }

  async send(to: string, text: string, timeoutMs = 60000): Promise<unknown> {
    const body = JSON.stringify({ to, text });
    const { status, body: resBody } = await fetchJson(`${this.cfg.baseUrl}/send`, {
      method: "POST",
      headers: this.authHeaders({
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      }),
      body,
      timeoutMs,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Send failed (HTTP ${status}): ${resBody}`);
    }
    try {
      return JSON.parse(resBody);
    } catch {
      return null;
    }
  }

  async fetchMessages(
    params: {
      participant?: string;
      chatId?: string;
      isFromMe?: boolean;
      sinceISO?: string;
      beforeISO?: string;
      limit?: number;
      offset?: number;
      excludeReactions?: boolean;
    } = {},
    timeoutMs = 10000
  ): Promise<IMessage[]> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        search.set(key, String(value));
      }
    }
    const qs = search.toString();
    const url = `${this.cfg.baseUrl}/messages${qs ? `?${qs}` : ""}`;

    const { status, body } = await fetchJson(url, {
      headers: this.authHeaders(),
      timeoutMs,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Fetch messages failed (HTTP ${status}): ${body}`);
    }

    const parsed = JSON.parse(body) as { messages?: IMessage[] };
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  }

  // Subscribes to /events. Auto-reconnects with exponential backoff on disconnect.
  // Returns a stop() function that closes the stream and prevents reconnect.
  subscribe(handlers: SseHandlers): () => void {
    let stopped = false;
    let currentReq: ReturnType<typeof httpRequest> | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let backoffMs = 1000;
    const maxBackoffMs = 30000;

    const cleanup = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentReq) {
        try {
          currentReq.destroy();
        } catch {
          // ignore
        }
        currentReq = null;
      }
    };

    const scheduleReconnect = (reason: string) => {
      if (stopped) return;
      handlers.onDisconnect?.(reason);
      const delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopped) return;

      const parsed = new URL(`${this.cfg.baseUrl}/events`);
      const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;

      const req = requestFn(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: "GET",
          headers: this.authHeaders({
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
          }),
        },
        (res: IncomingMessage) => {
          if ((res.statusCode ?? 0) !== 200) {
            res.resume();
            scheduleReconnect(`HTTP ${res.statusCode ?? 0}`);
            return;
          }

          backoffMs = 1000;
          handlers.onConnect?.();

          let buffer = "";
          let currentEvent = "message";
          let currentData: string[] = [];

          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            // SSE: events delimited by blank line. Lines split by \n.
            let nlIdx: number;
            while ((nlIdx = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, nlIdx).replace(/\r$/, "");
              buffer = buffer.slice(nlIdx + 1);

              if (line === "") {
                if (currentData.length > 0) {
                  const payload = currentData.join("\n");
                  let data: unknown = payload;
                  try {
                    data = JSON.parse(payload);
                  } catch {
                    // leave as raw string
                  }
                  handlers.onMessage?.({
                    type: currentEvent,
                    data,
                  } as SseEvent);
                }
                currentEvent = "message";
                currentData = [];
                continue;
              }

              if (line.startsWith(":")) continue; // SSE comment
              if (line.startsWith("event:")) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                currentData.push(line.slice(5).replace(/^ /, ""));
              }
            }
          });

          res.on("end", () => scheduleReconnect("stream ended"));
          res.on("close", () => scheduleReconnect("stream closed"));
          res.on("error", (err: Error) => {
            handlers.onError?.(err);
            scheduleReconnect(`stream error: ${err.message}`);
          });
        }
      );

      req.on("error", (err: Error) => {
        handlers.onError?.(err);
        scheduleReconnect(`connect error: ${err.message}`);
      });

      req.end();
      currentReq = req;
    };

    connect();

    return () => {
      stopped = true;
      cleanup();
    };
  }
}
