# Caretaker Agent: Comprehensive Architecture Synthesis

**Document Version:** 1.0  
**Date:** April 29, 2026  
**Purpose:** Complete implementation guide synthesizing all research findings

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Requirements](#system-requirements)
3. [Technology Stack](#technology-stack)
4. [System Architecture](#system-architecture)
5. [Database Design](#database-design)
6. [Authentication & Authorization](#authentication--authorization)
7. [Message Relay Architecture](#message-relay-architecture)
8. [Memory & Context Management](#memory--context-management)
9. [Security & Privacy](#security--privacy)
10. [API Specification](#api-specification)
11. [Deployment Architecture](#deployment-architecture)
12. [Implementation Roadmap](#implementation-roadmap)

---

## Executive Summary

### What is the Caretaker Agent?

A **multi-user AI chat system** that maintains separate conversations with different people while enabling **cross-chat information relay**. The caretaker can:

- Maintain **independent chat contexts** for each user
- **Relay messages** between users (e.g., "Tell Person B that Person A said hello")
- **Share knowledge** selectively across users with permission controls
- Remember **long-term context** across sessions
- Operate with **enterprise-grade security** and privacy

### Key Differentiators

Unlike standard AI chat systems:
- **Cross-chat awareness**: Can reference and relay information between separate conversations
- **Permission-based sharing**: Fine-grained control over what information crosses chat boundaries
- **Multi-user by design**: Not retrofitted, but architected from the ground up for multiple users
- **Identity persistence**: Maintains consistent identity across all conversations

### Use Cases

1. **Personal Assistant**: Coordinate schedules between family members
2. **Team Coordinator**: Relay messages between team members in different time zones
3. **Social Hub**: Facilitate introductions and connections between contacts
4. **Memory Bank**: Long-term memory that persists across conversations

---

## System Requirements

### Functional Requirements

**FR-1: Multi-User Chat Management**
- Each user has independent chat sessions
- Chat history isolated by default
- Users can create multiple chats

**FR-2: Cross-Chat Message Relay**
- Agent can relay messages between users: "Tell Alice that the meeting is at 3pm"
- Explicit user intent required for relay (no automatic leakage)
- Relay history tracked for auditing

**FR-3: Selective Knowledge Sharing**
- Users can grant permission for agent to share specific information
- Agent remembers what can be shared with whom
- Permission changes take effect immediately

**FR-4: Long-Term Memory**
- Agent maintains context across sessions
- Semantic memory retrieval for relevant past conversations
- Memory persists beyond token context limits

**FR-5: Identity Consistency**
- Agent maintains same personality/identity across all users
- Customizable system prompt for agent behavior
- Agent "remembers" relationships between users

### Non-Functional Requirements

**NFR-1: Security**
- End-to-end encryption for data at rest
- Row-level security for data isolation
- Comprehensive audit logging

**NFR-2: Privacy**
- GDPR-compliant data export/deletion
- No cross-user data leakage
- Clear consent for information sharing

**NFR-3: Performance**
- Response time < 2 seconds for messages
- Support 1000+ concurrent users
- Context retrieval < 500ms

**NFR-4: Scalability**
- Horizontal scaling for API servers
- Database read replicas for performance
- Redis clustering for session management

**NFR-5: Reliability**
- 99.9% uptime SLA
- Automatic failover for critical services
- Data backup every 24 hours

---

## Technology Stack

### Backend

**Framework:** FastAPI (Python 3.11+)
- Async support for high concurrency
- Automatic API documentation (OpenAPI)
- Native Pydantic integration
- WebSocket support for real-time features

**Database:** PostgreSQL 15+ with pgvector
- ACID compliance
- Row-level security (RLS)
- JSON support for flexible schemas
- Vector similarity search (pgvector extension)

**Cache/Session Store:** Redis 7+
- Session management
- Rate limiting
- PubSub for real-time messaging
- Cache for frequent queries

**Vector Database:** Embedded in PostgreSQL via pgvector
- Simplifies deployment (no separate service)
- ACID guarantees for embeddings
- Native joins with relational data

**LLM Integration:** OpenAI API / Anthropic Claude
- Primary: GPT-4 for reasoning
- Secondary: GPT-3.5-turbo for cost efficiency
- Fallback: Claude 3 for long contexts

### Frontend

**Framework:** React 18+ with TypeScript
- Component-based architecture
- Type safety
- Rich ecosystem

**State Management:** Zustand
- Lightweight alternative to Redux
- Simple API
- Built-in TypeScript support

**UI Library:** Tailwind CSS + shadcn/ui
- Utility-first styling
- Pre-built accessible components
- Easy customization

**WebSocket:** Socket.io-client
- Real-time message delivery
- Automatic reconnection
- Fallback to long polling

### Infrastructure

**Container Platform:** Docker + Kubernetes
- Consistent environments
- Easy scaling
- Service discovery

**Reverse Proxy:** Nginx
- TLS termination
- Load balancing
- Static file serving

**Monitoring:** Prometheus + Grafana
- Metrics collection
- Alerting
- Visualization

**Logging:** ELK Stack (Elasticsearch, Logstash, Kibana)
- Centralized logging
- Full-text search
- Log visualization

**CI/CD:** GitHub Actions
- Automated testing
- Deployment pipelines
- Security scanning

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Client Layer                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │  React SPA   │  │  Mobile App  │  │   CLI Tool   │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼──────────────────┼──────────────────┼─────────────────┘
          │                  │                  │
          └──────────────────┴──────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Nginx (TLS)    │
                    └────────┬────────┘
                             │
          ┌──────────────────┴──────────────────┐
          │                                      │
┌─────────▼─────────┐                 ┌─────────▼─────────┐
│   FastAPI App     │◄───WebSocket───►│   Redis PubSub    │
│   (API Server)    │                 │   (Real-time)     │
└─────────┬─────────┘                 └───────────────────┘
          │
          ├───────────────┬───────────────┬───────────────┐
          │               │               │               │
┌─────────▼─────────┐ ┌───▼────────┐ ┌───▼────────┐ ┌────▼────────┐
│   PostgreSQL      │ │   Redis    │ │  LLM API   │ │ Embedding   │
│   (Primary DB)    │ │  (Cache)   │ │ (OpenAI)   │ │  Service    │
└───────────────────┘ └────────────┘ └────────────┘ └─────────────┘
```

### Component Architecture

**API Layer:**
- RESTful endpoints for CRUD operations
- WebSocket for real-time messaging
- GraphQL optional (future consideration)

**Business Logic Layer:**
- Chat management service
- Message relay service
- Memory management service
- User management service

**Data Access Layer:**
- Repository pattern for database access
- ORM: SQLAlchemy with async support
- Query optimization with connection pooling

**Integration Layer:**
- LLM client (OpenAI/Anthropic)
- Embedding generation
- External webhooks (optional)

---

## Database Design

### Complete Schema (PostgreSQL)

```sql
-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgvector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- For fuzzy text search

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    
    -- MFA
    mfa_enabled BOOLEAN DEFAULT FALSE,
    mfa_secret TEXT,  -- Encrypted
    backup_codes TEXT[],  -- Array of hashed backup codes
    
    -- Profile
    avatar_url TEXT,
    timezone VARCHAR(50) DEFAULT 'UTC',
    language VARCHAR(10) DEFAULT 'en',
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    is_verified BOOLEAN DEFAULT FALSE,
    
    -- Privacy
    anonymized BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(is_active) WHERE is_active = TRUE;

-- Groups (optional, for team/family features)
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Group members
CREATE TABLE group_members (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'member',  -- 'owner', 'admin', 'member'
    joined_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(group_id, user_id)
);

CREATE INDEX idx_group_members_user ON group_members(user_id);
CREATE INDEX idx_group_members_group ON group_members(group_id);

-- Chats
CREATE TABLE chats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,
    
    title VARCHAR(255),
    
    -- Configuration
    system_prompt TEXT,  -- Custom system prompt for this chat
    model VARCHAR(50) DEFAULT 'gpt-4',
    temperature FLOAT DEFAULT 0.7,
    
    -- Context management
    context_strategy VARCHAR(50) DEFAULT 'hybrid',  -- 'truncation', 'summarization', 'rag', 'hybrid'
    max_context_tokens INTEGER DEFAULT 8000,
    
    -- Status
    archived BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    last_message_at TIMESTAMP
);

CREATE INDEX idx_chats_user ON chats(user_id);
CREATE INDEX idx_chats_group ON chats(group_id);
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);

-- Messages
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    
    -- Message content
    role VARCHAR(20) NOT NULL,  -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    
    -- Metadata
    model VARCHAR(50),  -- Which model generated this (for assistant messages)
    token_count INTEGER,
    
    -- Relay tracking
    is_relay BOOLEAN DEFAULT FALSE,
    relay_from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    relay_from_chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    
    -- Pinning (for context management)
    pinned BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    edited_at TIMESTAMP
);

CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX idx_messages_relay ON messages(relay_from_user_id) WHERE is_relay = TRUE;

-- Shared knowledge (cross-chat information)
CREATE TABLE shared_knowledge (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Source
    source_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    source_chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    
    -- Content
    content TEXT NOT NULL,
    summary TEXT,  -- Brief summary for quick reference
    
    -- Visibility control
    visibility_scope VARCHAR(20) DEFAULT 'private',  -- 'private', 'specific_users', 'group', 'public'
    visibility_target_ids UUID[],  -- Array of user_ids or group_ids
    
    -- Embedding for semantic search
    embedding VECTOR(1536),  -- OpenAI ada-002 embedding size
    
    -- Metadata
    tags TEXT[],
    category VARCHAR(100),
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    anonymized BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP  -- Optional expiry
);

CREATE INDEX idx_knowledge_source_user ON shared_knowledge(source_user_id);
CREATE INDEX idx_knowledge_visibility ON shared_knowledge(visibility_scope);
CREATE INDEX idx_knowledge_embedding ON shared_knowledge USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX idx_knowledge_tags ON shared_knowledge USING GIN(tags);

-- Memory chunks (for long-term context)
CREATE TABLE memory_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    
    -- Content
    content TEXT NOT NULL,
    chunk_type VARCHAR(50),  -- 'conversation_summary', 'fact', 'preference', 'relationship'
    
    -- Embedding
    embedding VECTOR(1536),
    
    -- Importance scoring
    importance_score FLOAT DEFAULT 0.5,  -- 0-1, used for retrieval prioritization
    access_count INTEGER DEFAULT 0,  -- Track usage
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    last_accessed TIMESTAMP
);

CREATE INDEX idx_memory_chat ON memory_chunks(chat_id);
CREATE INDEX idx_memory_embedding ON memory_chunks USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX idx_memory_importance ON memory_chunks(importance_score DESC);

-- Pending relays (task queue for cross-chat messages)
CREATE TABLE pending_relays (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Source
    from_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    from_chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    from_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    
    -- Target
    to_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    to_chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,  -- NULL = next chat with user
    
    -- Content
    relay_instruction TEXT NOT NULL,  -- What user asked to relay
    relay_content TEXT NOT NULL,  -- Actual content to relay
    
    -- Status
    status VARCHAR(20) DEFAULT 'pending',  -- 'pending', 'delivered', 'failed'
    delivered_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP
);

CREATE INDEX idx_pending_relays_to_user ON pending_relays(to_user_id, status);
CREATE INDEX idx_pending_relays_status ON pending_relays(status) WHERE status = 'pending';

-- Audit logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    
    -- Who
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    anonymized BOOLEAN DEFAULT FALSE,
    
    -- What
    action VARCHAR(50) NOT NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    
    -- Details
    details JSONB,
    status VARCHAR(20) DEFAULT 'success',  -- 'success', 'failure', 'blocked'
    
    -- Where
    ip_address INET,
    user_agent TEXT,
    
    -- When
    timestamp TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_logs(user_id, timestamp DESC);
CREATE INDEX idx_audit_action ON audit_logs(action, timestamp DESC);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_timestamp ON audit_logs(timestamp DESC);

-- Refresh tokens (for JWT rotation)
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    
    -- Status
    revoked BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token) WHERE revoked = FALSE;

-- Row-Level Security Policies
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_chunks ENABLE ROW LEVEL SECURITY;

-- Users can only access their own chats
CREATE POLICY chat_owner_policy ON chats
    FOR ALL
    USING (
        user_id = current_setting('app.current_user_id')::uuid
        OR group_id IN (
            SELECT group_id FROM group_members 
            WHERE user_id = current_setting('app.current_user_id')::uuid
        )
    );

-- Users can only access messages in their chats
CREATE POLICY message_owner_policy ON messages
    FOR ALL
    USING (
        chat_id IN (
            SELECT id FROM chats 
            WHERE user_id = current_setting('app.current_user_id')::uuid
            OR group_id IN (
                SELECT group_id FROM group_members 
                WHERE user_id = current_setting('app.current_user_id')::uuid
            )
        )
    );

-- Shared knowledge visibility
CREATE POLICY knowledge_visibility_policy ON shared_knowledge
    FOR SELECT
    USING (
        visibility_scope = 'public'
        OR source_user_id = current_setting('app.current_user_id')::uuid
        OR current_setting('app.current_user_id')::uuid = ANY(visibility_target_ids)
        OR visibility_scope = 'group' AND EXISTS (
            SELECT 1 FROM group_members gm
            WHERE gm.user_id = current_setting('app.current_user_id')::uuid
            AND gm.group_id = ANY(visibility_target_ids)
        )
    );

-- Memory chunks are chat-scoped
CREATE POLICY memory_owner_policy ON memory_chunks
    FOR ALL
    USING (
        chat_id IN (
            SELECT id FROM chats 
            WHERE user_id = current_setting('app.current_user_id')::uuid
        )
    );
```

### Entity Relationship Diagram

```
┌──────────────┐
│    users     │
└──────┬───────┘
       │
       │ 1:N
       ▼
┌──────────────┐       ┌────────────────┐
│    chats     │◄──N:1─┤ groups         │
└──────┬───────┘       └────────────────┘
       │
       │ 1:N
       ▼
┌──────────────┐
│   messages   │
└──────┬───────┘
       │
       │ 1:1
       ▼
┌─────────────────────┐
│ shared_knowledge    │
└─────────────────────┘

┌──────────────┐
│memory_chunks │
└──────────────┘
       ▲
       │ N:1
┌──────┴───────┐
│    chats     │
└──────────────┘

┌────────────────┐
│pending_relays  │
└────────────────┘
       ▲
       │ links users/chats/messages
       │
```

---

## Authentication & Authorization

### Authentication Flow

**1. Registration:**

```
User -> POST /auth/register
    {email, password, name}
    ↓
Validate email uniqueness
    ↓
Hash password (Argon2)
    ↓
Create user record
    ↓
Send verification email
    ↓
Return 201 Created
```

**2. Email Verification:**

```
User clicks email link -> GET /auth/verify?token=xxx
    ↓
Verify token signature
    ↓
Mark user.is_verified = TRUE
    ↓
Redirect to login
```

**3. Login (without MFA):**

```
User -> POST /auth/login
    {email, password}
    ↓
Find user by email
    ↓
Verify password
    ↓
Check is_active && is_verified
    ↓
Generate access_token (1h)
Generate refresh_token (30d)
    ↓
Return {access_token, refresh_token}
```

**4. Login (with MFA):**

```
User -> POST /auth/login
    {email, password}
    ↓
Verify password
    ↓
Return {requires_mfa: true}
    ↓
User -> POST /auth/mfa/verify
    {email, mfa_token}
    ↓
Verify TOTP token
    ↓
Return {access_token, refresh_token}
```

**5. Token Refresh:**

```
User -> POST /auth/refresh
    {refresh_token}
    ↓
Verify refresh_token
Check not revoked
    ↓
Generate new access_token
    ↓
Return {access_token}
```

### Authorization Model

**Role-Based Access Control (RBAC) within Groups:**

- **Owner**: Full control (delete group, manage members)
- **Admin**: Manage members, modify settings
- **Member**: Participate in group chats

**Resource-Level Permissions:**

| Resource | Owner | Shared (View) | Shared (Edit) |
|----------|-------|---------------|---------------|
| Chat | Full | Read messages | Add messages |
| Message | Full | Read | - |
| Knowledge | Full | Read (if visibility allows) | - |

**Implementation:**

```python
async def check_chat_access(
    chat_id: UUID,
    user_id: UUID,
    required_permission: str = "read"
) -> bool:
    """
    Verify user has permission to access chat
    
    Returns True if:
    - User is chat owner
    - User is member of chat's group
    - Chat is explicitly shared with user
    """
    chat = await db.chats.find_one({"id": chat_id})
    
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    # Owner check
    if chat.user_id == user_id:
        return True
    
    # Group membership check
    if chat.group_id:
        is_member = await db.group_members.find_one({
            "group_id": chat.group_id,
            "user_id": user_id
        })
        if is_member:
            return True
    
    raise HTTPException(403, "Access denied")
```

---

## Message Relay Architecture

### Relay Flow

**Scenario:** User A wants to relay a message to User B

```
User A (Chat 1): "Tell Bob that the meeting is at 3pm"
    ↓
LLM detects relay intent
    ↓
Extract relay parameters:
    - to_user: "Bob"
    - content: "the meeting is at 3pm"
    - from_user: User A
    ↓
Create pending_relay record
    ↓
Return confirmation to User A
    ↓
[Async: User B opens any chat]
    ↓
Check pending_relays for User B
    ↓
Inject relay as system message:
    "Alice asked me to tell you: the meeting is at 3pm"
    ↓
Mark relay as delivered
    ↓
Create message record with is_relay=TRUE
```

### Implementation

**1. Detect Relay Intent (LLM):**

```python
async def detect_relay_intent(user_message: str, chat_context: List[dict]) -> Optional[RelayIntent]:
    """Use LLM to detect if user wants to relay a message"""
    
    system_prompt = """
    You are a message relay detector. Analyze if the user wants you to relay a message to another person.
    
    Relay indicators:
    - "Tell [person] that..."
    - "Let [person] know..."
    - "Remind [person] about..."
    - "Message [person] that..."
    
    If relay detected, extract:
    - to_person: Name of recipient
    - content: What to relay
    - urgency: low/medium/high
    
    Return JSON or null if not a relay.
    """
    
    response = await llm.generate([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message}
    ])
    
    try:
        relay_data = json.loads(response.content)
        return RelayIntent(**relay_data)
    except:
        return None
```

**2. Create Pending Relay:**

```python
async def create_pending_relay(
    from_user_id: UUID,
    from_chat_id: UUID,
    from_message_id: UUID,
    relay_intent: RelayIntent
) -> UUID:
    """Create pending relay task"""
    
    # Resolve recipient user
    to_user = await db.users.find_one({
        "name": {"$regex": relay_intent.to_person, "$options": "i"}
    })
    
    if not to_user:
        raise ValueError(f"Recipient '{relay_intent.to_person}' not found")
    
    # Check permission (optional: user must have previously interacted)
    # ...
    
    # Create relay record
    relay_id = uuid4()
    await db.pending_relays.insert_one({
        "id": relay_id,
        "from_user_id": from_user_id,
        "from_chat_id": from_chat_id,
        "from_message_id": from_message_id,
        "to_user_id": to_user.id,
        "to_chat_id": None,  # Will be determined when delivered
        "relay_instruction": relay_intent.original_message,
        "relay_content": relay_intent.content,
        "status": "pending",
        "created_at": datetime.utcnow()
    })
    
    # Notify recipient via WebSocket if online
    await notify_user_new_relay(to_user.id)
    
    return relay_id
```

**3. Deliver Relay:**

```python
async def check_and_deliver_relays(user_id: UUID, chat_id: UUID) -> List[dict]:
    """Check for pending relays when user starts chat"""
    
    # Get pending relays for this user
    relays = await db.pending_relays.find({
        "to_user_id": user_id,
        "status": "pending"
    }).sort("created_at", 1).to_list()
    
    delivered_messages = []
    
    for relay in relays:
        # Get sender info
        from_user = await db.users.find_one({"id": relay.from_user_id})
        
        # Create relay message
        relay_message = {
            "id": uuid4(),
            "chat_id": chat_id,
            "role": "assistant",
            "content": f"{from_user.name} asked me to tell you: {relay.relay_content}",
            "is_relay": True,
            "relay_from_user_id": relay.from_user_id,
            "relay_from_chat_id": relay.from_chat_id,
            "created_at": datetime.utcnow()
        }
        
        # Insert message
        await db.messages.insert_one(relay_message)
        
        # Update relay status
        await db.pending_relays.update_one(
            {"id": relay.id},
            {"$set": {
                "status": "delivered",
                "to_chat_id": chat_id,
                "delivered_message_id": relay_message["id"],
                "delivered_at": datetime.utcnow()
            }}
        )
        
        delivered_messages.append(relay_message)
    
    return delivered_messages
```

**4. API Endpoint:**

```python
@app.post("/chats/{chat_id}/messages")
async def create_message(
    chat_id: UUID,
    content: str,
    current_user: User = Depends(get_current_user)
):
    # Check access
    await check_chat_access(chat_id, current_user.id, "write")
    
    # Save user message
    user_message = await save_message(chat_id, "user", content)
    
    # Detect relay intent
    relay_intent = await detect_relay_intent(content, chat_context)
    
    if relay_intent:
        # Create pending relay
        relay_id = await create_pending_relay(
            current_user.id,
            chat_id,
            user_message.id,
            relay_intent
        )
        
        # Respond with confirmation
        assistant_message = await save_message(
            chat_id,
            "assistant",
            f"I'll relay that message to {relay_intent.to_person}."
        )
    else:
        # Normal chat response
        assistant_message = await generate_chat_response(chat_id, content)
    
    return assistant_message
```

### Relay Consent & Permissions

**Explicit Consent Required:**
- Users must opt-in to receive relays
- Users can block specific senders
- Users can disable relays entirely

**Permission Model:**

```python
class RelayPermission(BaseModel):
    user_id: UUID
    allow_relays: bool = True
    blocked_users: List[UUID] = []
    require_approval: bool = False  # Prompt before delivering

async def can_relay_to_user(from_user_id: UUID, to_user_id: UUID) -> bool:
    """Check if relay is permitted"""
    
    # Get recipient preferences
    prefs = await db.user_preferences.find_one({"user_id": to_user_id})
    
    if not prefs or not prefs.allow_relays:
        return False
    
    if from_user_id in prefs.blocked_users:
        return False
    
    return True
```

---

## Memory & Context Management

### Three-Tier Memory System

Inspired by Marinara Engine, adapted for cross-chat caretaker:

**1. Semantic Memory (Long-term Facts)**
- Stored in `shared_knowledge` table
- Vector embeddings for retrieval
- Can be shared across users with permissions
- Examples: "Alice prefers morning meetings", "Bob is allergic to peanuts"

**2. Episodic Memory (Recent Conversations)**
- Stored in `messages` table
- Sliding window of recent messages
- Chat-specific, not shared by default
- Examples: Recent chat history within token budget

**3. Identity Memory (Agent Personality)**
- Stored in `system_prompt` (global config)
- Consistent across all users
- Defines agent behavior and personality
- Example: "You are a helpful caretaker agent..."

### Hybrid Context Management Strategy

Combines truncation + summarization + RAG (Recommended approach):

```python
class HybridContextManager:
    def __init__(
        self,
        max_context_tokens: int = 8000,
        recency_budget: int = 2000,
        summary_budget: int = 1000,
        retrieval_budget: int = 3000,
        system_budget: int = 500
    ):
        self.max_context_tokens = max_context_tokens
        self.recency_budget = recency_budget
        self.summary_budget = summary_budget
        self.retrieval_budget = retrieval_budget
        self.system_budget = system_budget
    
    async def build_context(
        self,
        chat_id: UUID,
        current_message: str
    ) -> List[dict]:
        """Build optimized context for LLM"""
        
        context = []
        
        # 1. System prompt (500 tokens)
        system_prompt = await get_system_prompt(chat_id)
        context.append({
            "role": "system",
            "content": system_prompt
        })
        
        # 2. Recent messages (2000 tokens)
        recent_messages = await get_recent_messages(
            chat_id,
            max_tokens=self.recency_budget
        )
        context.extend(recent_messages)
        
        # 3. Conversation summary (1000 tokens)
        if await has_long_history(chat_id):
            summary = await get_conversation_summary(
                chat_id,
                max_tokens=self.summary_budget
            )
            context.insert(1, {  # After system, before recent
                "role": "system",
                "content": f"Conversation summary: {summary}"
            })
        
        # 4. Semantic retrieval (3000 tokens)
        relevant_memories = await retrieve_relevant_memories(
            chat_id,
            current_message,
            max_tokens=self.retrieval_budget
        )
        
        if relevant_memories:
            context.insert(1, {
                "role": "system",
                "content": f"Relevant context: {relevant_memories}"
            })
        
        # 5. Pending relays
        relays = await check_pending_relays(chat_id)
        if relays:
            context.extend(relays)
        
        return context
```

### Memory Creation & Retrieval

**Creating Memories:**

```python
async def extract_and_store_memories(
    chat_id: UUID,
    user_id: UUID,
    message: str
):
    """Extract memorable facts from user message"""
    
    # Use LLM to extract facts
    extraction_prompt = """
    Extract factual information that should be remembered long-term.
    
    Examples:
    - Preferences: "I prefer morning meetings"
    - Relationships: "My sister is Alice"
    - Important dates: "My birthday is June 15"
    
    Return JSON array of facts or empty array.
    """
    
    response = await llm.generate([
        {"role": "system", "content": extraction_prompt},
        {"role": "user", "content": message}
    ])
    
    facts = json.loads(response.content)
    
    for fact in facts:
        # Generate embedding
        embedding = await generate_embedding(fact["content"])
        
        # Store as memory chunk
        await db.memory_chunks.insert_one({
            "id": uuid4(),
            "chat_id": chat_id,
            "content": fact["content"],
            "chunk_type": fact["type"],
            "embedding": embedding,
            "importance_score": fact.get("importance", 0.5),
            "created_at": datetime.utcnow()
        })
```

**Retrieving Memories:**

```python
async def retrieve_relevant_memories(
    chat_id: UUID,
    query: str,
    max_tokens: int = 3000,
    top_k: int = 10
) -> str:
    """Semantic search for relevant memories"""
    
    # Generate query embedding
    query_embedding = await generate_embedding(query)
    
    # Vector similarity search
    results = await db.query("""
        SELECT 
            content,
            importance_score,
            1 - (embedding <=> $1) AS similarity
        FROM memory_chunks
        WHERE chat_id = $2
        ORDER BY 
            importance_score * (1 - (embedding <=> $1)) DESC
        LIMIT $3
    """, query_embedding, chat_id, top_k)
    
    # Format memories
    memory_texts = []
    token_count = 0
    
    for row in results:
        memory_text = f"- {row['content']}"
        tokens = count_tokens(memory_text)
        
        if token_count + tokens > max_tokens:
            break
        
        memory_texts.append(memory_text)
        token_count += tokens
    
    return "\n".join(memory_texts)
```

### Conversation Summarization

```python
async def summarize_conversation(
    chat_id: UUID,
    message_range: tuple[int, int]  # (start_id, end_id)
) -> str:
    """Generate recursive summary of conversation segment"""
    
    messages = await db.messages.find({
        "chat_id": chat_id,
        "id": {"$gte": message_range[0], "$lte": message_range[1]}
    }).to_list()
    
    # Format for summarization
    conversation_text = "\n".join([
        f"{m.role}: {m.content}" for m in messages
    ])
    
    # Generate summary
    summary_prompt = """
    Summarize this conversation segment, focusing on:
    - Key facts learned
    - Important decisions made
    - Action items
    - Emotional tone
    
    Be concise but preserve important details.
    """
    
    response = await llm.generate([
        {"role": "system", "content": summary_prompt},
        {"role": "user", "content": conversation_text}
    ])
    
    return response.content
```

---

## Security & Privacy

### Security Checklist

✅ **Authentication:**
- Argon2 password hashing
- MFA (TOTP) support
- JWT with short expiry (1 hour)
- Refresh token rotation

✅ **Authorization:**
- Row-level security (PostgreSQL)
- Application-level access checks
- RBAC for groups

✅ **Data Protection:**
- Encryption at rest (sensitive fields)
- TLS in transit
- Database encryption (PostgreSQL native)

✅ **Audit & Monitoring:**
- Comprehensive audit logs
- Failed auth attempts logged
- Data access tracked

✅ **Rate Limiting:**
- Token bucket algorithm
- Per-user limits (100 req/min)
- Cost-based limits ($10/day)

✅ **Content Security:**
- Prompt injection detection
- Output filtering
- XSS protection (CSP headers)

✅ **Privacy Compliance:**
- GDPR data export
- Right to erasure
- Consent for data sharing

### Security Configuration

```python
# settings.py
class SecuritySettings(BaseSettings):
    # Passwords
    PASSWORD_MIN_LENGTH: int = 12
    PASSWORD_REQUIRE_UPPERCASE: bool = True
    PASSWORD_REQUIRE_LOWERCASE: bool = True
    PASSWORD_REQUIRE_DIGITS: bool = True
    PASSWORD_REQUIRE_SPECIAL: bool = True
    
    # JWT
    JWT_SECRET_KEY: str  # Strong random key
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30
    
    # MFA
    MFA_ISSUER_NAME: str = "Caretaker Agent"
    MFA_BACKUP_CODES_COUNT: int = 10
    
    # Rate Limiting
    RATE_LIMIT_PER_MINUTE: int = 100
    RATE_LIMIT_PER_HOUR: int = 1000
    DAILY_COST_LIMIT_USD: float = 10.0
    
    # Encryption
    MASTER_ENCRYPTION_KEY: str  # Fernet key
    
    # CORS
    ALLOWED_ORIGINS: List[str] = ["https://yourdomain.com"]
    
    # Audit
    AUDIT_LOG_RETENTION_DAYS: int = 90
    
    # Content Security
    MAX_MESSAGE_LENGTH: int = 10000
    ENABLE_PROMPT_INJECTION_DETECTION: bool = True
```

---

## API Specification

### Base URL

```
Production: https://api.caretaker.example.com/v1
Development: http://localhost:8000/v1
```

### Authentication

All endpoints (except `/auth/*`) require Bearer token:

```
Authorization: Bearer <access_token>
```

### Endpoints

#### Authentication

**POST /auth/register**
```json
Request:
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "name": "John Doe"
}

Response (201):
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "is_verified": false
}
```

**POST /auth/login**
```json
Request:
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "token_type": "bearer",
  "expires_in": 3600
}

Response (200, MFA required):
{
  "requires_mfa": true,
  "email": "user@example.com"
}
```

**POST /auth/mfa/enable**
```json
Response (200):
{
  "qr_code": "data:image/png;base64,...",
  "backup_codes": ["abc123", "def456", ...]
}
```

**POST /auth/mfa/verify**
```json
Request:
{
  "email": "user@example.com",
  "mfa_token": "123456"
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "token_type": "bearer",
  "expires_in": 3600
}
```

**POST /auth/refresh**
```json
Request:
{
  "refresh_token": "eyJhbGc..."
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "token_type": "bearer",
  "expires_in": 3600
}
```

#### Chats

**GET /chats**
```json
Response (200):
{
  "chats": [
    {
      "id": "uuid",
      "title": "General Chat",
      "last_message_at": "2024-01-15T10:30:00Z",
      "message_count": 42
    }
  ],
  "total": 10,
  "page": 1
}
```

**POST /chats**
```json
Request:
{
  "title": "New Chat",
  "system_prompt": "You are helpful...",  // Optional
  "model": "gpt-4"  // Optional
}

Response (201):
{
  "id": "uuid",
  "title": "New Chat",
  "created_at": "2024-01-15T10:30:00Z"
}
```

**GET /chats/{chat_id}**
```json
Response (200):
{
  "id": "uuid",
  "title": "General Chat",
  "system_prompt": "...",
  "model": "gpt-4",
  "created_at": "2024-01-15T10:30:00Z",
  "message_count": 42
}
```

**DELETE /chats/{chat_id}**
```json
Response (204)
```

#### Messages

**GET /chats/{chat_id}/messages**
```json
Query params:
  ?limit=50&offset=0&order=desc

Response (200):
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "content": "Hello!",
      "created_at": "2024-01-15T10:30:00Z"
    },
    {
      "id": "uuid",
      "role": "assistant",
      "content": "Hi! How can I help?",
      "created_at": "2024-01-15T10:30:15Z"
    }
  ],
  "total": 42,
  "has_more": true
}
```

**POST /chats/{chat_id}/messages**
```json
Request:
{
  "content": "Tell Bob that the meeting is at 3pm"
}

Response (201):
{
  "id": "uuid",
  "role": "assistant",
  "content": "I'll relay that message to Bob.",
  "created_at": "2024-01-15T10:30:15Z"
}
```

#### Relays

**GET /relays/pending**
```json
Response (200):
{
  "relays": [
    {
      "id": "uuid",
      "from_user": {
        "id": "uuid",
        "name": "Alice"
      },
      "content": "the meeting is at 3pm",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 3
}
```

**POST /relays/{relay_id}/deliver**
```json
Request:
{
  "chat_id": "uuid"  // Which chat to deliver to
}

Response (200):
{
  "message": {
    "id": "uuid",
    "role": "assistant",
    "content": "Alice asked me to tell you: the meeting is at 3pm",
    "is_relay": true,
    "created_at": "2024-01-15T10:35:00Z"
  }
}
```

#### Shared Knowledge

**GET /knowledge**
```json
Query params:
  ?q=search_query&scope=all&limit=20

Response (200):
{
  "items": [
    {
      "id": "uuid",
      "content": "Alice prefers morning meetings",
      "summary": "Alice's meeting preference",
      "source_user": "Alice",
      "visibility_scope": "public",
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 5
}
```

**POST /knowledge**
```json
Request:
{
  "content": "Bob is allergic to peanuts",
  "summary": "Bob's allergy",
  "visibility_scope": "specific_users",
  "visibility_target_ids": ["alice-uuid", "carol-uuid"],
  "tags": ["health", "dietary"]
}

Response (201):
{
  "id": "uuid",
  "content": "Bob is allergic to peanuts",
  "created_at": "2024-01-15T10:30:00Z"
}
```

**DELETE /knowledge/{knowledge_id}**
```json
Response (204)
```

#### User Management

**GET /users/me**
```json
Response (200):
{
  "id": "uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "mfa_enabled": true,
  "created_at": "2024-01-01T00:00:00Z"
}
```

**PATCH /users/me**
```json
Request:
{
  "name": "John Smith",
  "timezone": "America/New_York"
}

Response (200):
{
  "id": "uuid",
  "name": "John Smith",
  "timezone": "America/New_York"
}
```

**GET /users/me/export**
```json
Response (200):
{
  "user": {...},
  "chats": [...],
  "messages": [...],
  "shared_knowledge": [...],
  "audit_logs": [...]
}
```

**DELETE /users/me**
```json
Request:
{
  "confirm": "DELETE MY ACCOUNT"
}

Response (204)
```

### WebSocket API

**Connection:**
```
wss://api.caretaker.example.com/v1/ws?token=<access_token>
```

**Events (Server -> Client):**

```json
// New message
{
  "type": "message",
  "data": {
    "chat_id": "uuid",
    "message": {
      "id": "uuid",
      "role": "assistant",
      "content": "Hello!",
      "created_at": "2024-01-15T10:30:00Z"
    }
  }
}

// Relay notification
{
  "type": "relay_pending",
  "data": {
    "relay_id": "uuid",
    "from_user": "Alice",
    "preview": "Alice asked me to tell you..."
  }
}

// Typing indicator
{
  "type": "typing",
  "data": {
    "chat_id": "uuid",
    "is_typing": true
  }
}
```

**Events (Client -> Server):**

```json
// Send typing indicator
{
  "type": "typing",
  "chat_id": "uuid"
}

// Mark message as read
{
  "type": "read",
  "message_id": "uuid"
}
```

---

## Deployment Architecture

### Container Architecture

```yaml
# docker-compose.yml
version: '3.8'

services:
  # API Server
  api:
    image: caretaker-api:latest
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgresql://user:pass@postgres:5432/caretaker
      - REDIS_URL=redis://redis:6379
    depends_on:
      - postgres
      - redis
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '2'
          memory: 4G
  
  # PostgreSQL
  postgres:
    image: pgvector/pgvector:pg15
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=caretaker
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
    deploy:
      resources:
        limits:
          cpus: '4'
          memory: 8G
  
  # Redis
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
  
  # Nginx
  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on:
      - api

volumes:
  postgres_data:
  redis_data:
```

### Kubernetes Deployment

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: caretaker-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: caretaker-api
  template:
    metadata:
      labels:
        app: caretaker-api
    spec:
      containers:
      - name: api
        image: caretaker-api:latest
        ports:
        - containerPort: 8000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: caretaker-secrets
              key: database-url
        resources:
          requests:
            cpu: "1"
            memory: "2Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
        livenessProbe:
          httpGet:
            path: /health
            port: 8000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 8000
          initialDelaySeconds: 10
          periodSeconds: 5
```

### Infrastructure Diagram

```
                      ┌─────────────┐
                      │   Route53   │
                      │    (DNS)    │
                      └──────┬──────┘
                             │
                      ┌──────▼──────┐
                      │     ALB     │
                      │  (SSL Term) │
                      └──────┬──────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
       ┌──────▼─────┐               ┌──────▼─────┐
       │  ECS/EKS   │               │  ECS/EKS   │
       │  (API x3)  │               │  (API x3)  │
       │  AZ-1      │               │  AZ-2      │
       └──────┬─────┘               └──────┬─────┘
              │                             │
              └──────────────┬──────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
       ┌──────▼─────┐               ┌──────▼─────┐
       │    RDS     │◄─Replication─►│    RDS     │
       │ PostgreSQL │               │ (Replica)  │
       │  Primary   │               │            │
       └────────────┘               └────────────┘
              │
       ┌──────▼─────┐
       │ ElastiCache│
       │   Redis    │
       │  Cluster   │
       └────────────┘
```

### Monitoring Stack

```yaml
# Prometheus configuration
scrape_configs:
  - job_name: 'caretaker-api'
    static_configs:
      - targets: ['api:8000']
    metrics_path: '/metrics'

# Key metrics to monitor
- http_requests_total
- http_request_duration_seconds
- database_query_duration_seconds
- llm_api_call_duration_seconds
- llm_api_tokens_used_total
- active_websocket_connections
- pending_relays_count
- memory_chunks_count
```

---

## Implementation Roadmap

### Phase 1: MVP (4-6 weeks)

**Week 1-2: Foundation**
- ✅ Set up development environment
- ✅ Initialize FastAPI project structure
- ✅ Set up PostgreSQL with pgvector
- ✅ Implement basic authentication (email/password)
- ✅ Create database schema (users, chats, messages)

**Week 3-4: Core Chat Features**
- ✅ Implement chat CRUD operations
- ✅ Integrate LLM API (OpenAI)
- ✅ Basic context management (recent messages)
- ✅ WebSocket for real-time messaging
- ✅ Simple frontend (React)

**Week 5-6: Message Relay**
- ✅ Implement relay intent detection
- ✅ Create pending_relays table
- ✅ Build relay delivery mechanism
- ✅ Add relay UI components
- ✅ Testing & bug fixes

**MVP Deliverables:**
- Working multi-user chat system
- Basic message relay between users
- Simple frontend interface
- Deployed to staging environment

### Phase 2: Enhanced Features (4-6 weeks)

**Week 7-8: Memory System**
- ✅ Implement memory_chunks table
- ✅ Semantic memory extraction
- ✅ Vector similarity search
- ✅ Conversation summarization
- ✅ Hybrid context management

**Week 9-10: Knowledge Sharing**
- ✅ Implement shared_knowledge table
- ✅ Permission-based visibility
- ✅ Knowledge search API
- ✅ UI for managing shared knowledge

**Week 11-12: Security Hardening**
- ✅ Implement MFA (TOTP)
- ✅ Add rate limiting
- ✅ Implement audit logging
- ✅ Add prompt injection detection
- ✅ Security audit & penetration testing

**Phase 2 Deliverables:**
- Long-term memory system
- Knowledge sharing features
- Production-grade security
- Comprehensive documentation

### Phase 3: Scale & Polish (4-6 weeks)

**Week 13-14: Performance Optimization**
- ✅ Database query optimization
- ✅ Implement caching layer
- ✅ Add database read replicas
- ✅ Optimize embedding generation
- ✅ Load testing

**Week 15-16: Advanced Features**
- ✅ Group chats
- ✅ Advanced relay options (scheduled, conditional)
- ✅ Rich media support (images, files)
- ✅ Voice input/output
- ✅ Mobile app (React Native)

**Week 17-18: Production Readiness**
- ✅ Set up monitoring & alerting
- ✅ Implement backup & disaster recovery
- ✅ GDPR compliance features
- ✅ Documentation (user & API)
- ✅ Beta testing program

**Phase 3 Deliverables:**
- Production-ready system
- Mobile applications
- Complete documentation
- Launch to public beta

### Phase 4: Growth (Ongoing)

**Features:**
- AI agent marketplace (custom personalities)
- Integration APIs (Calendar, Email, Slack)
- Advanced analytics & insights
- Multi-language support
- Enterprise features (SSO, SCIM)

---

## Appendix: Research References

This architecture synthesis is based on the following research documents:

1. **[SillyTavern API Architecture](./sillytavern-api-architecture.md)**
   - Node.js/Express patterns
   - Character card format
   - Frontend-backend separation

2. **[Marinara Memory System](./marinara-memory-system.md)**
   - 3-tier memory architecture (semantic, agent, identity)
   - SQLite database design
   - Memory extraction patterns

3. **[Marinara Lorebook Trigger Architecture](./marinara-lorebook-trigger-architecture.md)**
   - Keyword vs semantic triggering
   - Embedding-based retrieval
   - Context injection strategies

4. **[AI Frontend Comparison Matrix](./ai-frontend-comparison-matrix.md)**
   - Comparison of 5 major AI frontends
   - Multi-user support analysis
   - Technology stack recommendations

5. **[Multi-User Chat Architecture Patterns](./multi-user-chat-architecture-patterns.md)**
   - Authentication flows (JWT, OAuth, LDAP)
   - Database schema design
   - Message routing patterns
   - WebSocket real-time communication

6. **[Context Window Management Strategies](./context-window-management-strategies.md)**
   - 8 strategies for context management
   - Hybrid approach (truncation + summarization + RAG)
   - Token counting & budgeting
   - Code examples for implementation

7. **[Privacy, Security & Compliance Patterns](./privacy-security-compliance-patterns.md)**
   - Threat model analysis
   - Authentication security (MFA, password policies)
   - Row-level security (PostgreSQL RLS)
   - Encryption at rest & in transit
   - Audit logging
   - Rate limiting
   - GDPR compliance

---

**End of Comprehensive Architecture Synthesis**

## Quick Start Command

```bash
# Clone template (future)
git clone https://github.com/yourusername/caretaker-agent-template.git

# Install dependencies
cd caretaker-agent-template
pip install -r requirements.txt

# Set up database
docker-compose up -d postgres redis
python scripts/init_db.py

# Start development server
uvicorn app.main:app --reload

# Open browser
open http://localhost:8000/docs
```

---

## Support & Contributing

- **Documentation:** https://docs.caretaker-agent.com
- **GitHub:** https://github.com/yourusername/caretaker-agent
- **Discord:** https://discord.gg/caretaker-agent
- **Email:** support@caretaker-agent.com
