# Familiar
I've decided to make this public while I work on it so others can access the research.

---

## Proto-Familiar — Chat Frontend

A lightweight, self-hosted chat UI for [z.ai](https://api.z.ai) and [NanoGPT](https://nano-gpt.com). Runs entirely on your machine — your API key never leaves `localhost`.

### Requirements

- [Node.js](https://nodejs.org/) 18 or newer

### Quick Start

```bash
# 1. Install dependencies (Express only)
npm install

# 2. Start the server
npm start          # production
npm run dev        # auto-restarts on file changes (requires nodemon)
```

Open **http://localhost:3000** in your browser.

Open the Settings panel (☰), choose your provider, paste your API key, pick a model, and start chatting.

To run on a different port, set the `PORT` environment variable before starting:

```bash
PORT=8080 npm start
```

---

### Features

| Feature | Details |
|---|---|
| **Providers** | NanoGPT (OpenAI-compatible) · Z.ai Standard API · Z.ai Coding Plan |
| **Streaming** | Server-sent event streaming by default; toggle off for full-response mode |
| **System prompt** | Free-text field or import from `.txt` / `.md` / `.json` |
| **Character profile** | Injected into the system message after the system prompt |
| **User profile** | Injected into the system message after character profile |
| **Post-history prompt** | Appended as a final user turn immediately before each AI response |
| **Tool calling** | LLM can invoke built-in tools (`get_datetime`, `get_session_info`) or custom tools you define; multi-round loop up to 5 rounds |
| **Custom tools** | Paste a JSON array of OpenAI-compatible function definitions; executed client-side |
| **Message timestamps** | Every message is stamped `HH:MM` (today) or `Mon DD HH:MM` (older) |
| **Session logging** | Conversations saved as JSON files in `logs/` with start + end timestamps |
| **Session browser** | In-app Logs modal to view, load, or delete any past session |
| **Session auto-end** | After 3 hours of inactivity the session is closed and a new one starts automatically |
| **Export** | Download conversation as a Markdown `.md` file (tool-call turns are omitted) |
| **Regenerate** | Re-run the last AI response with the same user message |
| **Themes** | Dark / light toggle |
| **Responsive layout** | Full sidebar on desktop · Full-screen slide-in panel on mobile |
| **File import** | Load any prompt field from a plain-text, Markdown, or JSON file |

---

### Supported Providers & Models

**NanoGPT** — `https://nano-gpt.com`

Suggested models (type any valid model name in the field):
`gpt-4o`, `gpt-4o-mini`, `chatgpt-4o-latest`, `claude-opus-4-5`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `gemini/gemini-2.5-pro`, `gemini/gemini-2.0-flash`, `deepseek/deepseek-r1`, `deepseek/deepseek-v3`, `meta-llama/llama-3.3-70b-instruct`

**Z.ai — Standard API** — `https://api.z.ai`

Suggested models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.5`, `glm-4.5-air`, `glm-4-flash`, `glm-z1-rumination`

**Z.ai — Coding Plan** — uses a separate quota endpoint (`/api/coding/paas/v4/…`).

Suggested models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.5-air`

All three providers share the same OpenAI-compatible `chat/completions` format; the server selects the correct endpoint based on your provider choice.

---

### Session Logging

Every conversation is a **session**. Sessions are stored as JSON files under `logs/` next to `server.js`. The `logs/` directory is created automatically on first run and is git-ignored.

Each log file is named `<uuid>.json` and contains:

```json
{
  "sessionId":  "...",
  "startedAt":  "2026-05-11T14:30:00.000Z",
  "endedAt":    "2026-05-11T17:12:00.000Z",
  "provider":   "nanogpt",
  "model":      "gpt-4o-mini",
  "updatedAt":  "2026-05-11T17:12:00.000Z",
  "messages": [
    { "role": "user",      "content": "...", "timestamp": "2026-05-11T14:30:05.000Z" },
    { "role": "assistant", "content": "...", "timestamp": "2026-05-11T14:30:07.341Z" }
  ]
}
```

**Session lifecycle:**

1. A new session begins when the app starts (or when you clear history).
2. Each time you send a message, `lastMessage` is updated to the current time and a 3-hour inactivity countdown resets.
3. If 3 hours pass with no new message, the session is stamped with `endedAt` and saved; a fresh session starts automatically and a brief on-screen notice appears.
4. If you close the tab and reopen it after 3+ hours, the same check runs on startup: the old session is finalised silently and a new one starts.

You can browse, load, or delete sessions at any time via the **☰ Logs** button in the Chat section of the sidebar.

---

### Tool Calling

The **Tools** section in the sidebar controls how the LLM interacts with client-side functions.

#### Enabling / disabling

The **Enable tool use** checkbox controls whether the `tools` array is sent with each request. When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

#### Built-in tools

| Tool | What it returns |
|---|---|
| `get_datetime` | Current local date, time, and timezone |
| `get_session_info` | Session start time, message count, provider, model, and ms since last message |

Both tools are always available when tool use is enabled — they require no arguments.

#### Custom tools

Paste a JSON array of [OpenAI function-calling](https://platform.openai.com/docs/guides/function-calling) tool definitions into the **Custom tools** field. The objects must follow the standard `{ type, function: { name, description, parameters } }` shape.

Custom tools are advertised to the LLM like built-in tools, but their execution returns a message saying the tool has no client-side implementation. Use custom definitions to let the model *describe* what it would do, or extend `BUILTIN_EXECUTORS` in `app.js` to wire real logic.

#### How the loop works

1. The request is sent to the provider with the tools array and `tool_choice: 'auto'`.
2. If the response has `finish_reason: 'tool_calls'`, each requested tool is executed locally.
3. A compact collapsible block is rendered in the chat showing the call name, arguments, and result.
4. The assistant message + tool results are appended to the conversation and the request is re-sent.
5. Steps 2–4 repeat up to **5 rounds**. After 5 rounds without a normal response, the last assistant reply is used as-is.

Tool-call turns are stored in the session log but are stripped from chat exports.

---

### Server API Reference

The Express server runs on `localhost:3000` and exposes the following endpoints.

#### `POST /api/chat`
Proxies a chat request to the chosen provider.

**Request body:**
```json
{
  "provider":    "nanogpt | zai | zai-coding",
  "apiKey":      "sk-...",
  "model":       "gpt-4o-mini",
  "messages":    [{ "role": "user", "content": "Hello" }],
  "stream":      true,
  "temperature": 0.8,
  "max_tokens":  2048,
  "tools":       [...],
  "tool_choice": "auto"
}
```
`temperature`, `max_tokens`, `tools`, and `tool_choice` are all optional. Returns an SSE stream when `stream: true`, otherwise returns the provider's JSON response verbatim. `tools` and `tool_choice` are forwarded to the provider as-is.

#### `POST /api/log`
Creates or overwrites the log file for a session.

**Request body:**
```json
{
  "sessionId": "<uuid>",
  "startedAt": "<ISO>",
  "endedAt":   "<ISO> | null",
  "provider":  "...",
  "model":     "...",
  "messages":  []
}
```

#### `GET /api/logs`
Returns a JSON array of session metadata (no message bodies), sorted newest-first.

```json
[
  {
    "sessionId":    "...",
    "startedAt":    "...",
    "endedAt":      "... | null",
    "updatedAt":    "...",
    "provider":     "...",
    "model":        "...",
    "messageCount": 12
  }
]
```

#### `GET /api/logs/:id`
Returns the full session JSON for the given UUID.

#### `DELETE /api/logs/:id`
Deletes the session log file. Returns `{ "ok": true }` on success.

#### `GET /api/health`
Returns `{ "ok": true }`. Useful for uptime checks.

---

### Project Layout

```
/
├── server.js          Express proxy + log API (Node.js 18+, ESM)
├── package.json
├── .gitignore
├── logs/              Session JSON files (auto-created, git-ignored)
├── public/
│   ├── index.html     App shell (sidebar + chat pane + logs modal)
│   ├── style.css      All styling — dark/light themes, responsive layout
│   └── app.js         All frontend logic — state, API, rendering, sessions
└── Research/          Background reading on architecture and mental-health AI
```

---

### Privacy & Security Notes

- **API key security:** The key is sent from the browser to `localhost` only. The server uses it once per request to call the upstream API and never logs or stores it.
- **Path traversal prevention:** Log endpoints validate session IDs against a strict UUID regex before constructing any file path.
- **Local-only by default:** The server binds to all interfaces on the configured port but is not intended to be exposed to the internet without additional authentication.
- **No telemetry:** Nothing is phoned home. The only outbound traffic is the proxied LLM request to the provider you configure.

---

## About the Larger Project

My idea is to create an agentic caretaker for myself. As you can see I am starting by thoroughly researching different frontends and extensions to try and gleam the best building blocks from each. Most of what you read here is strongly a WIP, very early. I am conceptualising in-depth before going forward with even creating a roadmap.

However, I found some stuff potentially helpful for others. So I've made the repo public already. Have at it.

See [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) for the full vision and phased plan.

---

## Research Index

### 🏗️ Architecture & System Design

**[caretaker-agent-comprehensive-architecture.md](Research/caretaker-agent-comprehensive-architecture.md)**  
Complete implementation guide synthesizing all research. Covers tech stack, database design, message relay architecture, memory management, security, API specs, and deployment. Your go-to blueprint for building the system.

**[multi-user-chat-architecture-patterns.md](Research/multi-user-chat-architecture-patterns.md)**  
Design patterns for multi-user AI systems. Authentication, chat isolation, session management, database schemas, message routing, WebSocket architecture, and horizontal scaling patterns.

**[application-to-caretaker-agent.md](Research/application-to-caretaker-agent.md)**  
Adapts Marinara's 3-tier memory system to caretaker agent needs. Addresses cross-chat communication while maintaining privacy boundaries. Per-chat memory, user profiles, relay mechanisms, and permission controls.

### 🧠 Memory & Context Management

**[context-window-management-strategies.md](Research/context-window-management-strategies.md)**  
Strategies for managing LLM context windows: truncation, summarization, RAG retrieval, hybrid systems, token budgeting, and compression techniques. Solves the "conversation too long" problem.

**[marinara-memory-system.md](Research/marinara-memory-system.md)**  
Technical deep-dive into Marinara Engine's 3-tier memory: semantic memory (RAG with 5-message chunks), character identity persistence, and agent persistent memory (key-value state storage).

**[marinara-lorebook-trigger-architecture.md](Research/marinara-lorebook-trigger-architecture.md)**  
How Marinara dynamically injects contextual information using keyword triggers, semantic similarity, and game state conditions. Recursive scanning, token budgeting, and hook systems.

**[sillytavern-worldinfo-architecture.md](Research/sillytavern-worldinfo-architecture.md)**  
SillyTavern's World Info system: keyword-triggered knowledge injection, scanning algorithms, injection strategies, and generation modes. 5000+ lines of implementation details.

**[sillytavern-memorybooks-extension.md](Research/sillytavern-memorybooks-extension.md)**  
Automated lorebook entry generation using LLMs. Scene management, memory creation workflows, and practical patterns for extracting structured knowledge from conversations.

**[coneja-chibi-continuity-systems-analysis.md](Research/coneja-chibi-continuity-systems-analysis.md)**  
Analysis of 5 interconnected systems (TunnelVision, VectHare, BunnyMo, CarrotKernel, TrackHare) focused on continuity and persistence. "Active retrieval" philosophy: AI consciously retrieves info vs passive injection.

### 🤖 AI Behavior & Safety

**[proactive-inhibition-decision-framework.md](Research/proactive-inhibition-decision-framework.md)**  
**Critical.** Addresses over-cautious AI behavior. Rule hierarchy for when to act vs stay silent. Explicit instructions override everything. Prevents agents from inventing excuses like "we're in a conversation" or "they might be sleeping."

**[intelligent-disobedience-ai-implementation.md](Research/intelligent-disobedience-ai-implementation.md)**  
Framework for when AI should refuse user requests (inspired by service dog training). Decision trees for safety vs therapeutic impact vs ethical boundaries. Response levels from soft redirect to crisis intervention.

**[tool-use-hallucination-prevention.md](Research/tool-use-hallucination-prevention.md)**  
Preventing false claims of actions/tool execution. Verification loops (never claim without tool response), state tracking, error surfacing, capability registries. Essential for crisis intervention and medication reminders.

**[openclaw-baseline-analysis.md](Research/openclaw-baseline-analysis.md)**  
Deep-dive into OpenClaw (366k⭐ personal AI assistant). Heartbeat mechanic (30-60min proactive checks), HEARTBEAT_OK token (spam prevention), active hours gating, prompt engineering patterns, multi-agent architecture, and cost optimization.

### 🏥 Mental Health Support

**[depression-caretaker-ai-implications.md](Research/depression-caretaker-ai-implications.md)**  
Implementation guide for supporting users with depression. Time perception (5-10min increments), task breakdown (micro-tasks), cognitive load reduction, emotional support patterns, crisis recognition (988 hotline), and avoiding toxic positivity.

**[agoraphobia-caretaker-ai-implications.md](Research/agoraphobia-caretaker-ai-implications.md)**  
Supporting exposure therapy for agoraphobia. Exposure hierarchy management (SUDS 0-100 ratings), panic response protocols (5-4-3-2-1 grounding), safety behavior reduction, space/distance conceptualization, habituation curves.

**[adhd-caretaker-ai-implications.md](Research/adhd-caretaker-ai-implications.md)**  
ADHD executive function support. Time blindness compensation, task initiation ("Wall of Awful"), working memory augmentation (AI as external memory), dopamine-aware task design (gamification, novelty), hyperfocus management (break enforcement).

### 🔐 Security & Privacy

**[privacy-security-compliance-patterns.md](Research/privacy-security-compliance-patterns.md)**  
Security best practices for multi-user AI systems. Threat modeling, authentication security, data isolation, encryption (at-rest/in-transit), audit logging, content moderation, rate limiting, GDPR/HIPAA compliance, secure deployment.

### 🎨 Frontend & Integration Research

**[ai-frontend-comparison-matrix.md](Research/ai-frontend-comparison-matrix.md)**  
Comparison of 5 major AI chat frontends (SillyTavern, Marinara, KoboldAI, Open WebUI, TextGen WebUI). Architecture styles, multi-user support, memory systems, API compatibility, streaming support. Feature matrix and lessons learned.

**[marinara-architecture-systems.md](Research/marinara-architecture-systems.md)**  
Marinara Engine's tool use system (10 built-in tools + custom), agent architecture, visual UI/navigation, and Discord webhook integration. Tool-calling loop (max 5 rounds LLM ↔ tool execution).

**[marinara-default-prompts.md](Research/marinara-default-prompts.md)**  
25+ specialized agent prompts from Marinara: world state extraction, music control, scene analysis, quest tracking, writing enhancement. Game mode prompts, Professor Mari assistant, and generation parameters.

**[sillytavern-api-architecture.md](Research/sillytavern-api-architecture.md)**  
SillyTavern's universal adapter architecture. Chat Completions API (OpenAI-compatible) vs Text Completions API. Supports 40+ LLM backends through route-based dispatch and abstraction layers.

---

## Quick Find

**Need to understand the overall system?** → Start with [caretaker-agent-comprehensive-architecture.md](Research/caretaker-agent-comprehensive-architecture.md)

**Building proactive behavior?** → Read [openclaw-baseline-analysis.md](Research/openclaw-baseline-analysis.md) + [proactive-inhibition-decision-framework.md](Research/proactive-inhibition-decision-framework.md)

**Working on memory systems?** → Check [marinara-memory-system.md](Research/marinara-memory-system.md) + [context-window-management-strategies.md](Research/context-window-management-strategies.md)

**Implementing safety features?** → See [intelligent-disobedience-ai-implementation.md](Research/intelligent-disobedience-ai-implementation.md) + [tool-use-hallucination-prevention.md](Research/tool-use-hallucination-prevention.md)

**Supporting mental health conditions?** → Review all three: [depression-caretaker-ai-implications.md](Research/depression-caretaker-ai-implications.md), [agoraphobia-caretaker-ai-implications.md](Research/agoraphobia-caretaker-ai-implications.md), [adhd-caretaker-ai-implications.md](Research/adhd-caretaker-ai-implications.md)

**Security & privacy concerns?** → Read [privacy-security-compliance-patterns.md](Research/privacy-security-compliance-patterns.md) + [multi-user-chat-architecture-patterns.md](Research/multi-user-chat-architecture-patterns.md)

