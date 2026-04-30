# Agent Harness Architecture Analysis for Familiar

## Executive Summary

Based on analysis of 20+ production agent harness implementations (DeerFlow, Parlant, Dexto, DeepAgents, AutoHarness, agentic-stack, jcode, OpenHarness, oh-my-opencode, Trellis, etc.), this document maps core patterns relevant to Familiar's multi-user caretaker architecture.

**Key Finding**: The most successful harnesses separate the *agent loop* (what models do) from the *harness layer* (everything else). Familiar needs both.

---

## 1. Core Harness Components

### 1.1 The Agent Loop (Every Harness Has This)

```
while not done:
    response = llm.stream(messages, tools)
    if response.stop_reason != "tool_use":
        break
    for tool_call in response.tool_uses:
        result = execute_tool(tool_call)  # <-- harness intervenes here
    messages.append(tool_results)
```

**Key Pattern**: The loop is simple. The complexity is in `execute_tool()` and context management.

### 1.2 Essential Harness Layers

| Layer | Purpose | Familiar Needs |
|-------|---------|----------------|
| **Memory System** | Session continuity, long-term knowledge | ✅ CRITICAL - multi-user, cross-chat memory |
| **Permission & Safety** | Prevent harmful actions | ✅ CRITICAL - mental health context |
| **Context Engineering** | What the agent sees when | ✅ CRITICAL - 200k token management |
| **Tool Registry** | Available actions | ✅ YES - chat relay, calendar, reminders |
| **Multi-Agent Coordination** | Parallel/delegated work | ⚠️ MAYBE - likely one primary agent per user |
| **Session Management** | Resume, checkpoint, crash recovery | ✅ YES - long-running conversations |
| **Observability** | Logging, debugging, cost tracking | ✅ YES - mental health = high stakes |

---

## 2. Memory Architecture Patterns

### 2.1 Three-Tier Memory (MemGPT/Letta Model)

Used by: MemGPT, DeerFlow, jcode

```
Core Memory (~2KB)
├─ Immediate working context
├─ Active task state
└─ User identity/preferences

Archival Memory (~unlimited)
├─ Vector database (RAG)
├─ Past conversations
└─ Learned patterns

Recall Memory
└─ Recent message buffer
```

**Familiar Application**:
- **Core**: Current emotional state, active concerns, recent context
- **Archival**: Full conversation history (for each user), learned patterns about user
- **Recall**: Last N messages per chat platform

### 2.2 Memory as State Machine (Parlant Model)

Used by: Parlant, Trellis

```
turn N:  narrow context → LLM decision → store delta
turn N+1: load relevant context → add new input → repeat
```

**Key Insight**: Don't load everything. Load:
1. User profile
2. Active thread context
3. Relevant past memories (similarity search)
4. Active reminders/todos

### 2.3 Four-Layer Instruction Hierarchy (Claude Code)

From agentic-harness-patterns:

1. **Personal**: User-specific preferences (private per user)
2. **Session**: Current conversation state
3. **Semantic**: Learned general knowledge
4. **Episodic**: Specific past events

**Familiar Mapping**:
- Personal → User mental health profile
- Session → Current chat thread context
- Semantic → General wellness knowledge base
- Episodic → Past intervention history

---

## 3. Context Window Management

### 3.1 Progressive Disclosure (From Parlant)

> "Getting the right context, no more and no less, into the prompt at the right time."

**Strategies**:
1. **Lazy Loading**: Don't include skills/knowledge until triggered
2. **Summarization**: Compress old messages when near token limit
3. **Selective Injection**: Only load relevant memories via similarity search

### 3.2 Auto-Compaction (From OpenHarness)

```python
if context_length > threshold:
    summarize_old_messages()
    preserve_active_tasks()
    keep_recent_N_messages()
```

**Familiar Needs**: 
- Auto-compact when approaching 200k tokens
- Preserve emotional state and active concerns
- Maintain thread continuity markers

### 3.3 Context Preflight Check (From oh-my-opencode)

