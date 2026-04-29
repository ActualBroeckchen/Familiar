# Multi-User Chat Architecture Patterns for AI Agents

**Research Date:** April 29, 2026  
**Purpose:** Design patterns for building multi-user AI chat systems with cross-user communication

---

## Table of Contents

1. [Overview](#overview)
2. [User Management & Authentication](#user-management--authentication)
3. [Chat Isolation vs Sharing](#chat-isolation-vs-sharing)
4. [Session Management](#session-management)
5. [Database Schema Design](#database-schema-design)
6. [Message Routing Architectures](#message-routing-architectures)
7. [WebSocket & Real-Time Communication](#websocket--real-time-communication)
8. [Horizontal Scaling Patterns](#horizontal-scaling-patterns)

---

## Overview

Building a multi-user AI chat system requires careful architectural decisions around:
- **User identity** and authentication
- **Data isolation** between users
- **Session management** across devices
- **Real-time communication** for responsive UX
- **Horizontal scaling** for growth

This document extracts patterns from production systems and proposes an architecture for a multi-user caretaker agent.

---

## User Management & Authentication

### Pattern 1: Email/Password with JWT

**Used by:** Open WebUI, most modern web apps

```python
# User Model
class User(BaseModel):
    id: UUID
    email: EmailStr
    name: str
    password_hash: str
    role: str  # "admin", "user"
    created_at: datetime
    last_login: datetime
    is_active: bool

# Registration
async def register_user(email: str, name: str, password: str):
    # 1. Validate email not taken
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already registered")
    
    # 2. Hash password (bcrypt or argon2)
    password_hash = hash_password(password)
    
    # 3. Create user
    user = User(
        id=uuid4(),
        email=email,
        name=name,
        password_hash=password_hash,
        role="user",
        created_at=datetime.now(),
        is_active=True
    )
    
    await db.users.insert_one(user.dict())
    
    # 4. Generate JWT token
    token = create_access_token(user.id, expires_delta=timedelta(days=7))
    
    return {"user": user, "token": token}

# Login
async def login(email: str, password: str):
    user = await db.users.find_one({"email": email})
    
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")
    
    if not user.is_active:
        raise HTTPException(403, "Account deactivated")
    
    # Update last login
    await db.users.update_one(
        {"id": user.id},
        {"$set": {"last_login": datetime.now()}}
    )
    
    token = create_access_token(user.id)
    return {"user": user, "token": token}

# JWT Token Creation
def create_access_token(user_id: UUID, expires_delta: timedelta = None):
    to_encode = {
        "sub": str(user_id),
        "exp": datetime.utcnow() + (expires_delta or timedelta(hours=24))
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm="HS256")

# JWT Verification Middleware
async def get_current_user(token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        user_id = UUID(payload.get("sub"))
        
        user = await db.users.find_one({"id": user_id})
        if not user:
            raise HTTPException(401, "User not found")
        
        return user
    except JWTError:
        raise HTTPException(401, "Invalid token")
```

**Strengths:**
- Stateless (no server-side session storage)
- Scales horizontally
- Industry standard

**Weaknesses:**
- Can't revoke tokens before expiry (without blacklist)
- Token size can grow with claims

---

### Pattern 2: OAuth 2.0 / Social Login

**Used by:** Open WebUI, most consumer apps

```python
# OAuth Configuration
OAUTH_PROVIDERS = {
    "google": {
        "client_id": env.GOOGLE_CLIENT_ID,
        "client_secret": env.GOOGLE_CLIENT_SECRET,
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "userinfo_url": "https://www.googleapis.com/oauth2/v2/userinfo"
    },
    "github": {
        "client_id": env.GITHUB_CLIENT_ID,
        "client_secret": env.GITHUB_CLIENT_SECRET,
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "userinfo_url": "https://api.github.com/user"
    }
}

# OAuth Flow
@app.get("/auth/oauth/{provider}")
async def oauth_authorize(provider: str):
    config = OAUTH_PROVIDERS[provider]
    
    # Generate state for CSRF protection
    state = secrets.token_urlsafe(32)
    await redis.setex(f"oauth_state:{state}", 600, provider)
    
    # Build authorization URL
    params = {
        "client_id": config["client_id"],
        "redirect_uri": f"{BASE_URL}/auth/oauth/{provider}/callback",
        "scope": "openid email profile",
        "state": state,
        "response_type": "code"
    }
    
    auth_url = f"{config['authorize_url']}?{urlencode(params)}"
    return RedirectResponse(auth_url)

@app.get("/auth/oauth/{provider}/callback")
async def oauth_callback(provider: str, code: str, state: str):
    # Verify state
    stored_provider = await redis.get(f"oauth_state:{state}")
    if not stored_provider or stored_provider != provider:
        raise HTTPException(400, "Invalid state")
    
    config = OAUTH_PROVIDERS[provider]
    
    # Exchange code for access token
    token_response = await http_client.post(
        config["token_url"],
        data={
            "client_id": config["client_id"],
            "client_secret": config["client_secret"],
            "code": code,
            "redirect_uri": f"{BASE_URL}/auth/oauth/{provider}/callback",
            "grant_type": "authorization_code"
        }
    )
    
    access_token = token_response.json()["access_token"]
    
    # Get user info
    userinfo = await http_client.get(
        config["userinfo_url"],
        headers={"Authorization": f"Bearer {access_token}"}
    )
    
    user_data = userinfo.json()
    
    # Find or create user
    user = await db.users.find_one({
        f"oauth.{provider}.id": user_data["id"]
    })
    
    if not user:
        user = User(
            id=uuid4(),
            email=user_data["email"],
            name=user_data["name"],
            oauth={provider: {"id": user_data["id"]}},
            role="user",
            created_at=datetime.now()
        )
        await db.users.insert_one(user.dict())
    
    # Generate app token
    token = create_access_token(user.id)
    
    # Redirect to frontend with token
    return RedirectResponse(f"{FRONTEND_URL}/auth/callback?token={token}")
```

**Strengths:**
- No password management
- Better UX (one-click login)
- Trusted providers

**Weaknesses:**
- Requires external service
- More complex flow
- Privacy concerns (data shared with OAuth provider)

---

### Pattern 3: LDAP/Active Directory (Enterprise)

**Used by:** Open WebUI, enterprise apps

```python
from ldap3 import Server, Connection, ALL

# LDAP Configuration
LDAP_CONFIG = {
    "server": "ldap://ldap.company.com",
    "base_dn": "dc=company,dc=com",
    "bind_dn": "cn=admin,dc=company,dc=com",
    "bind_password": env.LDAP_PASSWORD,
    "user_search_filter": "(uid={username})"
}

# LDAP Authentication
async def authenticate_ldap(username: str, password: str):
    server = Server(LDAP_CONFIG["server"], get_info=ALL)
    
    # Search for user
    with Connection(
        server,
        user=LDAP_CONFIG["bind_dn"],
        password=LDAP_CONFIG["bind_password"]
    ) as conn:
        search_filter = LDAP_CONFIG["user_search_filter"].format(username=username)
        conn.search(
            LDAP_CONFIG["base_dn"],
            search_filter,
            attributes=["mail", "displayName", "memberOf"]
        )
        
        if not conn.entries:
            raise HTTPException(401, "User not found")
        
        user_dn = conn.entries[0].entry_dn
        user_data = conn.entries[0]
    
    # Verify password
    with Connection(server, user=user_dn, password=password) as conn:
        if not conn.bind():
            raise HTTPException(401, "Invalid password")
    
    # Find or create local user
    user = await db.users.find_one({"email": user_data.mail.value})
    
    if not user:
        # Extract role from group membership
        role = "user"
        if "cn=admins" in user_data.memberOf.values:
            role = "admin"
        
        user = User(
            id=uuid4(),
            email=user_data.mail.value,
            name=user_data.displayName.value,
            role=role,
            auth_method="ldap",
            created_at=datetime.now()
        )
        await db.users.insert_one(user.dict())
    
    token = create_access_token(user.id)
    return {"user": user, "token": token}
```

**Strengths:**
- Centralized user management
- Single source of truth
- Enterprise-ready

**Weaknesses:**
- Requires LDAP infrastructure
- More complex setup
- Network dependency

---

### Pattern 4: SCIM 2.0 Auto-Provisioning (Enterprise)

**Used by:** Open WebUI, identity-driven apps

```python
# SCIM User Schema
class SCIMUser(BaseModel):
    schemas: List[str] = ["urn:ietf:params:scim:schemas:core:2.0:User"]
    id: str
    userName: str
    name: dict
    emails: List[dict]
    active: bool
    groups: List[str] = []

# SCIM Endpoints
@app.post("/scim/v2/Users")
async def scim_create_user(scim_user: SCIMUser, token: str = Depends(verify_scim_token)):
    """Called by IdP (Okta, Azure AD) to create user"""
    
    # Check if user exists
    existing = await db.users.find_one({"email": scim_user.emails[0]["value"]})
    if existing:
        raise HTTPException(409, "User already exists")
    
    # Create user
    user = User(
        id=uuid4(),
        email=scim_user.emails[0]["value"],
        name=f"{scim_user.name['givenName']} {scim_user.name['familyName']}",
        external_id=scim_user.id,  # Store IdP's user ID
        role="user",
        is_active=scim_user.active,
        created_at=datetime.now()
    )
    
    await db.users.insert_one(user.dict())
    
    # Return SCIM response
    return {
        "schemas": scim_user.schemas,
        "id": str(user.id),
        "externalId": scim_user.id,
        "userName": scim_user.userName,
        "active": scim_user.active,
        "meta": {
            "resourceType": "User",
            "created": user.created_at.isoformat(),
            "location": f"/scim/v2/Users/{user.id}"
        }
    }

@app.patch("/scim/v2/Users/{user_id}")
async def scim_update_user(user_id: UUID, operations: dict):
    """Called by IdP to update user (e.g., deactivate)"""
    
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(404, "User not found")
    
    # Apply operations
    for op in operations["Operations"]:
        if op["op"] == "replace" and op["path"] == "active":
            await db.users.update_one(
                {"id": user_id},
                {"$set": {"is_active": op["value"]}}
            )
    
    return {"success": True}

@app.delete("/scim/v2/Users/{user_id}")
async def scim_delete_user(user_id: UUID):
    """Called by IdP to delete user"""
    
    # Soft delete or hard delete
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"is_active": False, "deleted_at": datetime.now()}}
    )
    
    return {"success": True}
```

**Strengths:**
- Automatic user provisioning/deprovisioning
- Centralized identity management
- Compliance-friendly (user lifecycle tracking)

**Weaknesses:**
- Complex protocol
- Requires IdP support
- Overkill for small deployments

---

## Chat Isolation vs Sharing

### Pattern 1: Strict Per-User Isolation

**Used by:** Most single-user systems, caretaker agent per-user chats

```python
# Chat Model
class Chat(BaseModel):
    id: UUID
    user_id: UUID  # Owner - ALWAYS present
    title: str
    created_at: datetime
    updated_at: datetime

# Access Control
async def get_user_chats(user_id: UUID) -> List[Chat]:
    return await db.chats.find({"user_id": user_id}).to_list()

async def get_chat(chat_id: UUID, user_id: UUID) -> Chat:
    chat = await db.chats.find_one({"id": chat_id})
    
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    if chat.user_id != user_id:
        raise HTTPException(403, "Access denied")
    
    return chat
```

**Strengths:**
- Simple to implement
- Clear ownership model
- No accidental leaks

**Weaknesses:**
- No collaboration
- No sharing capabilities

---

### Pattern 2: Optional Sharing with Permissions

**Used by:** Open WebUI, collaborative tools

```python
# Enhanced Chat Model
class Chat(BaseModel):
    id: UUID
    user_id: UUID  # Owner
    title: str
    shared_with: List[ChatPermission] = []
    created_at: datetime
    updated_at: datetime

class ChatPermission(BaseModel):
    user_id: UUID
    permission_level: str  # "read", "write", "admin"
    granted_at: datetime
    granted_by: UUID

# Access Control
async def check_chat_access(chat_id: UUID, user_id: UUID, required_level: str):
    chat = await db.chats.find_one({"id": chat_id})
    
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    # Owner has full access
    if chat.user_id == user_id:
        return True
    
    # Check shared permissions
    for perm in chat.shared_with:
        if perm.user_id == user_id:
            if required_level == "read":
                return True
            elif required_level == "write" and perm.permission_level in ["write", "admin"]:
                return True
            elif required_level == "admin" and perm.permission_level == "admin":
                return True
    
    raise HTTPException(403, "Access denied")

# Share Chat
async def share_chat(
    chat_id: UUID,
    user_id: UUID,  # Current user
    share_with_user_id: UUID,
    permission_level: str
):
    await check_chat_access(chat_id, user_id, "admin")
    
    await db.chats.update_one(
        {"id": chat_id},
        {"$push": {
            "shared_with": ChatPermission(
                user_id=share_with_user_id,
                permission_level=permission_level,
                granted_at=datetime.now(),
                granted_by=user_id
            ).dict()
        }}
    )
```

**Strengths:**
- Flexible collaboration
- Granular permissions
- Audit trail

**Weaknesses:**
- More complex to implement
- Permission checks on every access
- Risk of misconfiguration

---

### Pattern 3: Group-Based Access (Proposed for Caretaker Agent)

**For caretaker agent with family/team sharing:**

```python
# Group Model
class UserGroup(BaseModel):
    id: UUID
    name: str
    owner_id: UUID
    members: List[GroupMember]
    created_at: datetime

class GroupMember(BaseModel):
    user_id: UUID
    role: str  # "owner", "admin", "member"
    joined_at: datetime

# Chat with Group Scope
class Chat(BaseModel):
    id: UUID
    user_id: UUID  # Primary user
    group_id: Optional[UUID] = None  # If shared with group
    title: str
    created_at: datetime

# Access Control
async def check_chat_access(chat_id: UUID, user_id: UUID):
    chat = await db.chats.find_one({"id": chat_id})
    
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    # Owner access
    if chat.user_id == user_id:
        return True
    
    # Group access
    if chat.group_id:
        group = await db.groups.find_one({"id": chat.group_id})
        if any(m.user_id == user_id for m in group.members):
            return True
    
    raise HTTPException(403, "Access denied")
```

**Use Case for Caretaker Agent:**
- Family creates a group
- Each family member has their own chat with the caretaker
- Caretaker can reference knowledge from other family members (with permission)
- Example: "Tell mom dinner is ready" → Caretaker creates notification in mom's chat

**Strengths:**
- Natural for families/teams
- Simpler than per-chat permissions
- Scales to multiple groups

---

## Session Management

### Pattern 1: Stateless JWT (Frontend Storage)

```python
# Frontend stores JWT in localStorage or cookie
# Every API request includes JWT in Authorization header

# API Endpoint
@app.get("/api/chats")
async def get_chats(current_user: User = Depends(get_current_user)):
    return await db.chats.find({"user_id": current_user.id}).to_list()
```

**Strengths:**
- No server-side state
- Scales horizontally
- Simple to implement

**Weaknesses:**
- Can't revoke tokens
- XSS risk if stored in localStorage
- Limited by token size

---

### Pattern 2: Redis Session Store (Server-Side)

**Used by:** Open WebUI for multi-worker deployments

```python
# Session Model
class Session(BaseModel):
    session_id: str
    user_id: UUID
    created_at: datetime
    expires_at: datetime
    ip_address: str
    user_agent: str

# Create Session
async def create_session(user_id: UUID, request: Request) -> str:
    session_id = secrets.token_urlsafe(32)
    
    session = Session(
        session_id=session_id,
        user_id=user_id,
        created_at=datetime.now(),
        expires_at=datetime.now() + timedelta(days=7),
        ip_address=request.client.host,
        user_agent=request.headers.get("User-Agent")
    )
    
    # Store in Redis with TTL
    await redis.setex(
        f"session:{session_id}",
        604800,  # 7 days
        session.json()
    )
    
    return session_id

# Verify Session
async def get_current_user_from_session(
    session_id: str = Cookie(None)
) -> User:
    if not session_id:
        raise HTTPException(401, "Not authenticated")
    
    session_data = await redis.get(f"session:{session_id}")
    
    if not session_data:
        raise HTTPException(401, "Session expired")
    
    session = Session.parse_raw(session_data)
    
    if session.expires_at < datetime.now():
        await redis.delete(f"session:{session_id}")
        raise HTTPException(401, "Session expired")
    
    user = await db.users.find_one({"id": session.user_id})
    
    if not user:
        raise HTTPException(401, "User not found")
    
    return user

# Logout (Revoke Session)
async def logout(session_id: str):
    await redis.delete(f"session:{session_id}")
```

**Strengths:**
- Can revoke sessions instantly
- Stored securely server-side
- Can track active sessions

**Weaknesses:**
- Requires Redis infrastructure
- Redis is a single point of failure (use Redis Sentinel/Cluster)
- Slightly higher latency

---

### Pattern 3: Hybrid (JWT + Redis Blacklist)

**Best of both worlds:**

```python
# Use JWT for authentication (stateless)
# Use Redis blacklist for revocation

# Blacklist Token
async def revoke_token(token: str):
    payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    exp = payload.get("exp")
    
    # Add to blacklist until token expires
    ttl = exp - int(datetime.now().timestamp())
    await redis.setex(f"blacklist:{token}", ttl, "1")

# Verify Token (with Blacklist Check)
async def get_current_user(token: str = Depends(oauth2_scheme)):
    # Check blacklist
    if await redis.exists(f"blacklist:{token}"):
        raise HTTPException(401, "Token revoked")
    
    # Verify JWT
    payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
    user_id = UUID(payload.get("sub"))
    
    user = await db.users.find_one({"id": user_id})
    if not user:
        raise HTTPException(401, "User not found")
    
    return user
```

**Strengths:**
- Stateless by default
- Can revoke when needed
- Minimal Redis usage

---

## Database Schema Design

### Recommended Schema for Multi-User Caretaker Agent

```sql
-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255),  -- NULL if OAuth-only
    role VARCHAR(50) DEFAULT 'user',  -- 'admin', 'user'
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    last_login TIMESTAMP,
    oauth_providers JSONB DEFAULT '{}',  -- {google: {id: "..."}}
    
    CONSTRAINT valid_email CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$')
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(is_active);

-- Groups Table (for families/teams)
CREATE TABLE groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_groups_owner ON groups(owner_id);

-- Group Memberships
CREATE TABLE group_members (
    group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) DEFAULT 'member',  -- 'owner', 'admin', 'member'
    joined_at TIMESTAMP DEFAULT NOW(),
    
    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user ON group_members(user_id);

-- Chats Table
CREATE TABLE chats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    group_id UUID REFERENCES groups(id) ON DELETE SET NULL,  -- Optional group scope
    title VARCHAR(255) NOT NULL,
    system_prompt TEXT,
    model_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_chats_user ON chats(user_id);
CREATE INDEX idx_chats_group ON chats(group_id);
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);

-- Messages Table
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,  -- 'system', 'user', 'assistant', 'tool'
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',  -- {images: [...], tool_calls: [...]}
    created_at TIMESTAMP DEFAULT NOW(),
    
    CONSTRAINT valid_role CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE INDEX idx_messages_chat ON messages(chat_id, created_at);

-- Shared Knowledge (Cross-Chat Memory for Caretaker Agent)
CREATE TABLE shared_knowledge (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(50) NOT NULL,  -- 'user_info', 'relationship', 'task'
    content TEXT NOT NULL,
    source_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    source_chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    visibility_scope VARCHAR(50) DEFAULT 'private',  -- 'private', 'group', 'public'
    visibility_target_ids UUID[],  -- User or group IDs
    embedding vector(384),  -- pgvector for semantic search
    status VARCHAR(50) DEFAULT 'active',  -- 'active', 'completed', 'archived'
    priority INTEGER DEFAULT 0,  -- For task prioritization
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    
    CONSTRAINT valid_category CHECK (category IN ('user_info', 'relationship', 'task', 'fact', 'preference'))
);

CREATE INDEX idx_knowledge_source_user ON shared_knowledge(source_user_id);
CREATE INDEX idx_knowledge_category ON shared_knowledge(category);
CREATE INDEX idx_knowledge_status ON shared_knowledge(status);
CREATE INDEX idx_knowledge_embedding ON shared_knowledge USING ivfflat (embedding vector_cosine_ops);

-- Memory Chunks (Per-Chat Semantic Memory)
CREATE TABLE memory_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding vector(384),
    message_count INTEGER DEFAULT 5,
    first_message_at TIMESTAMP,
    last_message_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_memory_chunks_chat ON memory_chunks(chat_id);
CREATE INDEX idx_memory_chunks_embedding ON memory_chunks USING ivfflat (embedding vector_cosine_ops);

-- Audit Log
CREATE TABLE audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,  -- 'read', 'write', 'share', 'delete'
    resource_type VARCHAR(50) NOT NULL,  -- 'chat', 'message', 'knowledge'
    resource_id UUID,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id);
```

**Key Design Decisions:**

1. **UUID Primary Keys**: Better for distributed systems, no auto-increment collisions
2. **JSONB for Flexible Data**: `metadata`, `oauth_providers` allow schema evolution
3. **pgvector for Embeddings**: Native vector search without separate database
4. **Cascade Deletes**: Automatic cleanup when user/chat deleted
5. **Audit Log**: Track all sensitive operations for compliance
6. **Timestamps**: Always track `created_at`, `updated_at` for debugging

---

## Message Routing Architectures

### Pattern 1: Direct System Message Injection

**For caretaker agent to inject notifications:**

```python
class MessageRouter:
    async def relay_message(
        self,
        from_user_id: UUID,
        to_user_id: UUID,
        message: str,
        priority: int = 0
    ):
        # 1. Store as shared knowledge (task)
        task = await db.shared_knowledge.insert_one({
            "id": uuid4(),
            "category": "task",
            "content": f"Message from {from_user_id}: {message}",
            "source_user_id": from_user_id,
            "visibility_scope": "private",
            "visibility_target_ids": [to_user_id],
            "status": "pending",
            "priority": priority,
            "created_at": datetime.now()
        })
        
        # 2. Get or create active chat for target user
        active_chat = await self.get_or_create_active_chat(to_user_id)
        
        # 3. Inject as system message
        await db.messages.insert_one({
            "id": uuid4(),
            "chat_id": active_chat.id,
            "role": "system",
            "content": f"[NOTIFICATION] {message}",
            "metadata": {"task_id": str(task.id), "from_user": str(from_user_id)},
            "created_at": datetime.now()
        })
        
        # 4. Notify via WebSocket (if connected)
        await self.notify_user(to_user_id, {
            "type": "new_message",
            "chat_id": str(active_chat.id)
        })
    
    async def get_or_create_active_chat(self, user_id: UUID) -> Chat:
        # Find most recent chat
        recent_chat = await db.chats.find_one(
            {"user_id": user_id},
            sort=[("updated_at", -1)]
        )
        
        if recent_chat and (datetime.now() - recent_chat.updated_at).days < 1:
            return recent_chat
        
        # Create new chat
        return await db.chats.insert_one({
            "id": uuid4(),
            "user_id": user_id,
            "title": f"Chat {datetime.now().strftime('%Y-%m-%d')}",
            "created_at": datetime.now(),
            "updated_at": datetime.now()
        })
```

---

### Pattern 2: Pending Tasks Queue

**Agent checks for tasks on each user message:**

```python
class CaretakerAgent:
    async def process_message(
        self,
        chat_id: UUID,
        user_id: UUID,
        user_message: str
    ):
        # 1. Check for pending tasks for this user
        pending_tasks = await db.shared_knowledge.find({
            "category": "task",
            "visibility_target_ids": {"$in": [user_id]},
            "status": "pending"
        }).to_list()
        
        # 2. Build context with pending tasks
        context_parts = []
        
        if pending_tasks:
            context_parts.append("You have pending notifications:")
            for task in sorted(pending_tasks, key=lambda t: t.priority, reverse=True):
                context_parts.append(f"- {task.content}")
            
            # Mark as delivered
            await db.shared_knowledge.update_many(
                {"id": {"$in": [t.id for t in pending_tasks]}},
                {"$set": {"status": "delivered"}}
            )
        
        # 3. Get chat history
        messages = await self.get_chat_history(chat_id)
        
        # 4. Add context to system prompt
        system_prompt = self.base_system_prompt
        if context_parts:
            system_prompt += "\n\n" + "\n".join(context_parts)
        
        # 5. Generate response
        response = await self.llm.generate(
            messages=[
                {"role": "system", "content": system_prompt},
                *messages,
                {"role": "user", "content": user_message}
            ]
        )
        
        return response
```

---

### Pattern 3: Event-Driven with Message Queue

**For high-scale deployments:**

```python
# Using RabbitMQ or Redis Streams

class MessageBroker:
    async def publish_event(self, event_type: str, payload: dict):
        await redis.xadd(
            f"events:{event_type}",
            {"payload": json.dumps(payload)}
        )
    
    async def subscribe_events(self, event_type: str, handler: callable):
        while True:
            events = await redis.xread(
                {f"events:{event_type}": "$"},
                count=10,
                block=1000
            )
            
            for stream, messages in events:
                for message_id, data in messages:
                    payload = json.loads(data[b"payload"])
                    await handler(payload)

# Event Handlers
broker = MessageBroker()

@broker.subscribe_events("message_relay")
async def handle_message_relay(payload):
    await message_router.relay_message(
        from_user_id=UUID(payload["from_user_id"]),
        to_user_id=UUID(payload["to_user_id"]),
        message=payload["message"]
    )

# Publish Event
await broker.publish_event("message_relay", {
    "from_user_id": str(from_user.id),
    "to_user_id": str(to_user.id),
    "message": "Dinner is ready!"
})
```

**Strengths:**
- Decoupled components
- Scalable (multiple workers)
- Reliable (message persistence)

**Weaknesses:**
- More infrastructure
- Eventual consistency
- Complexity

---

## WebSocket & Real-Time Communication

### Pattern: WebSocket with User Channels

```python
from fastapi import WebSocket, WebSocketDisconnect
from typing import Dict

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[UUID, List[WebSocket]] = {}
    
    async def connect(self, user_id: UUID, websocket: WebSocket):
        await websocket.accept()
        
        if user_id not in self.active_connections:
            self.active_connections[user_id] = []
        
        self.active_connections[user_id].append(websocket)
    
    async def disconnect(self, user_id: UUID, websocket: WebSocket):
        if user_id in self.active_connections:
            self.active_connections[user_id].remove(websocket)
            
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]
    
    async def send_to_user(self, user_id: UUID, message: dict):
        if user_id not in self.active_connections:
            return  # User not connected
        
        for websocket in self.active_connections[user_id]:
            try:
                await websocket.send_json(message)
            except:
                # Connection dead, will be cleaned up on disconnect
                pass

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(None)
):
    # Verify user
    try:
        user = await get_current_user_from_token(token)
    except:
        await websocket.close(code=1008)  # Policy violation
        return
    
    await manager.connect(user.id, websocket)
    
    try:
        while True:
            # Receive messages from client
            data = await websocket.receive_json()
            
            # Handle different message types
            if data["type"] == "ping":
                await websocket.send_json({"type": "pong"})
            
            elif data["type"] == "chat_message":
                # Process chat message
                response = await process_chat_message(
                    user.id,
                    data["chat_id"],
                    data["message"]
                )
                
                # Send response
                await websocket.send_json({
                    "type": "chat_response",
                    "chat_id": data["chat_id"],
                    "message": response
                })
    
    except WebSocketDisconnect:
        await manager.disconnect(user.id, websocket)
```

**Usage for Caretaker Agent:**

```python
# When relaying message, notify via WebSocket
async def relay_message(from_user_id: UUID, to_user_id: UUID, message: str):
    # Store in database (as before)
    ...
    
    # Send real-time notification
    await manager.send_to_user(to_user_id, {
        "type": "notification",
        "message": f"Message from {from_user.name}: {message}",
        "action": "open_chat"
    })
```

---

## Horizontal Scaling Patterns

### Pattern: Redis PubSub for Multi-Server WebSocket

**Problem:** User connects to Server A, but notification comes from Server B

**Solution:**

```python
class DistributedConnectionManager:
    def __init__(self):
        self.local_connections: Dict[UUID, List[WebSocket]] = {}
        self.redis = Redis()
        self.pubsub = self.redis.pubsub()
        
        # Subscribe to broadcasts
        asyncio.create_task(self.listen_broadcasts())
    
    async def listen_broadcasts(self):
        self.pubsub.subscribe("websocket_broadcasts")
        
        for message in self.pubsub.listen():
            if message["type"] == "message":
                data = json.loads(message["data"])
                user_id = UUID(data["user_id"])
                payload = data["payload"]
                
                # Send to local connections only
                await self.send_to_local(user_id, payload)
    
    async def send_to_local(self, user_id: UUID, message: dict):
        if user_id in self.local_connections:
            for ws in self.local_connections[user_id]:
                await ws.send_json(message)
    
    async def send_to_user(self, user_id: UUID, message: dict):
        # Publish to all servers via Redis
        await self.redis.publish(
            "websocket_broadcasts",
            json.dumps({
                "user_id": str(user_id),
                "payload": message
            })
        )
```

---

**End of Multi-User Architecture Document**
