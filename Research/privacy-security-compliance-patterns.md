# Privacy, Security & Compliance Patterns for Multi-User AI Systems

**Research Date:** April 29, 2026  
**Purpose:** Security best practices and compliance patterns for multi-user AI chat systems

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [Authentication Security](#authentication-security)
3. [Data Isolation & Access Control](#data-isolation--access-control)
4. [Encryption](#encryption)
5. [Audit Logging](#audit-logging)
6. [Content Moderation](#content-moderation)
7. [Rate Limiting & DoS Protection](#rate-limiting--dos-protection)
8. [Privacy Compliance](#privacy-compliance)
9. [Secure Deployment](#secure-deployment)

---

## Threat Model

### Threat Actors

**External Attackers:**
- Unauthorized access to user data
- API abuse / DoS attacks
- Credential theft
- SQL injection / code injection

**Malicious Users:**
- Access other users' chats
- Data exfiltration via prompts
- Prompt injection attacks
- System resource abuse

**Compromised Accounts:**
- Lateral movement to other users
- Data modification/deletion
- Privilege escalation

**Insider Threats:**
- Database admin access
- Deployment server access
- API key exposure

### Attack Vectors

1. **Authentication Bypass**: Weak passwords, token theft, session hijacking
2. **Authorization Bypass**: IDOR, privilege escalation, broken access control
3. **Injection Attacks**: SQL injection, prompt injection, XSS
4. **Data Leakage**: Cross-user data exposure, verbose errors, timing attacks
5. **DoS**: Resource exhaustion, expensive LLM calls, database flooding

---

## Authentication Security

### Best Practice 1: Strong Password Policy

```python
import re
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

def validate_password_strength(password: str) -> tuple[bool, str]:
    """Enforce strong password requirements"""
    
    if len(password) < 12:
        return False, "Password must be at least 12 characters"
    
    if not re.search(r"[a-z]", password):
        return False, "Password must contain lowercase letters"
    
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain uppercase letters"
    
    if not re.search(r"\d", password):
        return False, "Password must contain numbers"
    
    if not re.search(r"[!@#$%^&*(),.?\":{}|<>]", password):
        return False, "Password must contain special characters"
    
    # Check against common passwords list
    if password.lower() in COMMON_PASSWORDS:
        return False, "Password is too common"
    
    return True, "Password is strong"

def hash_password(password: str) -> str:
    """Hash password with Argon2"""
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password against hash"""
    return pwd_context.verify(plain_password, hashed_password)
```

**Implementation:**
- **Argon2**: Memory-hard hashing (resistant to GPU cracking)
- **Min 12 characters**: Reduces brute-force risk
- **Complexity requirements**: Forces stronger passwords
- **Common password list**: Blocks dictionary attacks

---

### Best Practice 2: Multi-Factor Authentication (MFA)

```python
import pyotp
import qrcode
from io import BytesIO
import base64

class MFAManager:
    @staticmethod
    def generate_secret() -> str:
        """Generate TOTP secret"""
        return pyotp.random_base32()
    
    @staticmethod
    def generate_qr_code(user_email: str, secret: str) -> str:
        """Generate QR code for authenticator app"""
        totp = pyotp.TOTP(secret)
        uri = totp.provisioning_uri(
            name=user_email,
            issuer_name="Caretaker Agent"
        )
        
        # Generate QR code
        qr = qrcode.make(uri)
        buffer = BytesIO()
        qr.save(buffer, format="PNG")
        
        # Return base64 encoded image
        return base64.b64encode(buffer.getvalue()).decode()
    
    @staticmethod
    def verify_totp(secret: str, token: str) -> bool:
        """Verify TOTP token"""
        totp = pyotp.TOTP(secret)
        return totp.verify(token, valid_window=1)  # Allow 30s drift

# User Model with MFA
class User(BaseModel):
    id: UUID
    email: str
    password_hash: str
    mfa_enabled: bool = False
    mfa_secret: Optional[str] = None
    backup_codes: List[str] = []

# Enable MFA
async def enable_mfa(user_id: UUID) -> dict:
    user = await db.users.find_one({"id": user_id})
    
    # Generate secret
    secret = MFAManager.generate_secret()
    
    # Generate backup codes
    backup_codes = [secrets.token_hex(4) for _ in range(10)]
    
    # Save to database (encrypted)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {
            "mfa_secret": encrypt(secret),
            "backup_codes": [hash_password(code) for code in backup_codes],
            "mfa_enabled": False  # Not enabled until verified
        }}
    )
    
    # Return QR code and backup codes
    qr_code = MFAManager.generate_qr_code(user.email, secret)
    
    return {
        "qr_code": qr_code,
        "backup_codes": backup_codes
    }

# Login with MFA
async def login_with_mfa(email: str, password: str, mfa_token: str):
    user = await db.users.find_one({"email": email})
    
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")
    
    if user.mfa_enabled:
        secret = decrypt(user.mfa_secret)
        
        # Verify TOTP
        if not MFAManager.verify_totp(secret, mfa_token):
            # Try backup codes
            for i, backup_hash in enumerate(user.backup_codes):
                if verify_password(mfa_token, backup_hash):
                    # Valid backup code - remove it (one-time use)
                    await db.users.update_one(
                        {"id": user.id},
                        {"$pull": {"backup_codes": backup_hash}}
                    )
                    break
            else:
                raise HTTPException(401, "Invalid MFA token")
    
    # Generate session token
    token = create_access_token(user.id)
    return {"token": token}
```

---

### Best Practice 3: Secure Token Management

```python
from datetime import datetime, timedelta
import jwt

SECRET_KEY = os.getenv("JWT_SECRET_KEY")  # Strong random key
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60
REFRESH_TOKEN_EXPIRE_DAYS = 30

def create_access_token(user_id: UUID, expires_delta: timedelta = None) -> str:
    """Create short-lived access token"""
    to_encode = {
        "sub": str(user_id),
        "type": "access",
        "exp": datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)),
        "iat": datetime.utcnow()
    }
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)

def create_refresh_token(user_id: UUID) -> str:
    """Create long-lived refresh token"""
    to_encode = {
        "sub": str(user_id),
        "type": "refresh",
        "exp": datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        "iat": datetime.utcnow()
    }
    
    token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    
    # Store refresh token in database (for revocation)
    await db.refresh_tokens.insert_one({
        "token": token,
        "user_id": user_id,
        "created_at": datetime.utcnow(),
        "expires_at": datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        "revoked": False
    })
    
    return token

async def verify_token(token: str, expected_type: str = "access") -> User:
    """Verify JWT token"""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        
        # Check token type
        if payload.get("type") != expected_type:
            raise HTTPException(401, "Invalid token type")
        
        # Check if refresh token was revoked
        if expected_type == "refresh":
            token_record = await db.refresh_tokens.find_one({"token": token})
            if not token_record or token_record.get("revoked"):
                raise HTTPException(401, "Token revoked")
        
        user_id = UUID(payload.get("sub"))
        user = await db.users.find_one({"id": user_id})
        
        if not user or not user.is_active:
            raise HTTPException(401, "User not found or inactive")
        
        return user
    
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.JWTError:
        raise HTTPException(401, "Invalid token")

async def refresh_access_token(refresh_token: str) -> str:
    """Use refresh token to get new access token"""
    user = await verify_token(refresh_token, "refresh")
    return create_access_token(user.id)
```

**Security Benefits:**
- **Short-lived access tokens**: Limit exposure window (1 hour)
- **Refresh tokens**: Long-lived but revocable
- **Token type verification**: Prevent token misuse
- **Revocation support**: Can invalidate refresh tokens

---

## Data Isolation & Access Control

### Pattern 1: Row-Level Security (PostgreSQL)

```sql
-- Enable RLS on tables
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_knowledge ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their own chats
CREATE POLICY chat_owner_policy ON chats
    FOR ALL
    USING (user_id = current_setting('app.current_user_id')::uuid);

-- Policy: Users can only access messages in their chats
CREATE POLICY message_owner_policy ON messages
    FOR ALL
    USING (
        chat_id IN (
            SELECT id FROM chats 
            WHERE user_id = current_setting('app.current_user_id')::uuid
        )
    );

-- Policy: Shared knowledge visibility
CREATE POLICY knowledge_visibility_policy ON shared_knowledge
    FOR SELECT
    USING (
        visibility_scope = 'public'
        OR source_user_id = current_setting('app.current_user_id')::uuid
        OR current_setting('app.current_user_id')::uuid = ANY(visibility_target_ids)
    );

-- Application sets user context
-- Before each query:
-- SET LOCAL app.current_user_id = 'user-uuid-here';
```

**Implementation in Application:**

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def user_context(user_id: UUID):
    """Set user context for RLS"""
    async with db.transaction() as txn:
        await txn.execute(
            "SET LOCAL app.current_user_id = %s",
            (str(user_id),)
        )
        yield txn

# Usage
async def get_user_chats(user_id: UUID):
    async with user_context(user_id):
        # RLS automatically filters to user's chats
        return await db.chats.find().to_list()
```

---

### Pattern 2: Application-Level Access Control

```python
class AccessControl:
    @staticmethod
    async def check_chat_access(
        chat_id: UUID,
        user_id: UUID,
        required_permission: str = "read"
    ):
        """Check if user has permission to access chat"""
        chat = await db.chats.find_one({"id": chat_id})
        
        if not chat:
            raise HTTPException(404, "Chat not found")
        
        # Owner has full access
        if chat.user_id == user_id:
            return True
        
        # Check group membership
        if chat.group_id:
            is_member = await db.group_members.find_one({
                "group_id": chat.group_id,
                "user_id": user_id
            })
            
            if is_member:
                return True
        
        # Check explicit shares
        for share in chat.shared_with:
            if share.user_id == user_id:
                if required_permission == "read":
                    return True
                elif required_permission == "write" and share.permission in ["write", "admin"]:
                    return True
                elif required_permission == "admin" and share.permission == "admin":
                    return True
        
        raise HTTPException(403, "Access denied")
    
    @staticmethod
    async def check_knowledge_access(
        knowledge_id: UUID,
        user_id: UUID
    ):
        """Check if user can access shared knowledge"""
        knowledge = await db.shared_knowledge.find_one({"id": knowledge_id})
        
        if not knowledge:
            raise HTTPException(404, "Knowledge not found")
        
        # Creator can always access
        if knowledge.source_user_id == user_id:
            return True
        
        # Check visibility
        if knowledge.visibility_scope == "public":
            return True
        
        if user_id in knowledge.visibility_target_ids:
            return True
        
        raise HTTPException(403, "Access denied")

# Use as dependency
async def require_chat_access(
    chat_id: UUID,
    current_user: User = Depends(get_current_user)
):
    await AccessControl.check_chat_access(chat_id, current_user.id)
    return chat_id

# In endpoint
@app.get("/chats/{chat_id}/messages")
async def get_messages(
    chat_id: UUID = Depends(require_chat_access)
):
    return await db.messages.find({"chat_id": chat_id}).to_list()
```

---

### Pattern 3: Prevent Insecure Direct Object Reference (IDOR)

```python
# BAD - Vulnerable to IDOR
@app.get("/chats/{chat_id}")
async def get_chat(chat_id: UUID):
    # No access check!
    return await db.chats.find_one({"id": chat_id})

# GOOD - Protected
@app.get("/chats/{chat_id}")
async def get_chat(
    chat_id: UUID,
    current_user: User = Depends(get_current_user)
):
    chat = await db.chats.find_one({"id": chat_id})
    
    if not chat:
        raise HTTPException(404, "Chat not found")
    
    # Verify ownership
    if chat.user_id != current_user.id:
        raise HTTPException(403, "Access denied")
    
    return chat
```

---

## Encryption

### Pattern 1: Encryption at Rest

```python
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2
import base64

class EncryptionService:
    def __init__(self, master_key: str):
        # Derive encryption key from master key
        kdf = PBKDF2(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b'static_salt_change_in_prod',  # Use proper salt
            iterations=100000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(master_key.encode()))
        self.cipher = Fernet(key)
    
    def encrypt(self, plaintext: str) -> str:
        """Encrypt sensitive data"""
        return self.cipher.encrypt(plaintext.encode()).decode()
    
    def decrypt(self, ciphertext: str) -> str:
        """Decrypt sensitive data"""
        return self.cipher.decrypt(ciphertext.encode()).decode()

encryption = EncryptionService(os.getenv("MASTER_ENCRYPTION_KEY"))

# Encrypt sensitive fields
class User(BaseModel):
    id: UUID
    email: str
    password_hash: str
    mfa_secret: Optional[str] = None  # ENCRYPTED
    
    def set_mfa_secret(self, secret: str):
        self.mfa_secret = encryption.encrypt(secret)
    
    def get_mfa_secret(self) -> str:
        return encryption.decrypt(self.mfa_secret)
```

**What to Encrypt:**
- MFA secrets
- API keys
- OAuth tokens
- Personally identifiable information (PII)

**What NOT to Encrypt:**
- Passwords (use hashing, not encryption)
- Frequently searched fields (encryption prevents indexing)
- Non-sensitive data (adds overhead)

---

### Pattern 2: Encryption in Transit (TLS)

```python
# Force HTTPS in production
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware

if PRODUCTION:
    app.add_middleware(HTTPSRedirectMiddleware)

# Secure cookies
from fastapi import Response

def set_secure_cookie(response: Response, name: str, value: str):
    response.set_cookie(
        key=name,
        value=value,
        httponly=True,  # Prevent JavaScript access
        secure=True,    # HTTPS only
        samesite="strict",  # CSRF protection
        max_age=3600
    )
```

---

## Audit Logging

### Pattern: Comprehensive Audit Trail

```python
from enum import Enum

class AuditAction(str, Enum):
    LOGIN = "login"
    LOGOUT = "logout"
    CREATE_CHAT = "create_chat"
    DELETE_CHAT = "delete_chat"
    VIEW_CHAT = "view_chat"
    SHARE_CHAT = "share_chat"
    CREATE_MESSAGE = "create_message"
    DELETE_MESSAGE = "delete_message"
    ACCESS_KNOWLEDGE = "access_knowledge"
    MODIFY_USER = "modify_user"

class AuditLog(BaseModel):
    id: UUID
    user_id: Optional[UUID]  # None for anonymous actions
    action: AuditAction
    resource_type: str  # "chat", "message", "user"
    resource_id: Optional[UUID]
    details: dict  # Additional context
    ip_address: str
    user_agent: str
    status: str  # "success", "failure"
    timestamp: datetime

class AuditLogger:
    @staticmethod
    async def log(
        action: AuditAction,
        user_id: Optional[UUID] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[UUID] = None,
        details: dict = {},
        status: str = "success",
        request: Request = None
    ):
        """Log audit event"""
        
        log_entry = AuditLog(
            id=uuid4(),
            user_id=user_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            details=details,
            ip_address=request.client.host if request else None,
            user_agent=request.headers.get("User-Agent") if request else None,
            status=status,
            timestamp=datetime.utcnow()
        )
        
        await db.audit_logs.insert_one(log_entry.dict())
        
        # Also log to external SIEM if configured
        if SIEM_ENABLED:
            await send_to_siem(log_entry)

# Usage in endpoints
@app.delete("/chats/{chat_id}")
async def delete_chat(
    chat_id: UUID,
    current_user: User = Depends(get_current_user),
    request: Request
):
    await AccessControl.check_chat_access(chat_id, current_user.id, "admin")
    
    try:
        await db.chats.delete_one({"id": chat_id})
        
        # Audit success
        await AuditLogger.log(
            action=AuditAction.DELETE_CHAT,
            user_id=current_user.id,
            resource_type="chat",
            resource_id=chat_id,
            status="success",
            request=request
        )
        
        return {"success": True}
    
    except Exception as e:
        # Audit failure
        await AuditLogger.log(
            action=AuditAction.DELETE_CHAT,
            user_id=current_user.id,
            resource_type="chat",
            resource_id=chat_id,
            details={"error": str(e)},
            status="failure",
            request=request
        )
        
        raise

# Query audit logs
async def get_user_activity(user_id: UUID, days: int = 30):
    """Get user activity for compliance/security review"""
    since = datetime.utcnow() - timedelta(days=days)
    
    return await db.audit_logs.find({
        "user_id": user_id,
        "timestamp": {"$gte": since}
    }).sort("timestamp", -1).to_list()
```

**What to Log:**
- Authentication events (login, logout, MFA)
- Authorization failures
- Data access (especially sensitive data)
- Data modifications (create, update, delete)
- Privilege escalations
- Configuration changes

**What NOT to Log:**
- Passwords or tokens
- Full message content (privacy concerns)
- PII unless necessary

---

## Content Moderation

### Pattern: Prompt Injection Detection

```python
class PromptSecurityScanner:
    # Patterns indicating potential prompt injection
    INJECTION_PATTERNS = [
        r"ignore (all )?previous (instructions|commands|prompts)",
        r"disregard (all )?previous (instructions|commands|prompts)",
        r"you are now",
        r"new instructions:",
        r"system: ",
        r"from now on",
        r"</system>",
        r"<\|im_end\|>",
    ]
    
    @staticmethod
    def scan_for_injection(text: str) -> tuple[bool, str]:
        """Detect potential prompt injection attempts"""
        text_lower = text.lower()
        
        for pattern in PromptSecurityScanner.INJECTION_PATTERNS:
            if re.search(pattern, text_lower):
                return True, f"Potential prompt injection detected: {pattern}"
        
        # Check for excessive special characters
        special_chars = len(re.findall(r'[^a-zA-Z0-9\s.,!?]', text))
        if special_chars > len(text) * 0.3:
            return True, "Excessive special characters"
        
        return False, ""
    
    @staticmethod
    async def moderate_message(
        user_message: str,
        user_id: UUID,
        chat_id: UUID
    ) -> tuple[bool, str]:
        """Full content moderation check"""
        
        # 1. Prompt injection check
        is_injection, reason = PromptSecurityScanner.scan_for_injection(user_message)
        if is_injection:
            await AuditLogger.log(
                action="prompt_injection_detected",
                user_id=user_id,
                resource_type="message",
                details={"reason": reason, "message": user_message[:100]},
                status="blocked"
            )
            return False, "Message blocked: " + reason
        
        # 2. Excessive length
        if len(user_message) > 10000:
            return False, "Message too long"
        
        # 3. Rate limiting (separate function)
        if not await check_rate_limit(user_id):
            return False, "Rate limit exceeded"
        
        return True, ""

# Usage
@app.post("/chats/{chat_id}/messages")
async def create_message(
    chat_id: UUID,
    message: str,
    current_user: User = Depends(get_current_user)
):
    # Moderate message
    is_allowed, reason = await PromptSecurityScanner.moderate_message(
        message,
        current_user.id,
        chat_id
    )
    
    if not is_allowed:
        raise HTTPException(400, reason)
    
    # Proceed with message creation
    ...
```

---

### Pattern: LLM Output Filtering

```python
class OutputFilter:
    @staticmethod
    def filter_sensitive_data(text: str) -> str:
        """Remove sensitive data from LLM output"""
        
        # Remove credit card numbers
        text = re.sub(r'\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b', '[REDACTED]', text)
        
        # Remove SSN
        text = re.sub(r'\b\d{3}-\d{2}-\d{4}\b', '[REDACTED]', text)
        
        # Remove email addresses (if needed)
        # text = re.sub(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b', '[REDACTED]', text)
        
        return text
    
    @staticmethod
    def check_output_safety(text: str) -> tuple[bool, str]:
        """Check if output is safe to return"""
        
        # Check for system prompt leakage
        if "system:" in text.lower() or "you are a" in text.lower()[:100]:
            return False, "Potential system prompt leakage"
        
        # Check for training data leakage
        # (Custom logic based on your system)
        
        return True, ""
```

---

## Rate Limiting & DoS Protection

### Pattern: Token Bucket Rate Limiting

```python
from datetime import datetime, timedelta
import asyncio

class RateLimiter:
    def __init__(self, redis_client):
        self.redis = redis_client
    
    async def check_rate_limit(
        self,
        key: str,
        max_requests: int,
        window_seconds: int
    ) -> bool:
        """
        Token bucket rate limiting
        
        Args:
            key: Unique identifier (user_id, ip_address)
            max_requests: Maximum requests allowed
            window_seconds: Time window in seconds
        """
        now = datetime.utcnow().timestamp()
        window_start = now - window_seconds
        
        # Remove old entries
        await self.redis.zremrangebyscore(f"rate_limit:{key}", 0, window_start)
        
        # Count requests in current window
        request_count = await self.redis.zcard(f"rate_limit:{key}")
        
        if request_count >= max_requests:
            return False  # Rate limit exceeded
        
        # Add current request
        await self.redis.zadd(f"rate_limit:{key}", {str(now): now})
        await self.redis.expire(f"rate_limit:{key}", window_seconds)
        
        return True
    
    async def get_remaining(
        self,
        key: str,
        max_requests: int,
        window_seconds: int
    ) -> int:
        """Get remaining requests in current window"""
        now = datetime.utcnow().timestamp()
        window_start = now - window_seconds
        
        await self.redis.zremrangebyscore(f"rate_limit:{key}", 0, window_start)
        request_count = await self.redis.zcard(f"rate_limit:{key}")
        
        return max(0, max_requests - request_count)

rate_limiter = RateLimiter(redis_client)

# Rate limit by user
async def check_user_rate_limit(user_id: UUID) -> bool:
    # 100 requests per minute
    return await rate_limiter.check_rate_limit(
        key=f"user:{user_id}",
        max_requests=100,
        window_seconds=60
    )

# Rate limit by IP (for auth endpoints)
async def check_ip_rate_limit(ip_address: str) -> bool:
    # 10 login attempts per minute
    return await rate_limiter.check_rate_limit(
        key=f"ip:{ip_address}",
        max_requests=10,
        window_seconds=60
    )

# Middleware
@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    # Skip for certain paths
    if request.url.path in ["/health", "/metrics"]:
        return await call_next(request)
    
    # Get user or IP
    try:
        user = await get_current_user(request)
        key = f"user:{user.id}"
        max_requests = 100
    except:
        key = f"ip:{request.client.host}"
        max_requests = 20  # Lower limit for unauthenticated
    
    # Check rate limit
    if not await rate_limiter.check_rate_limit(key, max_requests, 60):
        return JSONResponse(
            status_code=429,
            content={"error": "Rate limit exceeded"},
            headers={"Retry-After": "60"}
        )
    
    response = await call_next(request)
    
    # Add rate limit headers
    remaining = await rate_limiter.get_remaining(key, max_requests, 60)
    response.headers["X-RateLimit-Limit"] = str(max_requests)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    
    return response
```

---

### Pattern: Cost-Based Rate Limiting (for LLM Calls)

```python
class CostBasedRateLimiter:
    # Token costs per model (input)
    TOKEN_COSTS = {
        "gpt-4": 0.03 / 1000,  # $0.03 per 1K tokens
        "gpt-3.5-turbo": 0.0015 / 1000,
        "claude-3": 0.015 / 1000
    }
    
    async def check_cost_limit(
        self,
        user_id: UUID,
        estimated_tokens: int,
        model: str,
        daily_limit_usd: float = 10.0
    ) -> bool:
        """Check if user has budget for this request"""
        
        # Calculate request cost
        token_cost = self.TOKEN_COSTS.get(model, 0.01 / 1000)
        request_cost = estimated_tokens * token_cost
        
        # Get today's usage
        today = datetime.utcnow().date()
        usage_key = f"usage:{user_id}:{today}"
        
        current_usage = float(await redis.get(usage_key) or 0)
        
        if current_usage + request_cost > daily_limit_usd:
            return False
        
        # Increment usage
        new_usage = current_usage + request_cost
        await redis.set(usage_key, new_usage, ex=86400)  # 24h expiry
        
        return True

cost_limiter = CostBasedRateLimiter()

async def generate_with_cost_check(
    user_id: UUID,
    messages: List[dict],
    model: str
):
    # Estimate input tokens
    estimated_tokens = sum(count_tokens(m["content"]) for m in messages)
    
    # Check budget
    if not await cost_limiter.check_cost_limit(user_id, estimated_tokens, model):
        raise HTTPException(429, "Daily cost limit exceeded")
    
    # Generate response
    response = await llm.generate(messages, model=model)
    
    # Log actual usage
    await log_actual_usage(user_id, response.usage.prompt_tokens, response.usage.completion_tokens, model)
    
    return response
```

---

## Privacy Compliance

### Pattern: GDPR Compliance

```python
class PrivacyCompliance:
    @staticmethod
    async def export_user_data(user_id: UUID) -> dict:
        """Export all user data (GDPR Article 15)"""
        
        # User profile
        user = await db.users.find_one({"id": user_id})
        
        # Chats
        chats = await db.chats.find({"user_id": user_id}).to_list()
        
        # Messages
        messages = await db.messages.find({
            "chat_id": {"$in": [c.id for c in chats]}
        }).to_list()
        
        # Shared knowledge
        knowledge = await db.shared_knowledge.find({
            "source_user_id": user_id
        }).to_list()
        
        # Audit logs
        audit_logs = await db.audit_logs.find({
            "user_id": user_id
        }).to_list()
        
        return {
            "user": user.dict(),
            "chats": [c.dict() for c in chats],
            "messages": [m.dict() for m in messages],
            "shared_knowledge": [k.dict() for k in knowledge],
            "audit_logs": [a.dict() for a in audit_logs]
        }
    
    @staticmethod
    async def delete_user_data(user_id: UUID):
        """Delete all user data (GDPR Article 17 - Right to Erasure)"""
        
        # Get user's chats
        chats = await db.chats.find({"user_id": user_id}).to_list()
        chat_ids = [c.id for c in chats]
        
        # Delete messages
        await db.messages.delete_many({"chat_id": {"$in": chat_ids}})
        
        # Delete memory chunks
        await db.memory_chunks.delete_many({"chat_id": {"$in": chat_ids}})
        
        # Delete chats
        await db.chats.delete_many({"user_id": user_id})
        
        # Delete/anonymize shared knowledge
        await db.shared_knowledge.update_many(
            {"source_user_id": user_id},
            {"$set": {"source_user_id": None, "anonymized": True}}
        )
        
        # Anonymize audit logs (don't delete for compliance)
        await db.audit_logs.update_many(
            {"user_id": user_id},
            {"$set": {"user_id": None, "anonymized": True}}
        )
        
        # Delete user account
        await db.users.delete_one({"id": user_id})
        
        # Log deletion
        await AuditLogger.log(
            action="user_data_deleted",
            details={"deleted_user_id": str(user_id)},
            status="success"
        )
    
    @staticmethod
    async def anonymize_user(user_id: UUID):
        """Anonymize user (alternative to deletion)"""
        
        # Generate anonymous ID
        anon_id = f"anon_{secrets.token_hex(8)}"
        
        # Update user record
        await db.users.update_one(
            {"id": user_id},
            {"$set": {
                "email": f"{anon_id}@anonymized.local",
                "name": "Anonymized User",
                "anonymized": True,
                "anonymized_at": datetime.utcnow()
            }}
        )

# Endpoints
@app.get("/user/export")
async def export_my_data(current_user: User = Depends(get_current_user)):
    """GDPR data export"""
    data = await PrivacyCompliance.export_user_data(current_user.id)
    
    # Return as downloadable JSON
    return JSONResponse(
        content=data,
        headers={
            "Content-Disposition": f"attachment; filename=user_data_{current_user.id}.json"
        }
    )

@app.delete("/user")
async def delete_my_account(
    confirm: str,
    current_user: User = Depends(get_current_user)
):
    """GDPR right to erasure"""
    if confirm != "DELETE MY ACCOUNT":
        raise HTTPException(400, "Invalid confirmation")
    
    await PrivacyCompliance.delete_user_data(current_user.id)
    
    return {"message": "Account and all data deleted"}
```

---

## Secure Deployment

### Pattern: Environment-Based Configuration

```python
from pydantic import BaseSettings

class Settings(BaseSettings):
    # App
    environment: str = "development"
    debug: bool = False
    
    # Security
    secret_key: str
    encryption_key: str
    
    # Database
    database_url: str
    redis_url: str
    
    # API Keys
    openai_api_key: str
    
    # Rate Limiting
    max_requests_per_minute: int = 100
    daily_cost_limit_usd: float = 10.0
    
    # CORS
    allowed_origins: List[str] = ["http://localhost:3000"]
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()

# CORS configuration
from fastapi.middleware.cors import CORSMiddleware

if settings.environment == "production":
    # Strict CORS in production
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
else:
    # Permissive CORS in development
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Security headers
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    
    return response
```

---

**End of Security Document**

## Summary Recommendations for Caretaker Agent

1. **Authentication**: Email/password + MFA (TOTP) + OAuth
2. **Authorization**: Row-level security + application checks
3. **Encryption**: At rest (sensitive fields) + in transit (TLS)
4. **Audit**: Comprehensive logging of all sensitive operations
5. **Rate Limiting**: User-based (100/min) + cost-based ($10/day)
6. **Content Moderation**: Prompt injection detection + output filtering
7. **Privacy**: GDPR-compliant data export/deletion
8. **Deployment**: Secure configuration + security headers