Before calling LLM:
1. Estimate token count of: system + history + tools + attachments
2. If over budget, trigger compaction
3. Track actual usage vs. estimate

---

## 4. Multi-Agent Patterns (If Needed)

### 4.1 Coordinator Pattern (From oh-my-opencode "Sisyphus")

```
Main Agent (Claude Opus/Kimi K2.5)
  ├─ Delegates to Hephaestus (GPT-5.4) for deep work
  ├─ Calls Oracle for architecture decisions
  └─ Uses Librarian for knowledge retrieval
```

**Familiar Application (Speculative)**:
- Main caretaker agent handles all user interaction
- Background specialist for:
  - Summarization (compress long histories)
  - Knowledge synthesis (update user profiles)
  - Proactive planning (schedule check-ins)

### 4.2 Swarm Pattern (From jcode)

Multiple agents in same repo, with:
- Automatic conflict detection (file edits)
- Direct messaging between agents
- Shared memory pools

**Familiar Application**: 
- Multiple users, each with own agent instance
- Shared knowledge base (wellness resources)
- Private user memory (isolated)

---

## 5. Session Management & Recovery

### 5.1 Checkpoint-Based Recovery (From Aden Hive)

```python
class Session:
    def save_checkpoint(self):
        # Save: messages, tool calls, user state
        
    def resume_from_checkpoint(self):
        # Restore context, continue conversation
```

**Familiar Needs**:
- Save after every message exchange
- Resume conversation across platform switches (Discord → Telegram)
- Recover from crashes without losing context

### 5.2 Session Isolation (From AutoHarness)

```python
# Each user gets isolated session
session = Session(
    user_id="user123",
    memory=UserMemory(user_id),
    permissions=UserPermissions(user_id)
)
```

**Critical for Familiar**: Users NEVER see each other's data.

---

## 6. Permission & Safety Systems

### 6.1 Multi-Level Permission Modes (From OpenHarness)

| Mode | Behavior | Use Case |
|------|----------|----------|
| `default` | Ask before risky actions | Daily use |
| `auto` | Allow everything | Trusted automation |
| `plan` | Block all writes | Read-only review mode |

**Familiar Application**:
- Default: Ask before sharing cross-chat messages
- Auto: Send scheduled wellness check-ins
- Plan: Read-only mode during crisis (escalate to human)

### 6.2 Fail-Closed Design (From AutoHarness)

> "Default to fail-closed. Permission pipeline has side effects — it tracks denials."

**Familiar Application**:
- NEVER expose one user's data to another by default
- Log all denied actions (audit trail for therapy)
- Escalate repeated denials (user might need help)

### 6.3 Pre/Post Tool Hooks (From oh-my-opencode)

```python
@pre_tool_call
def check_permissions(tool, args, context):
    if not authorized(tool, context.user):
        raise PermissionDenied

@post_tool_call
def log_action(tool, result, context):
    audit_log.write(tool, result, context.user)
```

---

## 7. Proactive Behavior Patterns

### 7.1 Background Ambient Mode (From jcode)

```python
while True:
    if time_since_last_message > threshold:
        if user_has_active_reminder:
            send_proactive_message()
    sleep(check_interval)
```

**Familiar Application**:
- Check-in reminders every 24h
- Escalate if no response after 72h
- Daily mood tracking prompts

### 7.2 Intelligent Disobedience (From Research Files)

> "Service dog pattern: disobey harmful commands, but explain why."

**Example**:
```
User: "Just leave me alone forever"
Familiar: "I hear you're overwhelmed. I can give you space today, 
           but I'll check in tomorrow because your wellbeing matters. 
           Is that okay?"
```

### 7.3 Task Decomposition (From AutoHarness)

```python
class Task:
    id: str
    state: TaskState  # pending, running, completed
    output: Optional[str]
    
def evict_completed_tasks():
    # Two-phase: mark done, then remove from context
```

**Familiar Application**:
- Track reminders as tasks
- Track wellness goals as tasks
- Auto-evict completed items from context

---

## 8. Knowledge Management

### 8.1 Skill System (From oh-my-opencode, Trellis)

