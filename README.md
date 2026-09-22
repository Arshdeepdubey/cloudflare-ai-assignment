# cf-ai-assistant

An AI-powered chat assistant built entirely on Cloudflare's platform.

## What it does

A user chats with the assistant in a browser. Every message is coordinated by a
Worker, answered by **Llama 3.3** on **Workers AI**, and the conversation is
remembered across page reloads and future visits using a **Durable Object**
acting as per-session memory.

## Architecture

```
┌──────────────┐        HTTPS/JSON         ┌───────────────────────┐
│   Browser     │ ───────────────────────▶ │   Cloudflare Pages     │
│  (public/)    │ ◀─────────────────────── │   static chat UI       │
└──────┬────────┘                           └───────────────────────┘
       │  fetch("/api/chat")
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Worker (src/index.ts)               │
│  - Receives the chat request                                      │
│  - Resolves a session id -> routes to that session's Durable Obj. │
└──────────────┬──────────────────────────────────────────────────┘
               │  Durable Object stub.fetch()
               ▼
┌─────────────────────────────────────────────────────────────────┐
│           ChatSession Durable Object (src/chat-session.ts)        │
│  COORDINATION LAYER — one instance per conversation                │
│                                                                     │
│   1. Load prior messages from its private SQLite storage (MEMORY) │
│   2. Append the new user message                                  │
│   3. Call Workers AI (Llama 3.3) with [history + new message]     │
│   4. Save the assistant's reply to storage (MEMORY)                │
│   5. Return the reply to the Worker                                │
└──────────────┬──────────────────────────────────────────────────┘
               │  env.AI.run(...)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                Workers AI — @cf/meta/llama-3.3-70b-instruct        │
└─────────────────────────────────────────────────────────────────┘
```

**Why a Durable Object for coordination + memory?** Each conversation gets its
own Durable Object instance, addressed by a session id. That instance is the
single place that (a) owns the conversation's persistent SQLite storage —
satisfying the **memory/state** requirement — and (b) sequences the
load → call-LLM → save steps in order, satisfying the
**workflow/coordination** requirement, without needing a separate
orchestration layer.

## Components mapped to the assignment brief

| Requirement | Implementation |
|---|---|
| LLM | Llama 3.3 (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) via Workers AI |
| Workflow / coordination | `ChatSession` Durable Object — sequences retrieve → generate → persist |
| User input | Static chat UI on Cloudflare Pages, calling the Worker over `fetch` |
| Memory / state | Durable Object's embedded SQLite storage — persists across reloads |

## Folder structure

```
cf-ai-assistant/
├── README.md
├── PROMPTS.md              # AI-assisted coding prompt history
├── package.json
├── tsconfig.json
├── wrangler.jsonc           # Worker + Durable Object + Workers AI bindings
├── src/
│   ├── index.ts             # Worker entry point / router
│   └── chat-session.ts      # Durable Object: coordination + memory + LLM call
└── public/
    └── index.html           # Chat UI served by Cloudflare Pages
```

## Running locally

```bash
npm install
npx wrangler dev
```

This serves the Worker (with the Durable Object and Workers AI binding) on
`http://localhost:8787`. Open `public/index.html` directly in a browser, or
serve it with any static file server — it calls the Worker at
`http://localhost:8787/api/chat`.

## Deploying

```bash
npx wrangler deploy
```

Then deploy `public/` as a Cloudflare Pages project (`npx wrangler pages deploy public`),
and update `API_BASE` in `public/index.html` to your deployed Worker URL.

## Notes

- Workers AI usage incurs cost even in local dev, since inference calls reach
  Cloudflare's API. The free tier includes a daily allowance of requests.
- The Durable Object class uses `new_sqlite_classes` in the migration so it
  works on Cloudflare's free tier.
- Conversation history is capped (see `MAX_HISTORY` in `chat-session.ts`) to
  keep the prompt within the model's context window.
