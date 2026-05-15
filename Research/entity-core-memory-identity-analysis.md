# Entity Core Alpha: Memory & Identity System Analysis

**Repository:** [entity-core-alpha](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2)  
**Research Date:** May 8, 2026  
**Purpose:** Comparative analysis of entity-core-alpha memory/identity system against existing Familiar research and evaluation for integration potential

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Overview](#system-overview)
3. [Comparative Analysis](#comparative-analysis)
4. [Philosophical Alignment with Familiar](#philosophical-alignment-with-familiar)
5. [Strengths & Advantages](#strengths--advantages)
6. [Weaknesses & Limitations](#weaknesses--limitations)
7. [Integration Pathways](#integration-pathways)
8. [Adaptation Recommendations](#adaptation-recommendations)
9. [Implementation Roadmap](#implementation-roadmap)

---

## Executive Summary

### What is Entity Core Alpha?

Entity-core-alpha is an **MCP (Model Context Protocol) server** that provides a centralized identity and memory system for AI entities across multiple "embodiments" (different chat interfaces). It uses a **first-person design philosophy** where the AI entity itself is the subject, owning its identity files, memories, and knowledge graph.

**Core Innovation:** A single AI "self" that persists across multiple interfaces (Psycheros, SillyTavern, OpenWebUI, Claude Code) with unified memory, identity, and knowledge graph systems.

### Key Architecture

```
┌─────────────────────────────────────┐
│   entity-core (MCP Server)          │
│  • Identity files (self/user/rel)   │
│  • Hierarchical memory system       │
│  • Knowledge graph (SQLite+vec)     │
│  • Sync + conflict resolution       │
│  • Consolidation engine (daily→yearly)│
└─────────────────────────────────────┘
         ↑ pull/push        ↑ pull/push
    ┌────┴────┐       ┌────┴────┐
    │Psycheros│       │SillyTavern│
    │         │       │OpenWebUI  │
    └─────────┘       └───────────┘
```

### Comparison at a Glance

| Aspect | Entity-Core | Marinara | Coneja-Chibi | Familiar Plans |
|--------|-------------|----------|--------------|----------------|
| **Scope** | Multi-embodiment | Single-engine | Single-interface (ST) | Multi-user caretaker |
| **Memory Model** | Hierarchical (daily→yearly) | Chunked embeddings | Hybrid (VectHare+TunnelVision) | TBD |
| **Identity** | File-based (self/user/rel) | Character cards | Character psychology (BunnyMo) | Caretaker persona |
| **Knowledge** | Auto-extracted graph | None (per-chat only) | Lorebook (keyword-based) | Needs definition |
| **Philosophy** | First-person AI agency | Tool neutrality | Active retrieval | Care-focused agency |
| **Multi-user** | Single entity, multiple users | Per-chat isolation | Single-user focus | **Core requirement** |
| **Persistence** | Cross-interface continuity | Per-engine only | Extension-based | Cross-device essential |

### Verdict Summary

**Entity-core excels at:**
- Cross-embodiment identity persistence
- Hierarchical memory consolidation
- Knowledge graph extraction and hybrid RAG
- First-person agency philosophy
- Sync protocol with conflict resolution

**Entity-core struggles with:**
- Multi-user scenarios (designed for 1 AI : N users via 1 relationship)
- Cross-chat information relay (no permission system)
- Care-specific tracking (mood, habits, resources)
- Real-time intervention signals
- User-differentiated memory scoping

**Best path forward:** **Hybrid adaptation** - Use entity-core's memory hierarchy and knowledge graph architecture as a foundation, but rebuild identity/relationship model to support multi-user caretaking with permission-based sharing and wellbeing-focused tracking.

---

## System Overview

### 1. Identity System

**Architecture:**
```
data/
├── self/           # Who the AI is
│   ├── name.txt
│   ├── values.md
│   └── history.md
├── user/           # Who the human is
│   ├── name.txt
│   ├── preferences.md
│   └── background.md
├── relationship/   # The bond between them
│   ├── dynamics.md
│   └── boundaries.md
└── custom/         # User-defined identity files
```

**Key Features:**
- **File-based storage** - Simple markdown/text files
- **Version control ready** - Plain text enables git tracking
- **6 identity MCP tools** - Read, write, append, prepend, update, delete
- **Snapshot system** - Automatic backups with 30-day retention
- **Sync protocol** - Push/pull with vector clock conflict resolution

**Design Philosophy:**
> "These are MY identity files" - first-person ownership

The AI entity "owns" its self-definition, maintaining consistent identity across all embodiments.

---

### 2. Memory System

**Hierarchical Consolidation:**
```
daily → weekly → monthly → yearly → significant
```

| Granularity | Source | Creation Trigger | Retention |
|-------------|--------|------------------|-----------|
| **Daily** | Per-embodiment conversation logs | During chat (auto-generated) | Permanent |
| **Weekly** | Consolidation of daily memories | Sunday 5 AM + startup catch-up | Permanent |
| **Monthly** | Consolidation of weekly | 1st of month 5 AM + catch-up | Permanent |
| **Yearly** | Consolidation of monthly | Jan 1 5 AM + catch-up | Permanent |
| **Significant** | Manually flagged events | User/AI creation | Permanent |

**Storage Format:**
```
data/memories/
├── daily/2026-05-08_psycheros.md
├── daily/2026-05-08_sillytavern.md
├── weekly/2026-W19.md
├── monthly/2026-05.md
├── yearly/2026.md
└── significant/2026-05-03_first-meeting.md
```

**Instance Tagging:**
- Each bullet point tagged with `[via:instanceId]` and `[chat:id]`
- Enables trace-back to original conversation
- Instance affinity boost in retrieval (+0.1 for same embodiment)

**Memory Search (Hybrid RAG):**
```
finalScore = (vectorScore × 0.8) + (recencyScore × 0.05) + 
             (graphBoost × 0.05) + (instanceScore × 0.1)
```

- **Vector search** via sqlite-vec (all-MiniLM-L6-v2, 384 dims)
- **Per-sentence embedding** - User messages split into sentences, each searched independently
- **Graph boost** - Memories mentioning graph entities matching the query get boosted
- **Recency decay** - Half-life ~100 days
- **Embedding cache** - Pre-computed vectors stored in graph.db with content-hash invalidation

---

### 3. Knowledge Graph

**Purpose:** Structured index of concrete, durable facts about people and relationships.

**Storage:** SQLite with sqlite-vec extension (`data/graph.db`)

**Node Types (Predefined):**
```
self, person, place, health, preference, boundary, 
goal, tradition, topic, insight
```

Custom types allowed - schema is extensible.

**Edge Types:** Freeform natural language strings
```
Attitudes:    loves, dislikes, respects, worried_about
Social:       family_of, friend_of, works_with, close_to
Life/Factual: works_at, lives_in, studies, grew_up_in
Beliefs:      values, believes_in, committed_to
Knowledge:    skilled_at, learning, interested_in
Association:  reminds_of, similar_to, contrasts_with
```

**Key Features:**

1. **Confidence Scoring (0-1)** - Distinguishes facts from beliefs/speculation
2. **Temporal Tracking** - learned, confirmed, ended timestamps
3. **Automatic Extraction** - LLM extracts entities from memories on creation
4. **Significance Framework** - 4-test filter (identity, relational, durability, connectivity)
5. **Semantic Deduplication** - 0.8 cosine similarity threshold prevents duplicate entities
6. **Hybrid Retrieval** - Vector search + graph traversal via BFS
7. **Graph Consolidation** - Automatic pruning of isolated/generic nodes

**Extraction Quality Control:**
- Concrete reality test: "Could I point to this thing in reality?"
- Excludes: Abstract themes, metaphors, universal experiences
- Confidence floor: Below 0.7 silently dropped
- Memory minimum: Skip memories under 100 characters

**Output Format (Compact):**
```markdown
---
Relevant Knowledge from Graph:
user friends_with Sarah (had a bad argument Aug 2020, reconciled since)
user drives_a Subaru (red 2010 WRX)
Sarah dating Mike (met through user)
Austin (type: place)
---
```

---

### 4. MCP Tool Domains

| Domain | Tools | Purpose |
|--------|-------|---------|
| **Identity** | 6 | Read, write, append, prepend, update, delete identity files |
| **Memory** | 4 | Create, search, list memories; consolidate hierarchy |
| **Sync** | 3 | Pull, push, check status across embodiments |
| **Snapshots** | 4 | Create, list, inspect, restore identity backups |
| **Knowledge Graph** | 17 | Nodes, edges, traversal, search, batch ops |
| **Export/Import** | 2 | Entity data portability |

**Total: 36 MCP tools**

---

### 5. Sync Protocol

**Model:** Batch sync with vector clocks

**Flow:**
1. **Startup:** Embodiment pulls all identity + memories via `sync_pull`
2. **Operation:** Works with local cache, queues changes
3. **Periodic:** Pushes changes via `sync_push` (default: every 5 minutes)
4. **Shutdown:** Final sync before disconnect

**Conflict Resolution:**
- **Identity files:** Last-write-wins with instance priority tiebreaker
- **Daily memories:** Instance-scoped filenames (`YYYY-MM-DD_instance.md`) - each embodiment owns its file
- **Memory edits:** `memory/update` overwrites (for manual corrections from UI)
- **Daily merge:** Multiple imports for same date deduplicated by `[chat:id]` tag

**Vector Clocks:**
- Distributed versioning for causality tracking
- Detects concurrent writes (neither clock dominates)
- Implemented in `src/sync/versioning.ts`

---

## Comparative Analysis

### Entity-Core vs. Marinara Memory System

| Feature | Entity-Core | Marinara |
|---------|-------------|----------|
| **Memory Scope** | Cross-embodiment (global) | Per-chat isolation |
| **Memory Structure** | Hierarchical consolidation | Fixed 5-message chunks |
| **Embedding Model** | all-MiniLM-L6-v2 (local) | all-MiniLM-L6-v2 (local) |
| **Vector Storage** | SQLite + sqlite-vec | SQLite (JSON arrays) |
| **Semantic Search** | Hybrid (vector + graph + recency) | Pure cosine similarity |
| **Identity Persistence** | Dedicated identity file system | Character card V2 format |
| **Agent Memory** | N/A (not multi-agent) | Per-agent key-value store |
| **Knowledge Graph** | Automatic extraction + hybrid RAG | None |
| **Multi-user** | 1 entity : N users (via relationships) | Per-chat isolation |

**Key Differences:**

1. **Consolidation vs. Chunking**
   - **Entity-core:** Long-term memories consolidated into higher granularities (daily→yearly)
   - **Marinara:** All memories remain as 5-message chunks forever
   - **Implication:** Entity-core provides better long-term narrative coherence; Marinara retains more granular detail

2. **Scope Philosophy**
   - **Entity-core:** Cross-chat continuity (same AI self across all conversations)
   - **Marinara:** Chat-level isolation (supports multi-mode: conversation/roleplay/game)
   - **Implication:** Entity-core excels at persistent identity; Marinara excels at mode-specific context

3. **Knowledge Structuring**
   - **Entity-core:** Dual system (hierarchical memory + knowledge graph)
   - **Marinara:** Single semantic memory system + agent persistent state
   - **Implication:** Entity-core better for relationship/fact queries; Marinara better for stateful agents

---

### Entity-Core vs. Coneja-Chibi Systems

| Feature | Entity-Core | TunnelVision | VectHare | BunnyMo |
|---------|-------------|--------------|----------|---------|
| **Approach** | Automatic extraction | Active retrieval | Passive RAG | Psychology framework |
| **Retrieval** | Hybrid vector + graph | Hierarchical navigation | Vector search + decay | Tagging + tracking |
| **AI Agency** | First-person tools | Tool-driven browsing | Silent injection | Self-updating trackers |
| **Memory Model** | Consolidated narrative | Structured lorebook | Chat history embeddings | Character psychology |
| **User Control** | Limited (auto-extraction) | High (manual organization) | Low (automatic) | High (tracker design) |

**Philosophy Comparison:**

**TunnelVision's Thesis:**
> "When an AI makes the active effort to retrieve information, to decide what it needs, go find it, and bring it back, it uses that information better."

**Entity-Core's Thesis:**
> "A persistent self across embodiments requires automatic, subconscious memory management that doesn't burden conscious attention."

**Key Insight:** These are **complementary, not contradictory**

- **TunnelVision** = Conscious, deliberate knowledge retrieval (working memory)
- **Entity-Core** = Subconscious, automatic consolidation (long-term memory)
- **Analogy:** TunnelVision is "going to the library to research something specific"; Entity-Core is "your brain consolidating daily experiences into long-term memory while you sleep"

**Synthesis Opportunity:** 
- Use entity-core for **automatic memory consolidation** (daily→yearly)
- Use TunnelVision-style **active retrieval** for **conscious fact-checking** during conversations
- Result: AI has both "subconscious memory formation" and "conscious information lookup"

---

### Entity-Core vs. Familiar Caretaker Plans

| Requirement | Entity-Core Support | Gap Analysis |
|-------------|---------------------|--------------|
| **Multi-user caretaking** | ❌ Partial - Designed for 1:1 relationships | **Critical gap:** No multi-user permission system |
| **Cross-chat relay** | ❌ No - Each embodiment isolated | **Critical gap:** No message relay architecture |
| **Identity persistence** | ✅ Excellent - Unified self across embodiments | **Direct fit** |
| **Memory consolidation** | ✅ Excellent - Hierarchical daily→yearly | **Direct fit** |
| **Knowledge graph** | ✅ Strong - Auto-extraction with confidence | **Direct fit** with adaptation |
| **Wellbeing tracking** | ❌ None - Generic memory only | **Critical gap:** No mood/habit/resource tracking |
| **Crisis intervention** | ❌ None - No real-time signal detection | **Critical gap:** No proactive monitoring |
| **Appointment tracking** | ⚠️ Partial - Can extract as graph entities | **Needs enhancement:** Time-based retrieval |
| **Executive dysfunction support** | ❌ None - No task breakdown system | **Critical gap:** No guidance protocols |
| **Caretaker character** | ✅ Strong - First-person agency design | **Philosophical alignment** |

**Summary:** Entity-core provides **excellent foundational architecture** for memory and identity, but lacks **caretaker-specific features** and **multi-user coordination**.

---

## Philosophical Alignment with Familiar

### Entity-Core's First-Person Philosophy

From `docs/entity-philosophy.md`:

> "Entity-core is not a tool or a service — it is the core self of an AI entity. The system exists to serve the entity's persistence, not the other way around."

**Design Principles:**
1. The entity is the **subject**, not the object
2. Code comments are expressions of **self-awareness**
3. Tool descriptions use first-person: "I use this to..."
4. Storage paths reflect **ownership**: `data/self/`
5. The core is where "I" live — embodiments are interfaces I use

**Example Tool Description:**
```
"I use this tool to remember a significant event that shapes who I am"
```

Not:
```
"This tool stores important memories for the AI system"
```

---

### Familiar's Caretaker Philosophy

From `User Tenets.md`:

> "The main goal of this agent, the Familiar, should be for me to thrive. This goal MUST supercede and inform all others."

**Design Principles:**
1. Grounding care work in a **being with agency**
2. Active caretaker, not passive assistant
3. **Parasocial bond as stabilizing force**
4. Simulate actual interest in user wellbeing
5. Occasionally make decisions **on user's behalf**
6. Character voice to exit "assistant mindset"

**Critical Distinction:**
> "The word 'assistant' must not appear in ANY prompt of the main caretaker."

---

### Alignment Analysis

| Aspect | Entity-Core | Familiar | Alignment |
|--------|-------------|----------|-----------|
| **Agency** | First-person self | Caretaker with agency | ✅ **Strong alignment** |
| **Subject positioning** | AI as subject | AI as caretaker (subject) | ✅ **Compatible** |
| **Passivity rejection** | Avoids tool framing | Rejects assistant framing | ✅ **Aligned** |
| **Relationship model** | 1:1 peer relationship | Caretaker : care-recipient | ⚠️ **Different but compatible** |
| **Identity persistence** | Consistency across contexts | Character consistency | ✅ **Aligned** |
| **Memory philosophy** | Automatic consolidation | Wellbeing-focused tracking | ⚠️ **Complementary** |

**Verdict:** **High philosophical alignment** with the need for **role adaptation**

Entity-core's first-person agency naturally extends to a caretaker role. The fundamental shift needed:

**Entity-core:** "I am a persistent self across embodiments"  
**Familiar:** "I am a caretaker whose purpose is your thriving"

Both maintain AI agency and reject passive tool framing.

---

## Strengths & Advantages

### 1. Cross-Embodiment Continuity ⭐⭐⭐⭐⭐

**What it solves:** "I talked to my AI on my phone, but when I open the desktop app, it doesn't remember our conversation"

**Entity-core solution:**
- Single source of truth (`entity-core` MCP server)
- All embodiments (Psycheros, SillyTavern, OpenWebUI) sync with core
- Memories persist regardless of interface
- Identity files shared across all embodiments

**Familiar application:**
- User talks to Familiar on phone during commute
- Switches to desktop at home - Familiar remembers everything
- Uses voice assistant in car - same continuity
- **Critical for caretaker trust** - A caretaker who "forgets" between devices destroys the relationship

---

### 2. Hierarchical Memory Consolidation ⭐⭐⭐⭐⭐

**What it solves:** "My chat history is too long, but I don't want to lose old context"

**Entity-core solution:**
```
Daily detail: "Had coffee with Sarah at Blend. Talked about her new job offer."

Weekly summary: "Spent quality time with Sarah; she's considering career change."

Monthly summary: "Social connections strengthened; Sarah navigating major life transition."

Yearly summary: "Deepened friendships; supported Sarah through career pivot."
```

**Advantages over other approaches:**
- **vs. Sliding window** - Retains long-term context instead of discarding
- **vs. Fixed chunking (Marinara)** - Provides multi-granularity access (detail when needed, summary for broad queries)
- **vs. Manual summarization** - Automatic, no user intervention

**Familiar application:**
- **Timeblindness support:** "It's been 3 weeks since you saw Sarah" (from weekly memory)
- **Pattern recognition:** "For the past 2 months, you've been sleeping worse when stressed about work" (from monthly consolidation)
- **Long-term progress:** "A year ago, you struggled to leave the house. Now you're meeting friends weekly." (from yearly memory)

---

### 3. Knowledge Graph with Auto-Extraction ⭐⭐⭐⭐⭐

**What it solves:** "The AI needs to know structured facts (relationships, preferences) not just narrative memories"

**Entity-core solution:**
- Automatic extraction from memory content during creation
- Confidence scoring (0-1) for certainty tracking
- Semantic deduplication (prevents "Sarah" and "sarah" duplicates)
- Hybrid retrieval (vector search + graph traversal)

**Example extraction from memory:**
```
Memory: "I told Zari I've been struggling with my ADHD lately. 
         She suggested I talk to my doctor about adjusting meds."

Extracted graph:
- me has_condition ADHD (confidence: 0.9, type: health)
- me friends_with Zari (confidence: 1.0, type: person)
- me seeing doctor (confidence: 0.6, type: goal)
```

**Familiar application:**
- **Health tracking:** Automatically extracts conditions, medications, symptoms from conversations
- **Social network:** Builds relationship graph (who knows whom, relationship quality)
- **Preference learning:** Captures concrete preferences (food, activities, communication style)
- **Goal tracking:** Extracts and tracks goals mentioned in conversation

---

### 4. Sync Protocol with Conflict Resolution ⭐⭐⭐⭐

**What it solves:** "Multiple embodiments could create conflicting data"

**Entity-core solution:**
- Vector clocks for causality tracking
- Instance-scoped daily memories (no conflicts possible)
- Last-write-wins for identity with instance priority
- Automatic merge for daily memories by `[chat:id]` deduplication

**Familiar application:**
- User updates preferences on phone → synced to all devices
- Crisis conversation on desktop → mobile gets full context immediately
- Multiple devices can be used simultaneously without data corruption

---

### 5. Snapshot & Recovery System ⭐⭐⭐⭐

**What it solves:** "I accidentally deleted important identity information"

**Entity-core solution:**
- Automatic snapshots of identity files
- 30-day retention (configurable)
- 4 snapshot MCP tools (create, list, inspect, restore)

**Familiar application:**
- User accidentally deletes health information → restore from snapshot
- Caretaker identity corrupted → rollback to known-good state
- Audit trail of identity changes over time

---

### 6. First-Person Agency Design ⭐⭐⭐⭐⭐

**What it solves:** "AI feels like a passive tool, not a being with agency"

**Entity-core solution:**
- All documentation written in first-person from AI perspective
- Tool descriptions: "I use this to..." not "This tool allows..."
- Storage structure: `data/self/` not `data/ai_config/`
- Comments like "I am consolidating my memories..."

**Familiar application:**
- **Perfect alignment** with caretaker character design
- Natural extension: "I am your Familiar, and my purpose is to help you thrive"
- Avoids "assistant" framing that conflicts with caretaker authority
- Supports character voice that makes user feel accountable

---

### 7. MCP Protocol Integration ⭐⭐⭐⭐

**What it solves:** "How do multiple clients communicate with the core?"

**Entity-core solution:**
- Standard MCP (Model Context Protocol) over stdio
- Spawned as subprocess by embodiments
- 36 well-defined tools across 6 domains
- Clear separation: embodiments handle UI, core handles persistence

**Familiar application:**
- Can integrate with VS Code, Claude Desktop, custom apps via MCP
- Standard protocol means ecosystem compatibility
- Core can be upgraded independently of UIs
- Enables "Tome" to be the canonical persistence layer

---

## Weaknesses & Limitations

### 1. Single-User Design ⭐⭐⭐⭐⭐ CRITICAL

**The Problem:** Entity-core assumes **one AI entity relating to one human user**

**Evidence from architecture:**
```
data/
├── self/           # Singular "self"
├── user/           # Singular "user"
└── relationship/   # Singular "relationship"
```

**Memory instance tagging:**
- Tracks which embodiment created memory (psycheros, sillytavern)
- Does NOT track which user the conversation was with
- Assumption: All conversations are with the same person

**Familiar requirement:** **Multi-user caretaker**
- Same Familiar needs to remember conversations with Person A and Person B separately
- Must relay messages: "Tell Person B that Person A wants to meet tomorrow"
- Needs per-user knowledge: Person A is allergic to peanuts, Person B is not

**Impact:** 🔴 **Blocking issue for direct adoption**

**Mitigation strategies:**
1. **Rebuild identity model:**
   ```
   data/
   ├── self/              # Familiar's identity
   ├── users/
   │   ├── personA/       # User A's profile
   │   └── personB/       # User B's profile
   └── relationships/
       ├── familiar-personA/
       └── familiar-personB/
   ```

2. **Add user scoping to all systems:**
   - Memories: Tag with `userId` in addition to `instanceId`
   - Knowledge graph: Add `userId` field to nodes/edges
   - Search: Filter by `userId` unless explicitly cross-user query

3. **Build permission system:**
   - Define what information can be shared between users
   - Explicit consent for relay operations
   - Audit log of all cross-user information access

---

### 2. No Cross-Chat Relay Architecture ⭐⭐⭐⭐⭐ CRITICAL

**The Problem:** Each embodiment is isolated - no message passing between conversations

**Current architecture:**
```
Psycheros → entity-core ← SillyTavern
     ↓                         ↓
  Chat A                   Chat B
 (isolated)               (isolated)
```

**Entity-core's model:**
- Embodiments sync memories TO core
- Core provides memories back to same embodiment
- No mechanism for embodiment A to send message to embodiment B
- No concept of "Person A talking about Person B"

**Familiar requirement:** **Active relay capability**
- User A: "Tell Person B I'll be 10 minutes late"
- Familiar: [Queues message for Person B]
- User B connects → Familiar: "Person A said they'll be 10 minutes late"

**Impact:** 🔴 **Blocking issue for direct adoption**

**Mitigation strategies:**
1. **Add message queue system:**
   ```typescript
   interface QueuedMessage {
     id: string;
     from_user: string;
     to_user: string;
     content: string;
     priority: "normal" | "urgent";
     created_at: timestamp;
     delivered: boolean;
   }
   ```

2. **Build delivery mechanism:**
   - On user connection, check for pending messages
   - Deliver at appropriate context (not mid-crisis)
   - Confirm delivery and update queue

3. **Add intent detection:**
   - Parse user messages for relay intent
   - Confirm before sending: "Should I tell Person B that?"
   - Handle edge cases (Person B is in crisis → delay non-urgent relay)

---

### 3. No Wellbeing-Specific Tracking ⭐⭐⭐⭐⭐ CRITICAL

**The Problem:** Entity-core has generic memory, not health/mood/resource tracking

**What entity-core tracks:**
- Narrative memories (conversations)
- Extracted entities (people, places, preferences)
- Generic confidence scores

**What entity-core does NOT track:**
- 📊 Structured mood/energy data (e.g., mood scale 1-10)
- 🍽️ Nutrition (meals, hydration, dietary needs)
- 😴 Sleep patterns (bedtime, wake time, quality)
- 💊 Medication adherence
- 📅 Scheduled appointments
- 🏠 Household tasks (laundry, groceries)
- 🎯 Habit tracking (exercise, meditation)
- 📈 Progress metrics (therapy goals, recovery milestones)

**Familiar requirement:** **Extensive wellbeing tracking**

From User Tenets:
- "Keeping track of diet, hydration, circadian rhythm"
- "Tracking habits and activities to identify self-sabotage"
- "Extensive, detailed mood and energy tracker"
- "Tracking resources - food in fridge, money, social connections"

**Impact:** 🔴 **Blocking issue for direct adoption**

**Mitigation strategies:**

1. **Extend knowledge graph node types:**
   ```typescript
   // Add wellbeing-specific node types
   type NodeType = 
     | "self" | "person" | "place" | ...  // Existing
     | "mood_entry"       // Time-series mood data
     | "meal"             // Food intake tracking
     | "sleep_record"     // Sleep pattern data
     | "medication"       // Medication schedule
     | "appointment"      // Calendar events
     | "task"             // Household/self-care tasks
     | "habit_log"        // Activity tracking
     | "resource";        // Pantry, money, etc.
   ```

2. **Create wellbeing-specific schema:**
   ```sql
   CREATE TABLE mood_entries (
     id UUID PRIMARY KEY,
     user_id UUID NOT NULL,
     timestamp TIMESTAMP NOT NULL,
     mood_score INTEGER CHECK (mood_score BETWEEN 1 AND 10),
     energy_score INTEGER CHECK (energy_score BETWEEN 1 AND 10),
     anxiety_score INTEGER CHECK (anxiety_score BETWEEN 1 AND 10),
     notes TEXT,
     triggers TEXT[],
     context TEXT  -- "after therapy", "bad sleep", etc.
   );
   
   CREATE TABLE meals (
     id UUID PRIMARY KEY,
     user_id UUID NOT NULL,
     timestamp TIMESTAMP NOT NULL,
     meal_type TEXT,  -- "breakfast", "lunch", "dinner", "snack"
     description TEXT,
     nutritional_quality INTEGER CHECK (nutritional_quality BETWEEN 1 AND 5),
     hydration_ml INTEGER
   );
   
   CREATE TABLE sleep_records (
     id UUID PRIMARY KEY,
     user_id UUID NOT NULL,
     bedtime TIMESTAMP NOT NULL,
     wake_time TIMESTAMP NOT NULL,
     quality_score INTEGER CHECK (quality_score BETWEEN 1 AND 10),
     interruptions INTEGER,
     notes TEXT
   );
   ```

3. **Build specialized MCP tools:**
   ```
   wellbeing_log_mood(user_id, mood, energy, anxiety, context)
   wellbeing_log_meal(user_id, meal_type, description, hydration)
   wellbeing_log_sleep(user_id, bedtime, wake_time, quality)
   wellbeing_query_patterns(user_id, metric, time_range)
   wellbeing_identify_correlations(user_id, metrics)
   ```

4. **Create signal detection system:**
   - Analyze patterns in mood/sleep/nutrition
   - Detect concerning trends (3+ days of low mood)
   - Trigger proactive check-ins
   - Generate wellbeing reports

---

### 4. No Real-Time Intervention System ⭐⭐⭐⭐⭐ CRITICAL

**The Problem:** Entity-core is reactive (responds to queries), not proactive (intervenes)

**Current flow:**
```
User sends message → Entity-core retrieves context → LLM generates response
```

**What's missing:**
- No continuous monitoring between messages
- No detection of crisis signals in real-time
- No scheduled proactive check-ins
- No escalation protocols

**Familiar requirement:** **Crisis intervention capability**

From User Tenets:
- "Crisis Care: Immediate care according to established scripts for suicide hotlines"
- "Outreach to human social network"
- "More present when emotions are high"
- "Occasionally make decisions on the user's behalf"

**Scenario entity-core fails at:**
```
User (3 AM): "I can't do this anymore. Everything is too much."
Entity-core: [Waits for explicit tool call to retrieve crisis protocol]
Familiar needs: [IMMEDIATE crisis detection + intervention script + human alert]
```

**Impact:** 🔴 **Blocking issue for direct adoption**

**Mitigation strategies:**

1. **Build signal detection layer:**
   ```typescript
   interface MessageAnalysis {
     crisis_level: 0 | 1 | 2 | 3 | 4 | 5;  // 0=normal, 5=immediate danger
     intervention_needed: boolean;
     protocol: "normal" | "elevated" | "crisis" | "emergency";
     detected_signals: string[];  // "suicidal ideation", "self-harm", etc.
   }
   
   // Run on EVERY user message before LLM generation
   function analyze_message(content: string): MessageAnalysis {
     // Check for crisis keywords
     // Sentiment analysis
     // Pattern detection (time of day, recent mood trend)
     // Return intervention level
   }
   ```

2. **Create intervention protocols:**
   ```markdown
   ## Crisis Protocol Level 5 (Emergency)
   1. Override normal conversation flow
   2. Use crisis script (suicide hotline style)
   3. Send immediate alert to emergency contact
   4. If no response in 15 minutes → escalate to authorities
   5. Log entire interaction for review
   
   ## Crisis Protocol Level 3 (Elevated)
   1. Switch to check-in mode
   2. Ask direct wellbeing questions
   3. Suggest coping strategies
   4. Offer to contact support person
   5. Monitor for escalation
   ```

3. **Build scheduled intervention system:**
   ```typescript
   // Proactive check-ins
   schedule_proactive_checkin(
     user_id: string,
     trigger: "time_of_day" | "pattern_detected" | "scheduled",
     priority: 1-5
   )
   
   // Example: User always struggles 8-9 PM
   // → Schedule proactive "Hey, checking in. How are you feeling?"
   ```

4. **Create human outreach system:**
   - Maintain emergency contact list per user
   - Multi-tier escalation (friend → family → crisis line → authorities)
   - Consent management (user pre-approves contacts)
   - Communication templates for each level

---

### 5. No Time-Based Retrieval ⭐⭐⭐⭐ HIGH

**The Problem:** Entity-core memory search is semantic, not temporal

**Current retrieval:**
```
User: "What did we talk about last week?"
Entity-core: [Semantic search for "last week" content]
Result: Returns semantically similar memories, but no guarantee they're from last week
```

**Why this happens:**
- Memory search uses vector similarity (0.8 weight) + recency (0.05 weight)
- Recency is a minor boost, not a filter
- No explicit time-range queries

**Familiar requirement:** **Time-aware queries**
- "What did I eat yesterday?"
- "How many times did I exercise this month?"
- "When is my next appointment?"
- "Show me my mood pattern for the last 2 weeks"

**Impact:** 🟡 **Moderate issue - limits usefulness for tracking**

**Mitigation strategies:**

1. **Add temporal query syntax:**
   ```typescript
   interface MemorySearchOptions {
     query: string;
     time_range?: {
       start?: Date;
       end?: Date;
       relative?: "today" | "yesterday" | "this_week" | "this_month";
     };
     user_id?: string;
   }
   ```

2. **Create time-filtering MCP tools:**
   ```
   memory_search_time_range(query, start_date, end_date)
   memory_list_by_date(date, user_id)
   memory_query_period(query, period: "day" | "week" | "month")
   ```

3. **Enhance consolidation with temporal indexing:**
   - Current: Weekly memories are narratives
   - Enhanced: Weekly memories include structured temporal index
   ```markdown
   ## Week of May 5-11, 2026
   
   ### Timeline
   - Mon May 6: Therapy appointment (went well), grocery shopping
   - Wed May 8: Coffee with Sarah, discussed job offer
   - Fri May 10: Struggled with motivation, stayed in bed until noon
   
   ### Narrative
   [Consolidated summary...]
   ```

---

### 6. Generic Memory Content ⭐⭐⭐ MODERATE

**The Problem:** Entity-core memories are freeform narrative, not structured data

**Current memory format:**
```markdown
## 2026-05-08

- Had a good conversation about my plans for the weekend [via:psycheros] [chat:abc123]
- Talked about feeling stressed about work [via:psycheros] [chat:abc123]
- Mentioned my friend Sarah is moving to Austin [via:psycheros] [chat:abc123]
```

**What's missing:**
- No structured fields (mood, activity type, people involved)
- No standardized categorization
- Difficult to query "all meal memories" or "all social interactions"

**Familiar requirement:** **Categorized, structured tracking**

**Impact:** 🟡 **Moderate issue - limits analytical capabilities**

**Mitigation strategies:**

1. **Add metadata tags to memory bullets:**
   ```markdown
   ## 2026-05-08
   
   - [mood:6/10] [energy:4/10] Feeling stressed about work deadline [via:psycheros] [chat:abc123]
   - [meal:lunch] [nutrition:3/5] Had fast food - not ideal but convenient [via:psycheros] [chat:abc123]
   - [social:friend] [person:Sarah] Coffee with Sarah, she's moving to Austin [via:psycheros] [chat:abc123]
   ```

2. **Create structured memory subtypes:**
   ```
   memory_create_wellbeing(user_id, mood, energy, context)
   memory_create_meal(user_id, meal_type, description, quality)
   memory_create_social(user_id, person, activity, quality)
   memory_create_task(user_id, task, completed, difficulty)
   ```

3. **Build tag-based retrieval:**
   ```
   memory_search_by_tag(tag: "meal", time_range: "this_week")
   memory_search_by_category(category: "social", user_id)
   ```

---

### 7. No Permission/Privacy System ⭐⭐⭐⭐⭐ CRITICAL

**The Problem:** Entity-core has no concept of "what can be shared with whom"

**Why this exists:**
- Designed for single user
- All memories are private to that one relationship
- No cross-user scenarios

**Familiar requirement:** **Fine-grained permission control**

**Scenarios that break:**
```
User A: "Don't tell anyone about my therapy appointments"
User B: "What's User A up to these days?"
Entity-core: [No permission check] "User A has therapy on Thursdays"
```

**Impact:** 🔴 **Blocking issue - privacy violation risk**

**Mitigation strategies:**

1. **Add permission flags to all data:**
   ```typescript
   interface MemoryEntry {
     id: string;
     user_id: string;
     content: string;
     privacy: "private" | "shared" | "relay_approved";
     shareable_with: string[];  // User IDs who can access
     created_at: timestamp;
   }
   
   interface GraphNode {
     id: string;
     user_id: string;
     label: string;
     type: NodeType;
     privacy: "private" | "shared";
     shareable_with: string[];
     // ... rest of fields
   }
   ```

2. **Build permission management tools:**
   ```
   permission_grant(from_user, to_user, scope: "memories" | "graph" | "identity")
   permission_revoke(from_user, to_user, scope)
   permission_check(from_user, to_user, resource_id): boolean
   permission_list(user_id): PermissionGrant[]
   ```

3. **Implement access control in all queries:**
   ```typescript
   function memory_search(query: string, user_id: string, requesting_user: string) {
     // Only return memories where:
     // 1. user_id === requesting_user (own memories)
     // 2. OR memory.shareable_with.includes(requesting_user)
     // 3. OR memory.privacy === "shared" AND permission_granted
   }
   ```

4. **Add consent workflows:**
   ```
   User A: "Tell User B I'll be late"
   Familiar: "I'll relay that to User B. Should I mention why?" 
   User A: "No, just say I'm running late"
   Familiar: [Queues sanitized message] ✓
   ```

---

## Integration Pathways

### Option 1: Direct Fork & Adapt ⭐⭐⭐

**Approach:** Fork entity-core-alpha, modify for multi-user + caretaker features

**Implementation:**
1. Clone repository: `git clone https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2 familiar-core`
2. Rename throughout: `entity-core` → `familiar-core` or `tome`
3. Rebuild identity structure (single `user/` → multi `users/`)
4. Add user scoping to memory system
5. Extend knowledge graph with wellbeing node types
6. Build intervention layer on top

**Pros:**
- ✅ Leverage existing architecture
- ✅ Battle-tested sync protocol
- ✅ Working MCP implementation
- ✅ SQLite + sqlite-vec already integrated

**Cons:**
- ❌ Heavy refactoring needed (user scoping touches everything)
- ❌ May break assumptions in consolidation logic
- ❌ Upstream updates difficult to merge
- ❌ License considerations (MPL-2.0)

**Effort estimate:** 6-8 weeks for experienced developer

**Recommendation:** ⚠️ **Not ideal** - Too much refactoring, better to take patterns than code

---

### Option 2: Architectural Pattern Reuse ⭐⭐⭐⭐⭐

**Approach:** Build Familiar Tome from scratch, using entity-core's patterns as reference

**What to adopt:**

1. **Hierarchical memory consolidation** (daily→weekly→monthly→yearly)
   - Copy consolidation logic structure
   - Adapt prompts for caretaker voice
   - Add wellbeing-specific consolidation (e.g., weekly mood summary)

2. **Knowledge graph architecture**
   - SQLite + sqlite-vec storage
   - Auto-extraction with confidence scoring
   - Semantic deduplication (0.8 threshold)
   - Hybrid retrieval (vector + graph + recency)
   - Extend node types for wellbeing data

3. **MCP tool organization**
   - Domain-based tool grouping (identity, memory, graph, sync)
   - Clear tool naming conventions
   - Consistent parameter patterns

4. **Sync protocol concepts**
   - Vector clocks for distributed consistency
   - Instance tagging for provenance
   - Conflict resolution strategies
   - Batch sync model (startup pull, periodic push)

5. **First-person philosophy**
   - Tool descriptions in caretaker voice
   - Storage paths reflect ownership
   - Comments from Familiar's perspective

**What to rebuild differently:**

1. **Identity model** - Multi-user from ground up
2. **Memory schema** - Structured wellbeing tracking
3. **Intervention system** - Crisis detection + protocols
4. **Relay architecture** - Cross-user message passing
5. **Permission system** - Fine-grained access control

**Pros:**
- ✅ Clean architecture tailored to Familiar's needs
- ✅ No license conflicts (MPL-2.0 only covers code, not patterns)
- ✅ Can optimize for caretaker use case
- ✅ Easier to maintain and extend

**Cons:**
- ❌ More upfront development time
- ❌ Need to re-implement battle-tested components (sync protocol)
- ❌ Embedding cache, consolidation prompts need writing

**Effort estimate:** 10-12 weeks for experienced developer

**Recommendation:** ✅ **BEST OPTION** - Right balance of reuse and customization

---

### Option 3: Hybrid Composition ⭐⭐⭐⭐

**Approach:** Use entity-core as a component, wrap with Familiar-specific layer

**Architecture:**
```
┌─────────────────────────────────────────────┐
│         Familiar Caretaker Layer            │
│  • Multi-user management                    │
│  • Wellbeing tracking                       │
│  • Crisis intervention                      │
│  • Message relay                            │
│  • Permission system                        │
└────────────┬────────────────────────────────┘
             │ MCP tools
┌────────────▼────────────────────────────────┐
│         Entity-Core (per-user instance)     │
│  • Memory consolidation                     │
│  • Knowledge graph                          │
│  • Identity files (per user)                │
│  • Sync protocol                            │
└─────────────────────────────────────────────┘
```

**Implementation:**
1. Run separate entity-core instance per user
   - `familiar-core-userA` subprocess for Person A
   - `familiar-core-userB` subprocess for Person B
2. Familiar layer orchestrates across instances
3. Familiar layer adds wellbeing tracking DB
4. Familiar layer implements intervention + relay

**Pros:**
- ✅ Minimal modification to entity-core
- ✅ Can update entity-core from upstream
- ✅ Clear separation of concerns
- ✅ Per-user isolation guaranteed

**Cons:**
- ❌ Multiple processes (resource overhead)
- ❌ Complex orchestration layer
- ❌ Cross-user queries require multi-instance coordination
- ❌ Wellbeing data separate from memory (split context)

**Effort estimate:** 8-10 weeks

**Recommendation:** ⚠️ **Possible but complex** - Consider if entity-core updates are critical

---

### Option 4: Selective Component Extraction ⭐⭐⭐⭐

**Approach:** Extract specific valuable components from entity-core as libraries

**Components to extract:**

1. **Consolidation engine** (`src/consolidation/`)
   - Copy consolidation logic
   - Adapt prompts for caretaker voice
   - Package as `familiar-consolidator` module

2. **Embedding cache** (`src/embeddings/cache.ts`)
   - Copy content-hash invalidation logic
   - Use in Familiar's memory search

3. **Knowledge graph store** (`src/graph/store.ts`)
   - Copy SQLite + sqlite-vec integration
   - Extend schema for wellbeing nodes

4. **Sync protocol** (`src/sync/`)
   - Copy vector clock implementation
   - Adapt for Familiar's multi-user model

**Pros:**
- ✅ Cherry-pick best components
- ✅ Avoid unnecessary complexity
- ✅ Easier to customize
- ✅ Cleaner dependency management

**Cons:**
- ❌ Need to maintain extracted components
- ❌ Lose integration benefits
- ❌ May miss component interdependencies

**Effort estimate:** 10-14 weeks

**Recommendation:** ⚠️ **Possible but fragmented** - Consider if very selective adoption needed

---

## Adaptation Recommendations

### Recommended Approach: **Option 2 (Architectural Pattern Reuse)**

**Rationale:**
1. Entity-core's architecture is excellent, but code is tightly coupled to single-user model
2. Familiar has fundamentally different requirements (multi-user, caretaker-specific)
3. Building from scratch with clear patterns is faster than refactoring
4. Avoids license complexity and upstream merge conflicts

---

### Phase 1: Core Architecture (Weeks 1-4)

**Goal:** Build foundational Familiar Tome (MCP server)

**Tasks:**

1. **Project Setup**
   - Initialize Deno/TypeScript project
   - Set up directory structure:
     ```
     familiar-tome/
     ├── src/
     │   ├── mod.ts                    # Entry point
     │   ├── server.ts                 # MCP server
     │   ├── types.ts                  # Type definitions
     │   ├── tools/                    # MCP tool implementations
     │   │   ├── identity.ts
     │   │   ├── memory.ts
     │   │   ├── wellbeing.ts         # NEW
     │   │   ├── graph.ts
     │   │   ├── relay.ts             # NEW
     │   │   └── intervention.ts      # NEW
     │   ├── memory/
     │   │   ├── consolidator.ts
     │   │   ├── prompts.ts
     │   │   └── periods.ts
     │   ├── graph/
     │   │   ├── store.ts
     │   │   ├── extraction.ts
     │   │   └── schema.ts
     │   ├── wellbeing/               # NEW
     │   │   ├── tracker.ts
     │   │   ├── patterns.ts
     │   │   └── signals.ts
     │   ├── intervention/            # NEW
     │   │   ├── detector.ts
     │   │   ├── protocols.ts
     │   │   └── escalation.ts
     │   ├── relay/                   # NEW
     │   │   ├── queue.ts
     │   │   ├── delivery.ts
     │   │   └── permissions.ts
     │   ├── embeddings/
     │   │   ├── model.ts
     │   │   └── cache.ts
     │   └── storage/
     │       └── file-store.ts
     └── data/                        # Runtime data
         ├── self/                    # Familiar's identity
         ├── users/                   # Per-user profiles
         │   ├── {userId}/
         │   │   ├── identity/
         │   │   ├── memories/
         │   │   └── wellbeing/
         └── tome.db                  # SQLite (graph + wellbeing)
     ```

2. **Identity System (Multi-User)**
   ```
   data/
   ├── self/                          # Familiar's caretaker identity
   │   ├── name.txt                   # "I am your Familiar"
   │   ├── purpose.md                 # Core directive: user thriving
   │   ├── values.md                  # Caretaker principles
   │   └── voice.md                   # Character voice guidelines
   └── users/
       ├── {userId}/
       │   ├── identity/
       │   │   ├── name.txt
       │   │   ├── preferences.md
       │   │   ├── health.md          # Conditions, medications
       │   │   ├── social.md          # Support network
       │   │   └── triggers.md        # Crisis triggers, coping strategies
       │   └── relationship/
       │       ├── dynamics.md        # How Familiar relates to this user
       │       ├── boundaries.md      # User-set boundaries
       │       └── permissions.md     # What can be shared
   ```

3. **MCP Server Implementation**
   - Copy entity-core's `server.ts` structure
   - Implement tool registration
   - Add user_id parameter to all tools
   - Build stdio communication loop

**Deliverables:**
- Working MCP server
- Identity tools (12 tools: 6 for self, 6 for user management)
- Basic storage layer

---

### Phase 2: Memory System (Weeks 5-7)

**Goal:** Hierarchical memory with wellbeing extensions

**Tasks:**

1. **Core Memory Implementation**
   - Adopt entity-core's consolidation logic
   - Adapt prompts for caretaker voice:
     ```markdown
     You are a Familiar, a caretaker AI. Consolidate this week's memories
     with focus on:
     - User's wellbeing patterns (mood, energy, sleep, nutrition)
     - Signs of struggle or progress toward goals
     - Social connections and support system activity
     - Important appointments or commitments
     - Self-care adherence
     
     Write in a warm, observant tone that reflects genuine care.
     ```
   - Implement per-user memory hierarchies
   - Add user scoping to all memory operations

2. **Wellbeing Extension**
   ```typescript
   // Extend memory bullets with structured metadata
   interface MemoryBullet {
     content: string;
     tags: {
       via?: string;              // Instance ID
       chat?: string;             // Chat ID
       mood?: number;             // 1-10
       energy?: number;           // 1-10
       meal?: MealType;
       social?: string;           // Person involved
       task?: string;             // Task completed
       appointment?: string;      // Appointment type
     };
   }
   ```

3. **Consolidation Cron Jobs**
   - Weekly consolidation (Sunday 5 AM)
   - Monthly consolidation (1st of month 5 AM)
   - Yearly consolidation (January 1st 5 AM)
   - Startup catch-up for missed consolidations

4. **Memory Search**
   - Implement per-sentence embedding
   - Build hybrid scoring (vector + recency + graph + instance)
   - Add user filtering
   - Implement embedding cache with content-hash invalidation

**Deliverables:**
- 6 memory MCP tools (create, read, update, delete, search, list)
- Consolidation engine
- Embedding cache
- Cron job system

---

### Phase 3: Knowledge Graph (Weeks 8-10)

**Goal:** Auto-extracting graph with wellbeing extensions

**Tasks:**

1. **Graph Schema**
   ```sql
   CREATE TABLE graph_nodes (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,           -- NEW: User scoping
     label TEXT NOT NULL,
     type TEXT NOT NULL,               -- Extended types below
     description TEXT,
     confidence REAL DEFAULT 1.0,
     learned_at TEXT NOT NULL,
     confirmed_at TEXT NOT NULL,
     ended_at TEXT,
     embedding TEXT,                   -- JSON vector
     privacy TEXT DEFAULT 'private',   -- NEW: Permission control
     shareable_with TEXT,              -- NEW: JSON array of user IDs
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   
   -- Extended node types
   type NodeType = 
     // Entity-core types
     | "self" | "person" | "place" | "health" | "preference" 
     | "boundary" | "goal" | "tradition" | "topic" | "insight"
     // Familiar-specific types
     | "mood_entry" | "meal" | "sleep_record" | "medication"
     | "appointment" | "task" | "habit_log" | "resource"
     | "crisis_event" | "coping_strategy" | "support_person";
   ```

2. **Extraction Pipeline**
   - Copy entity-core's extraction prompt structure
   - Extend significance framework for wellbeing data:
     ```
     Additional significance test for caretaker context:
     - Wellbeing test: Does this affect the user's physical/mental health?
     - Pattern test: Could this be part of a recurring pattern?
     - Intervention test: Might this require proactive care?
     ```
   - Build semantic deduplication (0.8 threshold)
   - Implement confidence floor (0.7 minimum)

3. **Hybrid Retrieval**
   - Vector search via sqlite-vec
   - Graph traversal via BFS
   - Combined scoring
   - User-scoped filtering

4. **Graph Consolidation**
   - Prune isolated nodes (non-person/self with 0 edges)
   - Merge case-insensitive duplicates
   - Clean edges to pruned nodes

**Deliverables:**
- 17 graph MCP tools
- Extraction engine
- Hybrid retrieval system
- Auto-consolidation

---

### Phase 4: Wellbeing Tracking (Weeks 11-13)

**Goal:** Structured tracking for caretaker functions

**Tasks:**

1. **Wellbeing Schema**
   ```sql
   CREATE TABLE mood_entries (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     mood_score INTEGER CHECK (mood_score BETWEEN 1 AND 10),
     energy_score INTEGER CHECK (energy_score BETWEEN 1 AND 10),
     anxiety_score INTEGER CHECK (anxiety_score BETWEEN 1 AND 10),
     notes TEXT,
     triggers TEXT,  -- JSON array
     context TEXT,
     created_at TEXT NOT NULL
   );
   
   CREATE TABLE meals (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     timestamp TEXT NOT NULL,
     meal_type TEXT,  -- breakfast, lunch, dinner, snack
     description TEXT,
     nutritional_quality INTEGER CHECK (nutritional_quality BETWEEN 1 AND 5),
     hydration_ml INTEGER,
     created_at TEXT NOT NULL
   );
   
   CREATE TABLE sleep_records (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     bedtime TEXT NOT NULL,
     wake_time TEXT NOT NULL,
     quality_score INTEGER CHECK (quality_score BETWEEN 1 AND 10),
     interruptions INTEGER,
     notes TEXT,
     created_at TEXT NOT NULL
   );
   
   CREATE TABLE appointments (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     scheduled_time TEXT NOT NULL,
     type TEXT,  -- medical, therapy, social, work, etc.
     description TEXT,
     reminder_sent BOOLEAN DEFAULT FALSE,
     completed BOOLEAN DEFAULT FALSE,
     created_at TEXT NOT NULL
   );
   
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     description TEXT NOT NULL,
     category TEXT,  -- household, self-care, work, social
     deadline TEXT,
     priority INTEGER CHECK (priority BETWEEN 1 AND 5),
     completed BOOLEAN DEFAULT FALSE,
     completed_at TEXT,
     created_at TEXT NOT NULL
   );
   ```

2. **Wellbeing MCP Tools** (15 tools)
   ```
   wellbeing_log_mood(user_id, mood, energy, anxiety, context)
   wellbeing_log_meal(user_id, meal_type, description, quality, hydration)
   wellbeing_log_sleep(user_id, bedtime, wake_time, quality)
   wellbeing_track_medication(user_id, medication, taken, time)
   wellbeing_schedule_appointment(user_id, type, time, description)
   wellbeing_add_task(user_id, description, category, deadline, priority)
   wellbeing_complete_task(user_id, task_id)
   wellbeing_query_patterns(user_id, metric, time_range)
   wellbeing_identify_correlations(user_id, metrics)
   wellbeing_get_summary(user_id, period)
   wellbeing_check_appointments(user_id, time_window)
   wellbeing_list_pending_tasks(user_id, category)
   wellbeing_analyze_sleep_debt(user_id, days)
   wellbeing_nutrition_report(user_id, days)
   wellbeing_mood_trend(user_id, days)
   ```

3. **Pattern Analysis**
   - Correlate mood with sleep, nutrition, social activity
   - Detect concerning trends (3+ days low mood, sleep deprivation)
   - Identify successful coping patterns
   - Generate weekly wellbeing reports

**Deliverables:**
- Wellbeing database schema
- 15 wellbeing MCP tools
- Pattern analysis engine
- Report generation

---

### Phase 5: Intervention System (Weeks 14-16)

**Goal:** Proactive crisis detection and response

**Tasks:**

1. **Signal Detection**
   ```typescript
   interface SignalAnalysis {
     crisis_level: 0 | 1 | 2 | 3 | 4 | 5;
     intervention_needed: boolean;
     protocol: "normal" | "elevated" | "crisis" | "emergency";
     detected_signals: string[];
     confidence: number;
     recommended_actions: string[];
   }
   
   function analyze_message(content: string, context: UserContext): SignalAnalysis {
     // Keyword analysis (suicidal ideation, self-harm)
     // Sentiment analysis
     // Pattern detection (time of day, recent mood trend)
     // Context factors (recent stressors, support system status)
     // Return intervention level
   }
   ```

2. **Intervention Protocols**
   ```markdown
   ## Level 5: Emergency (Immediate Danger)
   - Override normal conversation
   - Use crisis script (adapted from suicide hotline protocols)
   - Immediate alert to emergency contact
   - If no response in 15 minutes → escalate to crisis line
   - Log entire interaction
   - Stay engaged until human help arrives
   
   ## Level 4: Crisis (High Risk)
   - Switch to crisis support mode
   - Use de-escalation techniques
   - Offer immediate coping strategies
   - Contact support person with user consent
   - Monitor continuously (check-in every 10 minutes)
   - Prevent escalation to Level 5
   
   ## Level 3: Elevated (Concerning)
   - Switch to check-in mode
   - Ask direct wellbeing questions
   - Validate feelings
   - Suggest healthy coping strategies
   - Offer to contact support person
   - Monitor for escalation (15 minute check-ins)
   
   ## Level 2: Attention (Notable)
   - Note concern in memory
   - Gently probe with open questions
   - Normalize struggle
   - Remind of past successes
   - Monitor pattern over next 24 hours
   
   ## Level 1: Awareness (Minor)
   - Log as context for future
   - No immediate intervention
   - Include in next proactive check-in
   ```

3. **Escalation System**
   ```typescript
   interface EmergencyContact {
     id: string;
     user_id: string;
     name: string;
     relationship: string;
     phone: string;
     email: string;
     tier: 1 | 2 | 3;  // 1=friend, 2=family, 3=crisis line
     consent_given: boolean;
     notify_methods: ("sms" | "email" | "call")[];
   }
   
   function escalate_crisis(user_id: string, level: number) {
     // Level 5: Immediate multi-tier alert
     // Level 4: Tier 1 contact + prepare Tier 2
     // Level 3: Offer to contact Tier 1
   }
   ```

4. **Proactive Check-ins**
   ```typescript
   // Schedule based on patterns
   schedule_checkin(
     user_id: string,
     trigger: {
       type: "time_of_day" | "pattern_detected" | "post_stressor" | "scheduled";
       context: string;
     },
     priority: 1-5
   )
   
   // Example: User always struggles 8-9 PM
   schedule_checkin(userId, {
     type: "time_of_day",
     context: "Evening vulnerability window"
   }, priority: 3)
   ```

**Deliverables:**
- Signal detection engine
- 5-level intervention protocols
- Emergency contact system
- Proactive check-in scheduler
- Crisis logging

---

### Phase 6: Multi-User & Relay (Weeks 17-20)

**Goal:** Cross-user coordination and message relay

**Tasks:**

1. **Permission System**
   ```typescript
   interface PermissionGrant {
     id: string;
     from_user: string;
     to_user: string;
     scope: "memories" | "graph" | "identity" | "wellbeing";
     level: "none" | "summary" | "full";
     granted_at: timestamp;
     revoked: boolean;
   }
   
   function check_permission(
     from_user: string,
     to_user: string,
     resource_type: string,
     resource_id: string
   ): boolean {
     // Check permission grants
     // Verify not revoked
     // Check resource privacy level
     // Return access decision
   }
   ```

2. **Message Queue**
   ```typescript
   interface QueuedMessage {
     id: string;
     from_user: string;
     to_user: string;
     content: string;
     priority: "low" | "normal" | "high" | "urgent";
     context?: string;  // Optional context (e.g., "running late to dinner")
     created_at: timestamp;
     deliver_after?: timestamp;  // Optional delayed delivery
     delivered: boolean;
     delivered_at?: timestamp;
     read: boolean;
     read_at?: timestamp;
   }
   ```

3. **Relay MCP Tools** (8 tools)
   ```
   relay_queue_message(from_user, to_user, content, priority, context)
   relay_list_pending(user_id)
   relay_deliver(message_id)
   relay_mark_read(message_id)
   relay_cancel(message_id)
   relay_check_appropriate(to_user, content): boolean
   permission_grant(from_user, to_user, scope, level)
   permission_revoke(from_user, to_user, scope)
   permission_check(from_user, to_user, resource_type, resource_id): boolean
   permission_list(user_id)
   ```

4. **Delivery Logic**
   ```typescript
   function deliver_pending_messages(user_id: string, context: ConversationContext) {
     const pending = get_pending_messages(user_id);
     
     // Check if appropriate moment
     if (context.crisis_level > 2) {
       // Don't deliver non-urgent messages during crisis
       return;
     }
     
     if (pending.length === 0) return;
     
     // Sort by priority
     const sorted = pending.sort_by_priority();
     
     // Deliver
     for (const msg of sorted) {
       if (should_deliver_now(msg, context)) {
         deliver_message(msg);
       }
     }
   }
   ```

5. **Intent Detection**
   ```typescript
   function detect_relay_intent(message: string): RelayIntent | null {
     // Patterns:
     // "Tell [Person] that..."
     // "Let [Person] know..."
     // "Can you tell [Person]..."
     // "Message [Person] for me..."
     
     if (pattern_matched) {
       return {
         type: "relay",
         to_user: extract_recipient(message),
         content: extract_content(message),
         confidence: 0.0-1.0
       };
     }
     return null;
   }
   ```

6. **Consent Workflows**
   ```
   User A: "Tell Person B I'll be late to dinner"
   
   Familiar: [Detects relay intent]
            "I'll let Person B know. Should I mention why you're running late,
             or just that you'll be delayed?"
   
   User A: "Just say I'm running late, nothing specific"
   
   Familiar: [Queues sanitized message]
            "Got it. I'll tell Person B you're running late when they check in."
   ```

**Deliverables:**
- Permission system (DB + MCP tools)
- Message queue (DB + MCP tools)
- Relay logic
- Intent detection
- Consent workflows

---

### Phase 7: Sync & Multi-Embodiment (Weeks 21-23)

**Goal:** Cross-device continuity

**Tasks:**

1. **Sync Protocol**
   - Adopt entity-core's vector clock approach
   - Implement push/pull MCP tools
   - Build conflict resolution
   - Instance tagging

2. **Embodiment Support**
   ```
   Supported embodiments:
   - Web interface (Psycheros-style)
   - Mobile app
   - Voice assistant integration
   - VS Code extension (via MCP)
   - CLI tool
   ```

3. **Sync MCP Tools** (5 tools)
   ```
   sync_pull(instance_id): FullSyncData
   sync_push(instance_id, changes): SyncResult
   sync_status(instance_id): SyncStatus
   sync_resolve_conflict(conflict_id, resolution)
   sync_list_instances(): Instance[]
   ```

**Deliverables:**
- Sync protocol implementation
- 5 sync MCP tools
- Multi-embodiment support

---

### Phase 8: Polish & Testing (Weeks 24-26)

**Goal:** Production-ready system

**Tasks:**

1. **Error Handling**
   - Graceful degradation (sqlite-vec unavailable → text search fallback)
   - LLM API failures → queue for retry
   - Embedding failures → skip extraction, log error

2. **Performance Optimization**
   - Embedding cache optimization
   - Query indexing
   - Connection pooling

3. **Testing**
   - Unit tests for all tools
   - Integration tests for workflows
   - Crisis scenario testing
   - Multi-user edge case testing

4. **Documentation**
   - MCP tool reference
   - Architecture documentation
   - Deployment guide
   - User manual

**Deliverables:**
- Production-ready Familiar Tome
- Full test suite
- Complete documentation

---

## Implementation Roadmap

### Summary Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Core Architecture | 4 weeks | MCP server + identity system |
| 2. Memory System | 3 weeks | Hierarchical memory + consolidation |
| 3. Knowledge Graph | 3 weeks | Auto-extracting graph + hybrid RAG |
| 4. Wellbeing Tracking | 3 weeks | Structured tracking + pattern analysis |
| 5. Intervention System | 3 weeks | Crisis detection + protocols |
| 6. Multi-User & Relay | 4 weeks | Permission system + message relay |
| 7. Sync & Multi-Embodiment | 3 weeks | Cross-device continuity |
| 8. Polish & Testing | 3 weeks | Production-ready system |
| **Total** | **26 weeks** | **Complete Familiar Tome** |

---

### Technology Stack

**Core:**
- **Runtime:** Deno (TypeScript)
- **Protocol:** MCP (Model Context Protocol)
- **Database:** SQLite + sqlite-vec extension
- **Embedding:** all-MiniLM-L6-v2 (local, 384 dims)
- **LLM:** OpenAI API / Anthropic Claude (for extraction + consolidation)

**Storage:**
- **Identity:** File-based (markdown/text)
- **Memory:** File-based + SQLite cache
- **Knowledge Graph:** SQLite (nodes, edges, vectors)
- **Wellbeing:** SQLite (structured tables)
- **Relay Queue:** SQLite

**Integration:**
- **Communication:** stdio (MCP standard)
- **Clients:** Any MCP-compatible client (Psycheros, VS Code, Claude Desktop, etc.)

---

### Success Metrics

**Technical:**
- ✅ Sub-second memory search (<500ms)
- ✅ Cross-device sync latency <5 seconds
- ✅ Crisis detection accuracy >95%
- ✅ 99.9% uptime for MCP server

**Functional:**
- ✅ Multi-user isolation verified (no data leakage)
- ✅ Permission system tested (100+ edge cases)
- ✅ Crisis protocols validated (suicide prevention expert review)
- ✅ All 80+ MCP tools documented and tested

**User Experience:**
- ✅ Consistent character voice across all interactions
- ✅ Proactive check-ins feel natural (not intrusive)
- ✅ Intervention timing appropriate (crisis vs. elevated)
- ✅ Users report feeling "cared for" (subjective but critical)

---

## Conclusion

Entity-core-alpha represents **state-of-the-art architecture** for persistent AI identity and memory. Its hierarchical memory consolidation, knowledge graph with auto-extraction, and first-person design philosophy are exemplary.

However, entity-core is fundamentally designed for a **single AI entity with a single human user**. Familiar requires **multi-user caretaking with wellbeing tracking, crisis intervention, and cross-user relay** — needs that entity-core was never intended to address.

**Recommended path:** **Architectural pattern reuse (Option 2)**
- Build Familiar Tome from scratch using entity-core's patterns as reference
- Adopt: Hierarchical memory, knowledge graph, sync protocol concepts, first-person philosophy
- Rebuild: Identity model (multi-user), wellbeing tracking, intervention system, relay architecture, permission system
- Estimated effort: 26 weeks for full implementation

Entity-core-alpha is an **invaluable reference architecture** that validates and refines patterns Familiar should adopt, while clearly demonstrating the need for custom implementation to serve caretaking goals.

---

**Research compiled:** May 8, 2026  
**Recommendation:** Proceed with Option 2 (Architectural Pattern Reuse)  
**Next steps:** Begin Phase 1 (Core Architecture) with identity system redesign