Skills = On-demand knowledge loaded only when needed.

```
.skills/
  ├─ crisis-intervention/
  │   └─ SKILL.md
  ├─ depression-support/
  │   └─ SKILL.md
  └─ adhd-strategies/
      └─ SKILL.md
```

**Activation**:
- Semantic similarity (user message → skill embedding)
- Explicit trigger (user types "/crisis")
- Agent decision (agent calls `load_skill("crisis")`)

### 8.2 MCP Integration (From OpenHarness, DeepAgents)

Model Context Protocol = standardized tool interface.

**Familiar Application**:
- MCP server for calendar (Google Cal, Outlook)
- MCP server for chat platforms (Discord, Telegram, Slack)
- MCP server for knowledge base (RAG over therapy resources)

### 8.3 Progressive Wiki (From Trellis)

```
.trellis/
  ├─ spec/        # Team standards
  ├─ tasks/       # Active work
  ├─ workspace/   # Developer journals
  └─ workflow.md  # Shared lifecycle
```

**Familiar Adaptation**:
```
.familiar/
  ├─ user-profiles/  # Per-user memory
  ├─ shared-kb/      # Wellness knowledge
  ├─ active-threads/ # Current conversations
  └─ reminders/      # Scheduled check-ins
```

---

## 9. Tool Design Patterns

### 9.1 Hash-Anchored Edits (From oh-my-opencode)

Problem: Agent edits wrong line because file changed.
Solution: Tag every line with content hash.

```
11#VK| function hello() {
22#XJ|   return "world";
33#MB| }
```

Agent references `22#XJ` → if hash doesn't match, edit fails safely.

**Familiar Application**: Not directly applicable (no code editing), but **principle applies**:
- Tag messages with ID when cross-posting
- Verify message still exists before replying to it

### 9.2 Tool Execution Pipeline (From AutoHarness)

```
1. Permission check (deny list, allow list)
2. Pre-hook (logging, validation)
3. Execute tool
4. Post-hook (audit, side effects)
5. Return result
```

**Familiar Application**:
1. Check if user allows cross-chat relay
2. Log all message sends (audit trail)
3. Send message via platform API
4. Track delivery status
5. Return confirmation to agent

---

## 10. Observability & Debugging

### 10.1 Structured Logging (From AutoHarness)

```python
audit_log.write({
    "timestamp": now(),
    "user_id": user_id,
    "tool": "send_message",
    "args": {"platform": "discord", "message": "..."},
    "result": "success",
    "cost_usd": 0.02
})
```

**Familiar Needs**:
- Every message: timestamp, user, platform, content (encrypted)
- Every tool call: what, why, result
- Every escalation: trigger, reasoning, outcome

### 10.2 Token Tracking (From jcode)

```python
response = llm.chat(messages)
tokens_used = response.usage.total_tokens
cost = tokens_used * model_cost_per_token
track_cost(user_id, cost)
```

**Familiar Application**:
- Track per-user token usage
- Alert if user conversation explodes (memory leak?)
- Budget limits (prevent runaway costs)

### 10.3 Dry-Run Mode (From OpenHarness)

```bash
$ oh --dry-run -p "Send a reminder to user123"
# Shows: what would happen, no actual execution
```

**Familiar Application**:
- Test workflows without sending real messages
- Validate configurations before deploying
- Simulate crisis scenarios for training

---

## 11. Anti-Patterns to Avoid

### 11.1 The Harness Problem (From oh-my-opencode Blog)

> "Most agent failures aren't the model. It's the edit tool."

**Lesson**: Tools matter more than prompts. Bad tool = hallucinations, even with perfect prompt.

**Familiar Application**:
- Spend 80% of effort on tool reliability
- 20% on prompt tuning

### 11.2 Prompt Injection (From AutoHarness)

> "Enforce boundaries at tool/sandbox level, not by expecting model to self-police."

**Familiar Application**:
- Don't trust agent to refuse cross-user data leaks
- Enforce isolation at tool execution level (hard permission checks)

### 11.3 Context Explosion (From Parlant)

