import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import { URL } from "node:url";

export interface ApiMessage {
  guid?: string;
  id?: number | string;
  text?: string;
  message?: string;
  is_sent?: boolean;
  sent?: boolean;
  date?: string | number;
  handle?: string;
  sender?: string;
}

export interface IMessageClientConfig {
  apiKey: string;
  baseUrl: string;
}

function httpFetch(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;

    const req = requestFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: opts.method ?? "GET",
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );

    req.on("error", reject);

    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => {
        req.destroy(new Error("Request timed out"));
      });
    }

    if (opts.body) {
      req.write(opts.body);
    }

    req.end();
  });
}

export async function discoverBaseUrl(candidates: readonly string[]): Promise<string> {
  for (const url of candidates) {
    try {
      const { status } = await httpFetch(`${url}/recent_contacts?num_contacts=1`, {
        headers: { "api-key": "probe" },
        timeoutMs: 3000,
      });
      // Any HTTP response (including 401 wrong key) means the server is up
      if (status > 0 && status < 600) {
        return url;
      }
    } catch {
      // server unreachable — try next
    }
  }
  throw new Error(`No iMessage API reachable. Tried: ${candidates.join(", ")}`);
}

export async function sendIMessage(
  config: IMessageClientConfig,
  recipient: string,
  message: string
): Promise<void> {
  const body = JSON.stringify({ recipient, message });
  const { status, body: resBody } = await httpFetch(`${config.baseUrl}/send?name=false`, {
    method: "POST",
    headers: {
      "api-key": config.apiKey,
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs: 15000,
  });

  if (status < 200 || status >= 300) {
    throw new Error(`Send failed (HTTP ${status}): ${resBody}`);
  }
}

export async function fetchMessages(
  config: IMessageClientConfig,
  contact: string,
  numMessages = 20
): Promise<ApiMessage[]> {
  const encoded = encodeURIComponent(contact);
  const { status, body } = await httpFetch(
    `${config.baseUrl}/messages/${encoded}?name=false&num_messages=${numMessages}&sent=true&formatted=true`,
    {
      headers: { "api-key": config.apiKey },
      timeoutMs: 10000,
    }
  );

  if (status === 404) {
    return [];
  }

  if (status < 200 || status >= 300) {
    throw new Error(`Fetch messages failed (HTTP ${status}): ${body}`);
  }

  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed as ApiMessage[];
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).messages)) {
      return (parsed as Record<string, unknown>).messages as ApiMessage[];
    }
    return [];
  } catch {
    return [];
  }
}

export function getMessageId(msg: ApiMessage): string {
  if (msg.guid) return String(msg.guid);
  if (msg.id != null) return String(msg.id);
  return `${msg.text ?? ""}\x00${msg.date ?? ""}`;
}

export function isIncoming(msg: ApiMessage): boolean {
  if (msg.is_sent != null) return !msg.is_sent;
  if (msg.sent != null) return !msg.sent;
  return true;
}

export function getMessageText(msg: ApiMessage): string {
  return msg.text ?? msg.message ?? "";
}

function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n");
}

// Sends via osascript using chat id (works on email-based iMessage accounts on High Sierra)
export function sendViaAppleScript(phone: string, message: string): Promise<void> {
  const chatId = `iMessage;-;${escapeAppleScript(phone)}`;
  const script = `tell application "Messages"\n    send "${escapeAppleScript(message)}" to chat id "${chatId}"\nend tell`;

  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
