# AI Frontend Architecture Comparison Matrix

**Research Date:** April 29, 2026  
**Purpose:** Comprehensive comparison of major AI chat frontends for informing caretaker agent design

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Comparison Matrix](#architecture-comparison-matrix)
3. [Multi-User Support Analysis](#multi-user-support-analysis)
4. [Memory System Patterns](#memory-system-patterns)
5. [API Compatibility](#api-compatibility)
6. [Key Insights for Caretaker Agent](#key-insights-for-caretaker-agent)

---

## Overview

This document compares five major AI frontend systems to extract architectural patterns and best practices for building a multi-user caretaker agent.

**Systems Analyzed:**
1. **SillyTavern** - Feature-rich character chat with extensive customization
2. **Marinara Engine** - Local roleplay/game engine with mode-switching
3. **KoboldAI** - Original local LLM interface with multiple modes
4. **Open WebUI** - Modern self-hosted AI interface with enterprise features
5. **Text Generation WebUI (Oobabooga)** - Comprehensive local LLM frontend

---

## Architecture Comparison Matrix

| Feature | SillyTavern | Marinara | KoboldAI | Open WebUI | TextGen WebUI |
|---------|-------------|----------|----------|------------|---------------|
| **Architecture Style** | Client-Server | Monolithic | Monolithic | Multi-Tier | Monolithic |
| **Backend Language** | Node.js | TypeScript/Node | Python/Flask | Python/FastAPI | Python/Gradio |
| **Frontend Framework** | Vanilla JS/HTML | React/TypeScript | Bootstrap/jQuery | Svelte | Gradio UI |
| **Database** | JSON Files | SQLite (Drizzle ORM) | JSON Files | SQLite/PostgreSQL | JSON Files |
| **Multi-User Support** | Single User | Single User | Single User | **Full Multi-User** | Single User |
| **Authentication** | None | None | Optional | **LDAP/OAuth/SCIM** | None |
| **Session Management** | Local Storage | Per-Chat State | Local Storage | **Redis/DB** | Local Storage |
| **API Style** | REST + SSE | REST + SSE | REST + SSE | REST + WebSocket | REST + SSE |
| **Memory Architecture** | World Info | 3-Tier (Semantic/Agent/Identity) | Soft Prompts | RAG + Vector DB | Context + Author Note |
| **Cross-Chat Memory** | Via World Info Books | **Character Identity Only** | Via Userscripts | **Per-User Knowledge** | Via Extensions |
| **Vector Database** | None (keyword-based) | ChromaDB | None | **9 Options** (Chroma/PGVector/Qdrant/etc.) | ChromaDB |
| **Context Window Mgmt** | Chat Completion API | Custom Hook System | Manual | Smart Summarization | Truncation |
| **Message Format** | OpenAI-compatible | Custom with Hooks | Custom | OpenAI-compatible | Custom |
| **LLM Backend Support** | 25+ APIs | Local/Remote | Local Models | Ollama/OpenAI APIs | Local Models |
| **Streaming Support** | ✅ SSE | ✅ SSE | ✅ SSE | ✅ WebSocket/SSE | ✅ SSE |
| **File Attachments** | ✅ Images | ✅ Multiple | ❌ | ✅ **Multi-format** | ✅ Images |
| **Tool Calling** | ❌ | ✅ **Agent System** | ❌ | ✅ **MCP + Functions** | ✅ **MCP Servers** |
| **Extension System** | ✅ Extensive | ❌ (Built-in Agents) | ✅ Lua Scripts | ✅ **Pipelines Plugin** | ✅ Extensions |
| **Training/Finetuning** | ❌ | ❌ | ✅ TPU Training | ❌ | ✅ **LoRA Training** |
| **Image Generation** | ✅ Multiple | ✅ FLUX | ✅ Multiple | ✅ Integrated | ✅ Diffusers Tab |
| **Deployment Complexity** | Low (npm start) | Low (Docker) | Low (Python) | **Medium** (Docker/K8s) | Medium (Conda) |
| **Horizontal Scaling** | ❌ Single Instance | ❌ Single Instance | ❌ Single Instance | ✅ **Multi-Worker** | ❌ Single Instance |
| **Observability** | Basic Logs | Basic Logs | Basic Logs | ✅ **OpenTelemetry** | Basic Logs |
| **Cloud Storage** | ❌ | ❌ | ❌ | ✅ **S3/GCS/Azure** | ❌ |
| **Privacy Model** | Local Only | Local Only | Local Only | **Self-Hosted** | Local Only |
| **License** | AGPL-3.0 | MIT | AGPL-3.0 | Custom Open Source | AGPL-3.0 |

---

## Multi-User Support Analysis

### Open WebUI: Production-Ready Multi-User

**Architecture:**
```python
# User Management
class User:
    id: str
    email: str
    name: str
    role: str  # "admin", "user", "pending"
    profile_image_url: str
    created_at: int

# Session Management (Redis-backed)
class SessionManager:
    store: Redis
    def create_session(user_id: str) -> str
    def validate_session(token: str) -> User
    def invalidate_session(token: str)

# Permission System
class RolePermissions:
    admin: ["manage_users", "manage_models", "all_chats"]
    user: ["own_chats", "use_models"]
    
# Chat Scoping
class Chat:
    id: str
    user_id: str  # Owner
    shared_with: List[str]  # Other user IDs
    messages: List[Message]
```

**Key Features:**
- **RBAC** (Role-Based Access Control) with granular permissions
- **User Groups** for team-based access control
- **LDAP/Active Directory** integration for enterprise
- **SCIM 2.0** automated user provisioning
- **OAuth Providers** (Google, Microsoft, GitHub, OIDC)
- **SSO via Trusted Headers** for reverse proxy setups
- **Redis Session Store** for horizontal scaling
- **WebSocket per user** for real-time updates

**Database Schema (PostgreSQL):**
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR UNIQUE,
    name VARCHAR,
    role VARCHAR,
    password_hash VARCHAR,
    created_at TIMESTAMP
);

CREATE TABLE chats (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    title VARCHAR,
    created_at TIMESTAMP
);

CREATE TABLE chat_permissions (
    chat_id UUID REFERENCES chats(id),
    user_id UUID REFERENCES users(id),
    permission_level VARCHAR,  -- 'read', 'write', 'admin'
    PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE sessions (
    session_token VARCHAR PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    expires_at TIMESTAMP
);
```

**Lesson for Caretaker Agent:** Open WebUI demonstrates production-ready multi-user patterns with proper authentication, authorization, and session management.

---

### Other Systems: Single-User Focus

**SillyTavern, Marinara, KoboldAI, TextGen WebUI:**
- All designed for **single user** running locally
- No user accounts or authentication
- State stored in local files/browser storage
- Not designed for concurrent users

**Why This Matters:**
- Caretaker agent **requires multi-user** support
- Must implement authentication/authorization from scratch
- Can't rely on patterns from these systems for user management

---

## Memory System Patterns

### Pattern 1: Keyword-Triggered Injection (SillyTavern World Info)

**Architecture:**
```javascript
// Entry Structure
class WorldInfoEntry {
    key: string[];              // Primary keywords
    secondaryKeys: string[];    // For selective logic
    content: string;            // Injected content
    constant: boolean;          // Always inject
    selective: boolean;         // Requires secondary keys
    position: number;           // Where to inject (0-4)
    depth: number;              // How many messages to scan
}

// Scanning Algorithm
function scanForActivatedEntries(messages, entries) {
    const activated = [];
    const combinedText = messages.slice(-depth).join("\n");
    
    for (const entry of entries) {
        if (entry.constant) {
            activated.push(entry);
            continue;
        }
        
        // Check primary keys
        const primaryMatch = entry.key.some(k => 
            combinedText.includes(k)
        );
        
        if (!primaryMatch) continue;
        
        // Check selective logic
        if (entry.selective) {
            const secondaryMatch = checkSelectiveLogic(
                entry.secondaryKeys,
                entry.selectiveLogic,
                combinedText
            );
            if (!secondaryMatch) continue;
        }
        
        activated.push(entry);
    }
    
    return activated.sort((a, b) => a.order - b.order);
}

// Injection
function injectEntries(prompt, activatedEntries) {
    const byPosition = groupBy(activatedEntries, 'position');
    
    // Position 0: Before character definition
    // Position 1: After character definition
    // Position 2: At depth in chat history
    // etc.
}
```

**Strengths:**
- Simple, deterministic, no ML required
- Fast keyword matching
- Flexible injection positions

**Weaknesses:**
- No semantic understanding
- Must maintain keyword lists manually
- Keyword collisions

---

### Pattern 2: Semantic + Agent Memory (Marinara Engine)

**Architecture:**
```typescript
// Tier 1: Per-Chat Semantic Memory
interface MemoryChunk {
    id: string;
    chatId: string;
    content: string;              // 5 messages combined
    embedding: number[];          // 384-dim vector
    messageCount: number;         // Always 5
    firstMessageAt: string;
    lastMessageAt: string;
}

// Tier 2: Agent Persistent Memory (Key-Value Store)
interface AgentMemory {
    agentConfigId: string;
    chatId: string;
    key: string;                  // "plot_arc", "quest_status"
    value: string;                // JSON-serializable
}

// Tier 3: Character Identity (Shared Across Chats)
interface Character {
    id: string;
    name: string;
    description: string;
    personality: string;
    // Character data accessible in ALL chats
}

// Memory Recall
function recallMemories(chatId: string, query: string, limit: number) {
    // 1. Embed query
    const queryEmbedding = embedText(query);
    
    // 2. Semantic search in chunks
    const chunks = await db.memoryChunks
        .where('chatId', chatId)
        .orderBy(cosineSimilarity(queryEmbedding, 'embedding'))
        .limit(limit);
    
    // 3. Agent memories for context
    const agentMemories = await db.agentMemory
        .where('chatId', chatId)
        .all();
    
    return { chunks, agentMemories };
}
```

**Strengths:**
- **Semantic search** for contextual recall
- **Agent memory** for stateful information
- **Character identity** shared across modes
- Efficient chunking (5 messages per embedding)

**Weaknesses:**
- **No cross-chat memory** by design
- Character identity only shared data
- Can't pass messages between users

---

### Pattern 3: Full RAG with Vector DB (Open WebUI)

**Architecture:**
```python
# Document Storage
class Document:
    id: str
    user_id: str               # Owner
    collection_name: str       # Grouping
    filename: str
    content: str
    metadata: dict

# Vector Database Interface (9 options)
class VectorDB:
    def insert(doc_id: str, embedding: List[float], metadata: dict)
    def search(query_embedding: List[float], top_k: int, filter: dict)
    def delete(doc_id: str)

# RAG Pipeline
class RAGPipeline:
    vector_db: VectorDB
    embedding_model: str
    
    def add_document(self, doc: Document):
        # 1. Chunk document
        chunks = self.chunk_text(doc.content)
        
        # 2. Embed chunks
        for chunk in chunks:
            embedding = self.embed(chunk.text)
            self.vector_db.insert(
                doc_id=f"{doc.id}_{chunk.index}",
                embedding=embedding,
                metadata={
                    "user_id": doc.user_id,
                    "doc_id": doc.id,
                    "chunk_index": chunk.index,
                    "text": chunk.text
                }
            )
    
    def retrieve(self, query: str, user_id: str, top_k: int):
        # 1. Embed query
        query_embedding = self.embed(query)
        
        # 2. Search with user filter
        results = self.vector_db.search(
            query_embedding=query_embedding,
            top_k=top_k,
            filter={"user_id": user_id}
        )
        
        return results

# Integration with Chat
def generate_with_rag(messages: List[Message], user_id: str):
    # 1. Get last user message
    last_message = messages[-1].content
    
    # 2. Retrieve relevant documents
    retrieved_docs = rag_pipeline.retrieve(
        query=last_message,
        user_id=user_id,
        top_k=3
    )
    
    # 3. Inject into system prompt
    context = "\n".join([doc.text for doc in retrieved_docs])
    system_message = f"Context:\n{context}\n\nInstructions: ..."
    
    # 4. Generate
    return llm.generate([system_message] + messages)
```

**Vector Database Options:**
1. **ChromaDB** - Default, embedded
2. **PGVector** - PostgreSQL extension
3. **Qdrant** - High-performance vector search
4. **Milvus** - Scalable vector database
5. **Elasticsearch** - Full-text + vector
6. **OpenSearch** - Fork of Elasticsearch
7. **Pinecone** - Cloud vector database
8. **S3Vector** - S3-backed storage
9. **Oracle 23ai** - Enterprise database

**Strengths:**
- **Per-user document isolation**
- **Semantic search** across all documents
- **Scalable** to millions of documents
- **Multiple content extractors** (Tika, Docling, OCR)

**Weaknesses:**
- More complex than keyword matching
- Requires vector database infrastructure
- Embedding model dependency

---

### Pattern 4: Tool-Calling for Dynamic Memory (TextGen WebUI + Open WebUI)

**Architecture:**
```python
# Tool Definition
class Tool:
    name: str
    description: str
    parameters: dict
    function: callable
    
# Example: Memory Storage Tool
memory_storage_tool = Tool(
    name="store_memory",
    description="Store information for later retrieval",
    parameters={
        "type": "object",
        "properties": {
            "category": {"type": "string", "enum": ["user_info", "task", "relationship"]},
            "content": {"type": "string"},
            "visibility": {"type": "string", "enum": ["private", "shared"]}
        }
    },
    function=lambda category, content, visibility: 
        memory_db.insert(category=category, content=content, visibility=visibility)
)

# Tool Execution
def execute_tool_call(tool_call: dict, available_tools: List[Tool]):
    tool_name = tool_call["function"]["name"]
    tool_args = json.loads(tool_call["function"]["arguments"])
    
    tool = next(t for t in available_tools if t.name == tool_name)
    result = tool.function(**tool_args)
    
    return {
        "tool_call_id": tool_call["id"],
        "output": json.dumps(result)
    }

# Integration with LLM
def generate_with_tools(messages: List[Message], tools: List[Tool]):
    response = llm.generate(
        messages=messages,
        tools=[t.to_openai_format() for t in tools]
    )
    
    if response.tool_calls:
        # Execute tool calls
        tool_results = [
            execute_tool_call(tc, tools) 
            for tc in response.tool_calls
        ]
        
        # Add tool results to conversation
        messages.append(response.message)
        messages.extend([
            {"role": "tool", "content": tr["output"], "tool_call_id": tr["tool_call_id"]}
            for tr in tool_results
        ])
        
        # Generate final response
        return llm.generate(messages=messages)
    
    return response
```

**MCP (Model Context Protocol) Support:**
```python
# MCP Server Configuration
mcp_config = {
    "servers": {
        "memory": {
            "command": "node",
            "args": ["memory-server.js"],
            "tools": ["store_memory", "recall_memory", "search_memories"]
        },
        "web_search": {
            "command": "node",
            "args": ["search-server.js"],
            "tools": ["search_web", "fetch_page"]
        }
    }
}

# MCP Tool Discovery
async def load_mcp_tools():
    tools = []
    for server_name, config in mcp_config["servers"].items():
        server = MCPServer(config["command"], config["args"])
        await server.connect()
        server_tools = await server.list_tools()
        tools.extend(server_tools)
    return tools
```

**Strengths:**
- **Dynamic memory management** by LLM
- **Extensible** via MCP servers
- LLM decides **when** to store/recall
- **Standardized protocol** (MCP)

**Weaknesses:**
- Requires function-calling capable models
- LLM may forget to use tools
- Tool execution adds latency

---

## API Compatibility

### OpenAI-Compatible Endpoints

All systems except Marinara provide OpenAI-compatible APIs:

```python
# Chat Completions Endpoint
POST /v1/chat/completions
{
    "model": "gpt-4",
    "messages": [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello!"}
    ],
    "temperature": 0.7,
    "stream": true,
    "tools": [...]  # Optional function calling
}

# Response (Streaming)
data: {"id": "...", "choices": [{"delta": {"content": "Hello"}}]}
data: {"id": "...", "choices": [{"delta": {"content": "!"}}]}
data: [DONE]
```

### Backend Abstraction Patterns

**SillyTavern Approach:**
```javascript
// Provider-specific adapters
class OpenAIProvider {
    async generate(messages, settings) { ... }
}

class ClaudeProvider {
    async generate(messages, settings) {
        // Transform to Claude format
        const claudeMessages = this.transformMessages(messages);
        // Call Claude API
    }
}

// Unified interface
class LLMProviderManager {
    providers: Map<string, Provider>;
    
    async generate(provider: string, messages, settings) {
        const p = this.providers.get(provider);
        return await p.generate(messages, settings);
    }
}
```

**Open WebUI Approach:**
```python
# Pipeline system for middleware
class Pipeline:
    def process_request(self, messages: List[dict]) -> List[dict]:
        # Pre-processing
        return messages
    
    def process_response(self, response: str) -> str:
        # Post-processing
        return response

# Example: Translation Pipeline
class TranslationPipeline(Pipeline):
    def process_request(self, messages):
        # Translate to English
        return [translate(msg) for msg in messages]
    
    def process_response(self, response):
        # Translate back to user language
        return translate(response)
```

---

## Key Insights for Caretaker Agent

### 1. Multi-User Architecture (from Open WebUI)

**Must-Have Features:**
- User authentication (email/password + OAuth)
- Role-based access control
- Per-user chat isolation
- Session management (Redis-backed for scaling)
- PostgreSQL for multi-user data

**Implementation Priority:** **CRITICAL**

### 2. Memory Architecture (Hybrid Approach)

**Recommended: 3-Tier System**

```python
# Tier 1: Per-Chat Conversational Memory
class ChatMemory:
    chat_id: str
    user_id: str
    messages: List[Message]
    embeddings: List[Embedding]  # For semantic search

# Tier 2: Cross-Chat Shared Knowledge
class SharedKnowledge:
    id: str
    category: str  # "user_info", "relationship", "task"
    content: str
    embedding: List[float]
    visibility: List[str]  # Which chat IDs can see this
    source_chat_id: str
    created_by_user_id: str

# Tier 3: Agent Identity (The Caretaker)
class AgentIdentity:
    name: str
    personality: str
    instructions: str
    # Consistent across all chats
```

**Implementation Priority:** **CRITICAL**

### 3. Message Routing System (New Pattern)

**For Caretaker Agent Specific Need:**

```python
class MessageRelay:
    def create_relay_task(self, from_user: str, to_user: str, message: str):
        # Store task in shared knowledge
        task = SharedKnowledge(
            category="task",
            content=f"Relay from {from_user}: {message}",
            visibility=[f"chat_{to_user}"],
            source_chat_id=f"chat_{from_user}"
        )
        db.insert(task)
    
    def check_pending_relays(self, user_id: str) -> List[dict]:
        # Check for messages to relay
        return db.shared_knowledge.filter(
            category="task",
            visibility=f"chat_{user_id}",
            status="pending"
        )
    
    def deliver_relay(self, chat_id: str, relay: SharedKnowledge):
        # Inject as system message
        system_message = {
            "role": "system",
            "content": f"[RELAY] {relay.content}"
        }
        # Add to chat
        db.chats.get(chat_id).messages.append(system_message)
```

**Implementation Priority:** **HIGH**

### 4. Context Window Management

**Best Practice from Multiple Systems:**

```python
class ContextManager:
    max_tokens: int = 8000
    
    def prepare_context(self, chat: Chat) -> List[Message]:
        # 1. Always include system prompt
        messages = [chat.system_message]
        
        # 2. Include recent messages (last N)
        recent = chat.messages[-20:]
        
        # 3. Semantic search for relevant history
        if len(chat.messages) > 20:
            query = recent[-1].content
            relevant = self.semantic_search(
                chat_id=chat.id,
                query=query,
                exclude_recent=20,
                limit=5
            )
            messages.extend(relevant)
        
        # 4. Add recent messages
        messages.extend(recent)
        
        # 5. Truncate if needed
        return self.truncate_to_fit(messages, self.max_tokens)
```

**Implementation Priority:** **MEDIUM**

### 5. Privacy & Security

**Lessons from Open WebUI:**

```python
# Row-level security
def get_user_chats(user_id: str):
    return db.chats.filter(
        lambda c: c.user_id == user_id or user_id in c.shared_with
    )

# Audit logging
class AuditLog:
    user_id: str
    action: str  # "read", "write", "share"
    resource_type: str  # "chat", "knowledge"
    resource_id: str
    timestamp: datetime
```

**Implementation Priority:** **HIGH**

### 6. Tool Integration

**MCP for Extensibility:**

```python
# Built-in tools for caretaker agent
tools = [
    Tool(name="store_user_preference", ...),
    Tool(name="relay_message", ...),
    Tool(name="search_memories", ...),
    Tool(name="check_pending_tasks", ...)
]

# Load MCP servers for additional capabilities
mcp_tools = await load_mcp_tools()
all_tools = tools + mcp_tools
```

**Implementation Priority:** **MEDIUM**

---

## Recommended Tech Stack for Caretaker Agent

Based on analysis of all systems:

### Backend
- **Language:** Python (best ecosystem for AI/ML)
- **Framework:** FastAPI (async, OpenAPI, WebSocket support)
- **Database:** PostgreSQL (multi-user, JSONB, pgvector)
- **Vector DB:** Qdrant or PGVector (semantic search)
- **Session Store:** Redis (horizontal scaling)
- **ORM:** SQLAlchemy or Drizzle-style builder

### Frontend
- **Framework:** React or Svelte (modern, component-based)
- **State Management:** Redux or Zustand
- **WebSocket:** Socket.io or native WebSocket
- **UI Library:** shadcn/ui or Mantine

### Infrastructure
- **Container:** Docker + Docker Compose
- **Orchestration:** Kubernetes (optional, for scale)
- **Observability:** OpenTelemetry (traces/metrics/logs)
- **Storage:** S3-compatible (documents/files)

### AI/ML
- **LLM Backend:** OpenAI API compatible (Ollama, LiteLLM)
- **Embeddings:** Local (all-MiniLM-L6-v2) or OpenAI
- **Tool Calling:** MCP servers + custom functions

---

## Next Steps

1. **Design detailed database schema** for multi-user + shared knowledge
2. **Implement authentication system** (JWT + OAuth)
3. **Build message routing logic** for cross-chat relays
4. **Set up vector database** for semantic memory
5. **Create tool definitions** for caretaker-specific actions
6. **Implement context management** with token budgets
7. **Add audit logging** for privacy compliance

---

**End of Document**