> "Adding more rules makes the agent smarter, not more confused — because the engine filters context relevance, not the LLM."

**Lesson**: Filter context *before* sending to LLM, not *in* the LLM.

**Familiar Application**:
- Don't dump entire user history into every message
- Load relevant memories via similarity search
- Use structured prompts, not giant system messages

---

## 12. Architecture Recommendations for Familiar

### 12.1 Recommended Stack

**Core Agent Loop**:
- Framework: Custom (based on DeepAgents pattern)
- Reason: Need full control over memory + multi-user isolation

**Memory System**:
- Architecture: Three-tier (MemGPT style)
- Core: In-memory (current state)
- Archival: Vector DB (Qdrant or Chroma)
- Recall: Redis (fast message buffer)

**Context Management**:
- Strategy: Parlant-style progressive disclosure
- Implementation: Similarity search + auto-compaction
- Token budget: 180k (leave 20k margin)

**Multi-User Isolation**:
- Pattern: Session per user (AutoHarness style)
- Storage: Separate vector collection per user
- Audit: All actions logged with user_id

**Proactive Behavior**:
- Pattern: Background cron + intelligent disobedience
- Trigger: Time-based + event-based (no response)
- Safety: Always explain, never force

**Tools**:
- Registry: MCP-based (OpenHarness style)
- Execution: Permissioned pipeline (AutoHarness style)
- Platform adapters: Discord, Telegram, Slack (via MCP)

**Observability**:
- Logging: Structured JSON (all tool calls)
- Metrics: Token usage, message count, escalations
- Dry-run: Test mode for all workflows

### 12.2 Implementation Phases

**Phase 1: Core Loop**
- [x] Agent loop + tool execution
- [ ] Basic memory (in-memory only)
- [ ] Single-user prototype

**Phase 2: Memory System**
- [ ] Three-tier memory (Core/Archival/Recall)
- [ ] Vector DB integration (RAG)
- [ ] Auto-compaction

**Phase 3: Multi-User**
- [ ] Session isolation per user
- [ ] Cross-chat message relay
- [ ] Selective knowledge sharing

**Phase 4: Proactive Features**
- [ ] Background reminder system
- [ ] Intelligent disobedience patterns
- [ ] Escalation protocols

**Phase 5: Production Hardening**
- [ ] Observability dashboard
- [ ] Crash recovery
- [ ] Cost controls

---

## 13. Key Architectural Decisions

### Decision 1: Single-Agent vs Multi-Agent per User?

**Recommendation**: Single agent per user, with background specialist.

**Rationale**:
- Simpler state management (one conversation thread)
- Natural for user experience (one "familiar")
- Background specialist handles:
  - Summarization (compress long histories)
  - Knowledge updates (learn about user over time)
  - Proactive planning (schedule reminders)

**Pattern**: oh-my-opencode "Sisyphus + Hephaestus" model.

### Decision 2: Memory Storage Architecture?

**Recommendation**: Hybrid (Redis + Vector DB)

```
Redis (fast, temporary)
├─ Last 50 messages per chat
├─ Active reminder queue
└─ Current emotional state

Vector DB (persistent, searchable)
├─ Full conversation history (per user)
├─ Learned user patterns
└─ Wellness knowledge base
```

**Rationale**:
- Redis = speed for real-time chat
- Vector DB = deep memory for context
- Separation of concerns

### Decision 3: Context Window Strategy?

**Recommendation**: Parlant-style "narrow and load"

```python
def build_context(user_msg, user_id):
    context = []
    context += core_memory(user_id)           # ~2KB
    context += relevant_history(user_msg)     # ~10KB (similarity search)
    context += active_reminders(user_id)      # ~1KB
    context += recent_messages(user_id, n=10) # ~5KB
    return context  # Total: ~18KB vs 180KB full history
```

**Rationale**: 200k token limit = ~400 messages. Can't dump everything.

### Decision 4: Cross-Chat Relay Permissions?

**Recommendation**: Fail-closed with explicit user consent.

