# Context Window Management & Token Budget Strategies

**Research Date:** April 29, 2026  
**Purpose:** Architectural patterns for managing LLM context windows effectively in chat applications

---

## Table of Contents

1. [Context Window Challenges](#context-window-challenges)
2. [Truncation Strategies](#truncation-strategies)
3. [Summarization Approaches](#summarization-approaches)
4. [Semantic Retrieval (RAG)](#semantic-retrieval-rag)
5. [Hybrid Systems](#hybrid-systems)
6. [Token Counting & Budgeting](#token-counting--budgeting)
7. [Compression Techniques](#compression-techniques)
8. [Best Practices](#best-practices)

---

## Context Window Challenges

### The Fundamental Problem

LLMs have **fixed context windows**:
- GPT-3.5: 16K tokens (~12K words)
- GPT-4: 8K / 32K / 128K tokens
- Claude 3: 200K tokens
- Llama 3: 8K tokens (base), 128K (extended)
- Mistral: 32K tokens

**Challenge:** Long conversations **exceed** context window.

### Naive Approach (Breaks)

```python
# DON'T DO THIS - Will eventually fail
def generate_response(chat_id: UUID, user_message: str):
    # Get ALL messages
    messages = db.get_all_messages(chat_id)
    
    # Try to send all
    response = llm.generate(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            *messages,
            {"role": "user", "content": user_message}
        ]
    )
    # ERROR: Context length exceeded!
```

**Problems:**
1. **Hard Limit**: API rejects when exceeding max tokens
2. **Cost**: Longer context = higher API cost
3. **Latency**: More tokens = slower generation
4. **Quality**: Models lose focus with too much context

---

## Truncation Strategies

### Strategy 1: Simple Sliding Window

**Keep only the N most recent messages**

```python
def prepare_context_sliding_window(
    chat_id: UUID,
    max_messages: int = 20
) -> List[dict]:
    # Always include system prompt
    system_message = {"role": "system", "content": SYSTEM_PROMPT}
    
    # Get recent messages
    messages = db.messages.find(
        {"chat_id": chat_id}
    ).sort(
        "created_at", -1
    ).limit(max_messages).to_list()
    
    # Reverse to chronological order
    messages = list(reversed(messages))
    
    return [system_message] + messages
```

**Pros:**
- Simple to implement
- Fast (no computation)
- Predictable behavior

**Cons:**
- **Loses old context** completely
- Can't reference earlier conversations
- No semantic understanding

**When to Use:** Simple chatbots with short-term memory needs

---

### Strategy 2: Token-Based Truncation

**Keep messages up to a token budget**

```python
import tiktoken

def count_tokens(text: str, model: str = "gpt-4") -> int:
    encoding = tiktoken.encoding_for_model(model)
    return len(encoding.encode(text))

def prepare_context_token_budget(
    chat_id: UUID,
    max_tokens: int = 6000,  # Leave room for response
    model: str = "gpt-4"
) -> List[dict]:
    system_message = {"role": "system", "content": SYSTEM_PROMPT}
    system_tokens = count_tokens(SYSTEM_PROMPT, model)
    
    remaining_tokens = max_tokens - system_tokens
    
    # Get messages in reverse order (newest first)
    all_messages = db.messages.find(
        {"chat_id": chat_id}
    ).sort("created_at", -1).to_list()
    
    selected_messages = []
    current_tokens = 0
    
    for msg in all_messages:
        msg_tokens = count_tokens(msg.content, model)
        
        if current_tokens + msg_tokens > remaining_tokens:
            break
        
        selected_messages.insert(0, msg)  # Insert at beginning
        current_tokens += msg_tokens
    
    return [system_message] + selected_messages
```

**Pros:**
- Accurate to actual API limits
- Maximizes context usage
- Works across different models

**Cons:**
- Token counting overhead
- Still loses old context
- May cut mid-conversation

**When to Use:** Production systems with known token limits

---

### Strategy 3: Important Message Pinning

**Keep system messages and pinned important messages**

```python
class Message(BaseModel):
    id: UUID
    chat_id: UUID
    role: str
    content: str
    pinned: bool = False  # NEW
    created_at: datetime

def prepare_context_with_pinning(
    chat_id: UUID,
    max_tokens: int = 6000
) -> List[dict]:
    system_message = {"role": "system", "content": SYSTEM_PROMPT}
    
    # Always include pinned messages
    pinned_messages = db.messages.find({
        "chat_id": chat_id,
        "pinned": True
    }).sort("created_at").to_list()
    
    # Calculate remaining budget
    used_tokens = count_tokens(SYSTEM_PROMPT)
    for msg in pinned_messages:
        used_tokens += count_tokens(msg.content)
    
    remaining_tokens = max_tokens - used_tokens
    
    # Fill with recent messages
    recent_messages = db.messages.find({
        "chat_id": chat_id,
        "pinned": False
    }).sort("created_at", -1).to_list()
    
    selected_recent = []
    for msg in recent_messages:
        msg_tokens = count_tokens(msg.content)
        if used_tokens + msg_tokens > max_tokens:
            break
        selected_recent.insert(0, msg)
        used_tokens += msg_tokens
    
    # Merge: system + pinned + recent
    return [system_message] + pinned_messages + selected_recent
```

**Pros:**
- Preserves important context
- User control over what's kept
- Good for character definitions, rules

**Cons:**
- Manual pinning required
- Pinned messages can fill budget
- Still loses unpinned history

**When to Use:** Roleplay/character chats with important definitions

---

## Summarization Approaches

### Strategy 4: Recursive Summarization

**Summarize old messages to save tokens**

```python
async def summarize_old_messages(
    chat_id: UUID,
    message_count: int = 20
) -> str:
    """Summarize old messages into a compact summary"""
    
    old_messages = db.messages.find({
        "chat_id": chat_id
    }).sort("created_at").limit(message_count).to_list()
    
    if not old_messages:
        return ""
    
    # Build conversation text
    conversation = "\n".join([
        f"{msg.role}: {msg.content}"
        for msg in old_messages
    ])
    
    # Ask LLM to summarize
    summary = await llm.generate(
        messages=[{
            "role": "system",
            "content": "Summarize the following conversation concisely, preserving key facts, decisions, and context:"
        }, {
            "role": "user",
            "content": conversation
        }],
        max_tokens=500  # Limit summary length
    )
    
    return summary.content

def prepare_context_with_summary(
    chat_id: UUID,
    recent_count: int = 20,
    max_tokens: int = 6000
) -> List[dict]:
    # Get recent messages
    recent_messages = db.messages.find({
        "chat_id": chat_id
    }).sort("created_at", -1).limit(recent_count).to_list()
    
    recent_messages = list(reversed(recent_messages))
    
    # Count tokens in recent messages
    recent_tokens = sum(count_tokens(m.content) for m in recent_messages)
    
    # If recent messages fit, check if we can add summary
    if recent_tokens < max_tokens * 0.7:  # Leave 30% for summary
        # Get or generate summary of older messages
        summary = await get_or_create_summary(chat_id, recent_count)
        
        if summary:
            return [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "system", "content": f"[Summary of earlier conversation]\n{summary}"},
                *recent_messages
            ]
    
    # Just return recent if no room for summary
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        *recent_messages
    ]

async def get_or_create_summary(chat_id: UUID, recent_count: int) -> str:
    """Get cached summary or generate new one"""
    
    # Check cache
    cached = await redis.get(f"summary:{chat_id}")
    if cached:
        return cached
    
    # Generate summary
    summary = await summarize_old_messages(chat_id, recent_count)
    
    # Cache for 1 hour
    await redis.setex(f"summary:{chat_id}", 3600, summary)
    
    return summary
```

**Pros:**
- Preserves old context in compressed form
- Automatic (no user action)
- Reduces token usage significantly

**Cons:**
- Summary generation cost & latency
- Information loss (details compressed out)
- Summary quality depends on model

**When to Use:** Long-running conversations where early context matters

---

### Strategy 5: Hierarchical Summarization

**Summarize in chunks, then summarize summaries**

```python
class ConversationSummary(BaseModel):
    id: UUID
    chat_id: UUID
    level: int  # 0 = messages, 1 = level-0 summaries, etc.
    content: str
    message_range: tuple  # (start_index, end_index)
    token_count: int
    created_at: datetime

async def create_hierarchical_summaries(chat_id: UUID):
    """Create multi-level summaries for long conversations"""
    
    # Level 0: Summarize every 50 messages
    total_messages = await db.messages.count({"chat_id": chat_id})
    
    for i in range(0, total_messages, 50):
        messages = db.messages.find({
            "chat_id": chat_id
        }).skip(i).limit(50).to_list()
        
        summary = await summarize_messages(messages)
        
        await db.summaries.insert_one({
            "id": uuid4(),
            "chat_id": chat_id,
            "level": 0,
            "content": summary,
            "message_range": (i, i + 50),
            "token_count": count_tokens(summary),
            "created_at": datetime.now()
        })
    
    # Level 1: Summarize every 10 level-0 summaries
    level_0_summaries = db.summaries.find({
        "chat_id": chat_id,
        "level": 0
    }).to_list()
    
    for i in range(0, len(level_0_summaries), 10):
        chunk = level_0_summaries[i:i+10]
        combined_text = "\n\n".join([s.content for s in chunk])
        
        summary = await summarize_text(combined_text)
        
        await db.summaries.insert_one({
            "id": uuid4(),
            "chat_id": chat_id,
            "level": 1,
            "content": summary,
            "message_range": (chunk[0].message_range[0], chunk[-1].message_range[1]),
            "token_count": count_tokens(summary),
            "created_at": datetime.now()
        })

def prepare_context_hierarchical(
    chat_id: UUID,
    max_tokens: int = 6000
) -> List[dict]:
    """Build context with hierarchical summaries"""
    
    # Start with system prompt
    context = [{"role": "system", "content": SYSTEM_PROMPT}]
    used_tokens = count_tokens(SYSTEM_PROMPT)
    
    # Add highest-level summary first (most compressed)
    high_level = db.summaries.find_one({
        "chat_id": chat_id,
        "level": {"$gt": 0}
    }).sort("level", -1)
    
    if high_level:
        context.append({
            "role": "system",
            "content": f"[Earlier conversation summary]\n{high_level.content}"
        })
        used_tokens += high_level.token_count
    
    # Add recent messages
    recent = db.messages.find({
        "chat_id": chat_id
    }).sort("created_at", -1).to_list()
    
    for msg in reversed(recent):
        msg_tokens = count_tokens(msg.content)
        if used_tokens + msg_tokens > max_tokens:
            break
        context.append(msg.to_dict())
        used_tokens += msg_tokens
    
    return context
```

**Pros:**
- Extreme compression for very long conversations
- Preserves high-level narrative
- Logarithmic storage growth

**Cons:**
- Complex to implement
- Significant preprocessing cost
- Hard to update incrementally

**When to Use:** Very long conversations (1000+ messages), storytelling, campaigns

---

## Semantic Retrieval (RAG)

### Strategy 6: Embedding-Based Retrieval

**Search for relevant messages using semantic similarity**

```python
class EmbeddingRetriever:
    def __init__(self, embedding_model: str = "text-embedding-3-small"):
        self.model = embedding_model
    
    async def embed_text(self, text: str) -> List[float]:
        """Generate embedding for text"""
        response = await openai.embeddings.create(
            model=self.model,
            input=text
        )
        return response.data[0].embedding
    
    async def index_messages(self, chat_id: UUID):
        """Generate embeddings for all messages"""
        messages = db.messages.find({"chat_id": chat_id}).to_list()
        
        for msg in messages:
            if msg.embedding is None:  # Not already embedded
                embedding = await self.embed_text(msg.content)
                
                await db.messages.update_one(
                    {"id": msg.id},
                    {"$set": {"embedding": embedding}}
                )
    
    async def retrieve_relevant_messages(
        self,
        chat_id: UUID,
        query: str,
        top_k: int = 5,
        exclude_recent: int = 10
    ) -> List[Message]:
        """Find most relevant messages to query"""
        
        # Embed query
        query_embedding = await self.embed_text(query)
        
        # Get recent message IDs to exclude
        recent_messages = db.messages.find({
            "chat_id": chat_id
        }).sort("created_at", -1).limit(exclude_recent).to_list()
        
        recent_ids = [m.id for m in recent_messages]
        
        # Semantic search (using pgvector)
        relevant = await db.execute_query("""
            SELECT id, chat_id, role, content, created_at,
                   1 - (embedding <=> %(query_embedding)s::vector) as similarity
            FROM messages
            WHERE chat_id = %(chat_id)s
              AND id NOT IN %(exclude_ids)s
            ORDER BY similarity DESC
            LIMIT %(top_k)s
        """, {
            "query_embedding": query_embedding,
            "chat_id": chat_id,
            "exclude_ids": tuple(recent_ids),
            "top_k": top_k
        })
        
        return relevant

retriever = EmbeddingRetriever()

async def prepare_context_with_rag(
    chat_id: UUID,
    user_message: str,
    max_tokens: int = 6000
) -> List[dict]:
    """Build context with semantic retrieval"""
    
    # System prompt
    context = [{"role": "system", "content": SYSTEM_PROMPT}]
    used_tokens = count_tokens(SYSTEM_PROMPT)
    
    # Retrieve relevant messages from history
    relevant_messages = await retriever.retrieve_relevant_messages(
        chat_id=chat_id,
        query=user_message,
        top_k=5
    )
    
    # Add relevant messages as context
    if relevant_messages:
        context_text = "\n\n".join([
            f"[From earlier conversation]\n{msg.role}: {msg.content}"
            for msg in relevant_messages
        ])
        
        context.append({
            "role": "system",
            "content": context_text
        })
        
        used_tokens += count_tokens(context_text)
    
    # Add recent messages
    recent_messages = db.messages.find({
        "chat_id": chat_id
    }).sort("created_at", -1).to_list()
    
    for msg in reversed(recent_messages):
        msg_tokens = count_tokens(msg.content)
        if used_tokens + msg_tokens > max_tokens:
            break
        context.append(msg.to_dict())
        used_tokens += msg_tokens
    
    return context
```

**Pros:**
- **Intelligent context selection**
- Finds relevant info from any point in history
- Better than simple truncation

**Cons:**
- Requires embeddings (cost/latency)
- Needs vector database
- Can miss chronological context

**When to Use:** Knowledge-heavy conversations, Q&A, information retrieval

---

## Hybrid Systems

### Strategy 7: Combined Approach (RECOMMENDED)

**Combine truncation, summarization, and RAG for best results**

```python
class HybridContextManager:
    def __init__(
        self,
        max_tokens: int = 6000,
        recent_message_count: int = 20,
        rag_top_k: int = 3
    ):
        self.max_tokens = max_tokens
        self.recent_message_count = recent_message_count
        self.rag_top_k = rag_top_k
        self.retriever = EmbeddingRetriever()
    
    async def prepare_context(
        self,
        chat_id: UUID,
        user_message: str
    ) -> List[dict]:
        """
        Build optimal context using:
        1. System prompt (always)
        2. Summary of old messages (if available)
        3. RAG-retrieved relevant messages
        4. Recent messages (sliding window)
        """
        
        context = []
        used_tokens = 0
        
        # 1. System prompt
        system_prompt = await self.get_system_prompt(chat_id)
        context.append({"role": "system", "content": system_prompt})
        used_tokens += count_tokens(system_prompt)
        
        # 2. Summary of old messages (if conversation is long)
        message_count = await db.messages.count({"chat_id": chat_id})
        
        if message_count > 50:
            summary = await self.get_or_create_summary(
                chat_id,
                exclude_recent=self.recent_message_count
            )
            
            if summary:
                summary_text = f"[Summary of earlier conversation]\n{summary}"
                summary_tokens = count_tokens(summary_text)
                
                if used_tokens + summary_tokens < self.max_tokens * 0.3:
                    context.append({"role": "system", "content": summary_text})
                    used_tokens += summary_tokens
        
        # 3. RAG: Retrieve relevant messages
        relevant_messages = await self.retriever.retrieve_relevant_messages(
            chat_id=chat_id,
            query=user_message,
            top_k=self.rag_top_k,
            exclude_recent=self.recent_message_count
        )
        
        if relevant_messages:
            relevant_text = "\n\n".join([
                f"[Relevant from earlier conversation - {msg.created_at.strftime('%Y-%m-%d')}]\n{msg.role}: {msg.content}"
                for msg in relevant_messages
            ])
            
            relevant_tokens = count_tokens(relevant_text)
            
            if used_tokens + relevant_tokens < self.max_tokens * 0.5:
                context.append({"role": "system", "content": relevant_text})
                used_tokens += relevant_tokens
        
        # 4. Recent messages (up to remaining budget)
        recent_messages = db.messages.find({
            "chat_id": chat_id
        }).sort("created_at", -1).limit(self.recent_message_count * 2).to_list()
        
        # Add from oldest to newest (up to budget)
        selected_recent = []
        for msg in reversed(recent_messages):
            msg_tokens = count_tokens(msg.content)
            if used_tokens + msg_tokens > self.max_tokens * 0.95:  # Leave 5% buffer
                break
            selected_recent.append(msg.to_dict())
            used_tokens += msg_tokens
        
        context.extend(selected_recent)
        
        return context
    
    async def get_system_prompt(self, chat_id: UUID) -> str:
        """Get chat-specific system prompt with dynamic elements"""
        chat = await db.chats.find_one({"id": chat_id})
        
        base_prompt = chat.system_prompt or DEFAULT_SYSTEM_PROMPT
        
        # Add dynamic elements (e.g., current date/time)
        dynamic_info = f"\nCurrent date/time: {datetime.now().strftime('%Y-%m-%d %H:%M')}"
        
        return base_prompt + dynamic_info
    
    async def get_or_create_summary(
        self,
        chat_id: UUID,
        exclude_recent: int
    ) -> str:
        """Get cached summary or generate new one"""
        
        # Check if we have a recent summary
        cached = await redis.get(f"summary:{chat_id}")
        if cached:
            return cached
        
        # Generate new summary
        old_messages = db.messages.find({
            "chat_id": chat_id
        }).sort("created_at").skip(exclude_recent).to_list()
        
        if not old_messages:
            return ""
        
        summary = await summarize_messages(old_messages[:100])  # Summarize up to 100 old messages
        
        # Cache for 1 hour
        await redis.setex(f"summary:{chat_id}", 3600, summary)
        
        return summary

# Usage
context_manager = HybridContextManager(
    max_tokens=6000,
    recent_message_count=20,
    rag_top_k=3
)

async def generate_response(chat_id: UUID, user_message: str):
    # Prepare optimal context
    context = await context_manager.prepare_context(chat_id, user_message)
    
    # Add current user message
    context.append({"role": "user", "content": user_message})
    
    # Generate response
    response = await llm.generate(messages=context)
    
    return response
```

**Pros:**
- **Best of all worlds**
- Adapts to conversation length
- Maximizes relevant context
- Production-ready

**Cons:**
- Complex to implement
- Requires multiple systems (embeddings, cache)
- Higher initial cost

**When to Use:** Production caretaker agent (RECOMMENDED)

---

## Token Counting & Budgeting

### Accurate Token Counting

```python
import tiktoken

# Model-specific encodings
ENCODINGS = {
    "gpt-4": "cl100k_base",
    "gpt-3.5-turbo": "cl100k_base",
    "claude-3": "cl100k_base",  # Approximate
    "llama-3": "cl100k_base",  # Approximate
}

def count_tokens(text: str, model: str = "gpt-4") -> int:
    """Accurately count tokens for a model"""
    encoding_name = ENCODINGS.get(model, "cl100k_base")
    encoding = tiktoken.get_encoding(encoding_name)
    return len(encoding.encode(text))

def count_messages_tokens(messages: List[dict], model: str = "gpt-4") -> int:
    """Count tokens for entire message array (including formatting)"""
    encoding = tiktoken.encoding_for_model(model)
    
    tokens = 0
    
    for message in messages:
        # Message formatting tokens (OpenAI format)
        tokens += 4  # Every message has 4 tokens for role/formatting
        
        for key, value in message.items():
            tokens += len(encoding.encode(str(value)))
            
            if key == "name":
                tokens += -1  # Role is always 1 token less if there's a name
    
    tokens += 2  # Every reply is primed with <im_start>assistant
    
    return tokens

### Dynamic Budget Allocation

```python
class TokenBudgetAllocator:
    def __init__(self, model: str = "gpt-4", context_window: int = 8000):
        self.model = model
        self.context_window = context_window
    
    def allocate_budget(self) -> dict:
        """
        Allocate token budget across different context components
        
        Returns allocation strategy:
        - system_prompt: 10% (fixed instructions)
        - summary: 15% (compressed old context)
        - rag: 15% (retrieved relevant messages)
        - recent: 50% (recent conversation)
        - buffer: 10% (safety margin + response)
        """
        return {
            "system_prompt": int(self.context_window * 0.10),
            "summary": int(self.context_window * 0.15),
            "rag": int(self.context_window * 0.15),
            "recent": int(self.context_window * 0.50),
            "buffer": int(self.context_window * 0.10)
        }
    
    def adjust_for_available_budget(
        self,
        current_tokens: int,
        component: str
    ) -> int:
        """Dynamically adjust budget if a component doesn't use its full allocation"""
        budget = self.allocate_budget()
        allocated = budget[component]
        used = current_tokens
        
        if used < allocated:
            # Redistribute unused tokens to 'recent' messages
            return allocated - used
        
        return 0
```

---

## Compression Techniques

### Technique 1: Message Coalescing

**Merge consecutive messages from same role**

```python
def coalesce_messages(messages: List[dict]) -> List[dict]:
    """Merge consecutive messages from the same role"""
    if not messages:
        return []
    
    coalesced = [messages[0].copy()]
    
    for msg in messages[1:]:
        if msg["role"] == coalesced[-1]["role"]:
            # Same role - merge content
            coalesced[-1]["content"] += "\n\n" + msg["content"]
        else:
            # Different role - add new message
            coalesced.append(msg.copy())
    
    return coalesced
```

**Token Savings:** 5-15% (reduced message formatting overhead)

---

### Technique 2: Remove Redundant Formatting

```python
def strip_formatting(text: str) -> str:
    """Remove redundant whitespace and formatting"""
    import re
    
    # Remove multiple newlines
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    # Remove trailing whitespace
    text = '\n'.join(line.rstrip() for line in text.split('\n'))
    
    # Remove multiple spaces
    text = re.sub(r' {2,}', ' ', text)
    
    return text.strip()
```

**Token Savings:** 3-8%

---

### Technique 3: Abbreviate System Instructions

```python
# Long version (100 tokens)
SYSTEM_PROMPT_LONG = """
You are a helpful and friendly AI assistant. You should:
- Always be polite and respectful
- Provide accurate and helpful information
- Ask clarifying questions when needed
- Admit when you don't know something
- Keep responses concise and relevant
"""

# Compressed version (40 tokens)
SYSTEM_PROMPT_COMPRESSED = """
Helpful AI assistant. Be polite, accurate, concise. Ask questions if unclear. Admit uncertainty.
"""
```

**Token Savings:** 60%+ for system prompts

---

## Best Practices

### 1. Always Leave Buffer for Response

```python
# Reserve tokens for model response
RESPONSE_BUFFER = 1000  # Typical response length

max_context_tokens = context_window - RESPONSE_BUFFER
```

### 2. Monitor Token Usage

```python
class TokenUsageTracker:
    async def log_usage(
        self,
        chat_id: UUID,
        prompt_tokens: int,
        completion_tokens: int,
        model: str
    ):
        await db.token_usage.insert_one({
            "chat_id": chat_id,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
            "model": model,
            "timestamp": datetime.now()
        })
    
    async def get_usage_stats(self, chat_id: UUID) -> dict:
        pipeline = [
            {"$match": {"chat_id": chat_id}},
            {"$group": {
                "_id": None,
                "total_prompts": {"$sum": "$prompt_tokens"},
                "total_completions": {"$sum": "$completion_tokens"},
                "total": {"$sum": "$total_tokens"}
            }}
        ]
        
        result = await db.token_usage.aggregate(pipeline).to_list()
        return result[0] if result else {}
```

### 3. Progressive Context Reduction

```python
async def generate_with_fallback(
    chat_id: UUID,
    user_message: str,
    max_retries: int = 3
) -> str:
    """Try generating with progressively smaller context if needed"""
    
    recent_counts = [30, 20, 10]  # Try with different context sizes
    
    for i, recent_count in enumerate(recent_counts):
        try:
            context = await prepare_context(
                chat_id=chat_id,
                recent_message_count=recent_count
            )
            
            response = await llm.generate(messages=context)
            return response
        
        except ContextLengthExceeded as e:
            if i == len(recent_counts) - 1:
                raise  # Last attempt failed
            continue  # Try with smaller context
```

### 4. Cache Expensive Operations

```python
# Cache embeddings
@lru_cache(maxsize=1000)
def get_cached_embedding(text: str) -> List[float]:
    return embed_text(text)

# Cache summaries
async def get_cached_summary(chat_id: UUID) -> str:
    return await redis.get(f"summary:{chat_id}")
```

---

## Recommended Strategy for Caretaker Agent

```python
class CaretakerContextManager(HybridContextManager):
    """
    Specialized context manager for caretaker agent
    with cross-user message relay support
    """
    
    async def prepare_context(
        self,
        chat_id: UUID,
        user_id: UUID,
        user_message: str
    ) -> List[dict]:
        # Standard hybrid context
        context = await super().prepare_context(chat_id, user_message)
        
        # Add pending relay messages/tasks for this user
        pending_tasks = await db.shared_knowledge.find({
            "category": "task",
            "visibility_target_ids": {"$in": [user_id]},
            "status": "pending"
        }).sort("priority", -1).to_list()
        
        if pending_tasks:
            task_text = "\n".join([
                f"- {task.content}"
                for task in pending_tasks[:5]  # Limit to 5 most important
            ])
            
            context.insert(1, {  # Insert after system prompt
                "role": "system",
                "content": f"[Pending notifications for user]\n{task_text}"
            })
        
        return context
```

---

**End of Context Window Management Document**
