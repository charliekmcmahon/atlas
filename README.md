# iMessage Gemini Assistant

A local iMessage chatbot built with `@photon-ai/imessage-kit` and `@google/genai`.

## What It Does

- listens to iMessage direct messages in real time
- supports an interactive terminal chat mode (`cli`)
- only replies to one allowed contact (`ALLOWED_CONTACT`)
- uses `gemini-3-flash-preview` (or any model you set in env)
- supports multimodal user input by uploading incoming attachments to Gemini
- stores local memory and chat history in SQLite (`data/memories.sqlite` by default)
- sends a quick emoji reaction before generating the main reply
- marks messages as `read` in the local app database when reply generation begins
- speaks in a human, usually-lowercase texting style

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template and set your values:

```bash
cp .env.example .env
```

3. Required env values:

- `GEMINI_API_KEY`: your Gemini API key
- `ALLOWED_CONTACT`: required only in `imessage` mode

4. Run in iMessage mode (default):

```bash
npm run imessage
```

5. Run in terminal CLI mode:

```bash
npm run cli
```

6. Optional CLI commands:

- `/help`
- `/file <path>` queue an attachment for the next prompt
- `/files` show queued files
- `/clearfiles` clear queued files
- `/exit`

## Build + Run

```bash
npm run build
npm start
```

You can also set mode from env:

```bash
BOT_MODE=cli npm run dev
```

## Notes

- This project requires macOS with Messages.app signed in.
- `@photon-ai/imessage-kit` needs access to your Messages database (`~/Library/Messages/chat.db`).
- For multimodal analysis, only attachments with readable local paths can be uploaded.
- The base `imessage-kit` package does not expose true tapback/read-receipt write APIs. This bot implements:
  - reaction behavior via an immediate emoji message
  - read behavior via local DB tracking (`messages.is_read`)

## Database

SQLite schema is created automatically at startup.

- `messages`: user + assistant text log, read state, timestamps
- `memories`: extracted durable facts/preferences keyed by contact