```python
@tool("relay_message")
def relay_message(from_platform, to_platform, message, user_id):
    if not user_has_granted_relay_permission(user_id, to_platform):
        return "I need your permission to send messages to {to_platform}. Say 'yes' to allow."
    # ... send message
```

**Rationale**: Privacy = #1 priority. Never assume consent.

### Decision 5: Proactive Behavior Trigger?

**Recommendation**: Hybrid (time-based + event-based)

```python
triggers = [
    TimeBasedTrigger(every="24h", action="wellness_checkin"),
    EventBasedTrigger(on="no_response_72h", action="escalate"),
    EventBasedTrigger(on="crisis_keyword", action="immediate_response"),
]
```

**Rationale**: Balance proactive care with respecting user boundaries.

---

## 14. Security & Privacy Considerations

### 14.1 Multi-User Isolation

**MUST HAVES**:
1. Separate vector collections per user (no shared namespace)
2. User ID in all database queries (never query without filter)
3. Encrypted storage for sensitive data (conversation history)
4. No cross-user similarity search (even accidentally)

**Test**:
```python
def test_user_isolation():
    user1_data = get_user_memories("user1")
    user2_data = get_user_memories("user2")
    assert no_overlap(user1_data, user2_data)
```

### 14.2 Audit Logging

**Log Everything**:
- Every message sent/received (with user_id + platform)
- Every tool call (what, why, result)
- Every permission check (granted/denied)
- Every escalation (trigger, reasoning)

**Format**:
```json
{
  "timestamp": "2025-01-19T12:34:56Z",
  "user_id": "user123",
  "event": "tool_call",
  "tool": "send_message",
  "args": {"platform": "discord", "message": "..."},
  "result": "success",
  "agent_reasoning": "User requested reminder"
}
```

### 14.3 Data Retention

**Policy**:
- Core memory: Persistent (user profile, learned patterns)
- Recent messages: 30 days
- Audit logs: 90 days (compliance)
- User can request full deletion (GDPR)

---

## 15. References & Inspiration

### Harnesses Analyzed
1. **DeerFlow** (ByteDance) - Long-term memory
2. **Parlant** (Emcie) - Context engineering
3. **Dexto** (Truffle AI) - Configuration-driven agents
4. **DeepAgents** (LangChain) - Batteries-included harness
5. **AutoHarness** (Aiming Lab) - Governance framework
6. **agentic-stack** (codejunkie99) - Portable memory + skills
7. **jcode** (Jeremy Huang) - Performance + memory
8. **OpenHarness** (HKUDS) - Production runtime
9. **oh-my-opencode** (code-yeongyu) - Multi-model orchestration
10. **Langroid** (CMU/UW-Madison) - Multi-agent programming
11. **OpenHarness** (Max Gfeller) - AI SDK 5 integration
12. **CC Harness Skills** (LearnPrompt) - Claude Code patterns
13. **Trellis** (Mindfold AI) - Progressive wiki for teams
14. **Aden Hive** - Multi-agent production harness
15. **Harness** (revfactory) - Team-architecture factory

### Key Papers & Blogs
- [The Harness Problem](https://blog.can.ac/2026/02/12/the-harness-problem/) - Can Bölük
- [Awesome Harness Engineering](https://github.com/ai-boost/awesome-harness-engineering)
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) - Anthropic

---

## Conclusion

**Core Insight**: The harness is 90% of agent reliability. Models improve every month, but the harness determines whether agents actually work in production.

**For Familiar**:
1. **Memory matters most** - Multi-user isolation + RAG + auto-compaction
2. **Proactive = risky** - Intelligent disobedience + escalation protocols
3. **Privacy is non-negotiable** - Fail-closed permissions + audit everything
4. **Context is scarce** - Progressive disclosure + similarity search
5. **Tools > Prompts** - 80% effort on tool reliability

**Next Steps**:
1. Build core agent loop (Phase 1)
2. Implement three-tier memory (Phase 2)
3. Add multi-user isolation (Phase 3)
4. Test proactive features safely (Phase 4)
5. Harden for production (Phase 5)

---

*Last Updated: 2025-01-19*
*Analysis based on 20+ production harness implementations*
