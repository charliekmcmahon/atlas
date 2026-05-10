# Atlas

A small iMessage chatbot. Listens for incoming messages from a single
allowlisted contact, generates a reply with Gemini, and sends it back over
iMessage. Includes per-contact long-term memory in SQLite.

Atlas does **not** talk to `chat.db` or `osascript` directly. It is a thin
client of [`imessage-api-catalina`][api] — a separate local-network REST +
SSE server that owns the Messages.app integration. This separation means
atlas itself is a portable, public-friendly Node service: the macOS-specific
plumbing lives in imessage-api-catalina, the Gemini logic lives here.

[api]: https://github.com/charliekmcmahon/imessage-api-catalina

```
┌────────────┐   SSE /events    ┌─────────────────────────┐   AppleScript   ┌──────────────┐
│   atlas    │ ◄─────────────── │  imessage-api-catalina  │ ──────────────► │ Messages.app │
│   (this)   │ ───────────────► │       (port 8787)       │ ◄────────────── │   chat.db    │
│            │   POST /send     │                         │   read-only DB  │              │
└────────────┘                  └─────────────────────────┘                 └──────────────┘
       │
       └──► Gemini API (text + multimodal)
       └──► local SQLite (memories, conversation log)
```

## What it does

- subscribes to imessage-api-catalina's `/events` SSE stream and reacts to inbound
  messages from the allowlisted contact
- queries Gemini (`gemini-2.5-flash` by default) with system prompt + recent
  conversation + extracted memories + user profile + any attachments
- splits long replies on whitespace and sends each chunk through
  imessage-api-catalina's `POST /send`
- extracts simple durable facts (name, location, timezone, preferences) from
  user messages and persists them per contact
- maintains a structured **user profile** (name, location, timezone, language)
  that Gemini fills in over time via a `set_user_info` function tool — atlas
  only asks for missing fields when they're actually needed (e.g. timezone
  before scheduling a reminder)
- supports **reminders** via a `set_reminder` function tool — Gemini parses
  natural-language requests like "remind me to call mom in 2 hours" and atlas
  fires the reminder back over iMessage at the scheduled time. Pending
  reminders persist in SQLite and survive `/reboot`s.
- has a `cli` mode for prompt iteration without sending anything over iMessage
- supports a small set of `/` commands over iMessage (see below)

## Requirements

- Node.js 18+
- A running [`imessage-api-catalina`][api] instance (typically on the same
  Mac that owns the Apple ID — atlas itself can run anywhere that can reach
  it)
- A Gemini API key

## Install

```bash
git clone https://github.com/<you>/atlas.git
cd atlas
npm install
cp .env.example .env
$EDITOR .env
```

Required env keys:

- `GEMINI_API_KEY`
- `IMESSAGE_API_URL` (e.g. `http://localhost:8787`)
- `IMESSAGE_API_KEY` (must match the server's `API_KEY`)
- `ALLOWED_CONTACT` — only required for `imessage` mode

## Run

iMessage mode:

```bash
npm run imessage
# or, after `npm run build`:
npm start
```

Local CLI (no iMessage involved):

```bash
npm run cli
```

CLI commands: `/help`, `/file <path>`, `/files`, `/clearfiles`, `/exit`.

## Chat commands (iMessage mode)

When started via `start.sh`, the wrapper acts as a supervisor. Send these
over iMessage from the allowlisted contact:

| command   | effect                                                              |
| --------- | ------------------------------------------------------------------- |
| `/ping`   | Replies `pong`. Liveness check.                                     |
| `/reboot` | Acks, exits with code 42. `start.sh` then `git pull`s, reinstalls,  |
|           | rebuilds, and relaunches. Use this to ship prompt/code updates.     |

Unknown slash commands fall through to Gemini, so feel free to text `/foo`
and ask it what you meant.

## Configuration reference

See `.env.example` for the full list. Notable knobs:

| key                    | default                  | purpose                                          |
| ---------------------- | ------------------------ | ------------------------------------------------ |
| `GEMINI_MODEL`         | `gemini-2.5-flash`       | Any model your key has access to                 |
| `STARTUP_MESSAGE`      | _(unset)_                | If set, sent on boot so you know it's alive      |
| `MAX_IMESSAGE_CHUNK`   | `1000`                   | Soft cap per outbound message                    |
| `MAX_ATTACHMENT_BYTES` | `20971520` (20 MiB)      | Skip Gemini file uploads larger than this        |
| `MEMORY_DB_PATH`       | `./data/memories.sqlite` | Local SQLite store                               |
| `REMINDER_TICK_MS`     | `30000`                  | How often to poll for due reminders              |
| `DEBUG`                | `false`                  | Verbose logging                                  |

## How memory works

`data/memories.sqlite` (created on first run) holds four tables:

- `messages` — full user/assistant transcript per contact, with read state
- `memories` — extracted durable facts keyed by contact, deduped by note text
- `profiles` — structured per-contact slots: name, location, timezone, language
- `reminders` — pending and past reminders with due/sent/cancelled timestamps

Memory extraction uses simple regex patterns (`my name is …`, `i live in …`,
etc.). It is intentionally conservative — Gemini gets the recent transcript
in addition to memories, so anything missed by the regex is still in context.

The `profiles` table is filled in by Gemini via the `set_user_info` function
tool whenever the user shares one of the four slot values in passing. The
system prompt tells the model not to interrogate the user — it should only
ask for a missing slot when it's needed (e.g. timezone before scheduling a
reminder).

## How reminders work

Gemini has access to `set_reminder(text, due_at)`, `list_reminders()`, and
`cancel_reminder(id)` function tools. When the user asks to be reminded of
something, the model resolves the time to an ISO 8601 timestamp in the
user's timezone and calls `set_reminder`. A background poller (every
`REMINDER_TICK_MS`, default 30s) checks for due reminders and sends them
over iMessage. Reminders that come due while atlas is offline fire on the
first tick after restart.

## License

MIT.
