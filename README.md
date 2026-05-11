# Familiar
I've decided to make this public while I work on it so others can access the research.

---

## Frontend — Quick Start

A lightweight chat UI for [z.ai](https://api.z.ai) and [NanoGPT](https://nano-gpt.com) that runs locally in your browser.

**Requirements:** Node.js 18 or newer.

```bash
# 1. Install dependencies (only Express)
npm install

# 2. Start the server
npm start
# → open http://localhost:3000
```

Open the Settings panel (☰ button), choose your provider, paste your API key, pick a model, and start chatting.

The server proxies all API calls through `localhost:3000/api/chat` — your key never leaves your machine. All settings and chat history are persisted in browser `localStorage`.

| Feature | Notes |
|---|---|
| Providers | NanoGPT (OpenAI-compat.) · Z.ai (GLM) |
| Streaming | SSE streamed responses by default |
| System prompt | Free-text or import from `.txt`/`.md`/`.json` |
| Character profile | Injected into system message |
| User profile | Injected into system message |
| Post-history prompt | Appended as final user message before AI responds |
| Export | Markdown `.md` download |
| Themes | Dark / light toggle |
| Responsive | Desktop sidebar · Mobile full-screen panel |

---

My idea is to create an agentic caretaker for myself. As you can see I am starting by thoroughly researching different frontends and extensions to try and gleam the best building blocks from each. Most of what you read here is strongly a WIP, very early. I am conceptualising in-depth before going forward with even creating a roadmap.

However, I found some stuff potentially helpful for others. So I've made the repo public already. Have at it.

---

## Inhaltsverzeichnis (Table of Contents)

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

