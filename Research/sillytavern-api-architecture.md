# SillyTavern API Compatibility Architecture

## 1. Overview & Supported Providers

SillyTavern is a front-end interface that provides API compatibility with multiple LLM backends through an abstraction layer. The system supports two primary API paradigms:

**Chat Completions API** (OpenAI-compatible):
- OpenAI (official)
- Claude (Anthropic)
- OpenRouter (proxy/aggregator)
- Google MakerSuite / Vertex AI
- MistralAI
- AI21
- Cohere
- Perplexity
- Groq
- DeepSeek
- XAI (x.ai)
- Chutes
- ElectronHub
- NanoGPT
- AI/ML API
- Moonshot
- Fireworks
- Z.AI
- SiliconFlow
- Pollinations
- Azure OpenAI

**Text Completions API** (legacy/alternative):
- KoboldAI / KoboldCpp
- Text Generation WebUI (oobabooga)
- llama.cpp
- TabbyAPI
- Ollama
- vLLM
- Aphrodite
- Together AI
- InfermaticAI
- DreamGen
- Mancer
- Featherless
- Hugging Face Inference
- OpenRouter (text mode)

### High-Level Architecture Approach

SillyTavern acts as a **universal adapter** between its frontend interface and various LLM backends. The architecture uses:

1. **Route-based dispatch**: Express.js routers separate concerns by API type
2. **Provider-specific handlers**: Individual functions handle each provider's unique requirements
3. **Format conversion**: Transforms between SillyTavern's internal format and provider-specific formats
4. **OpenAI standardization**: Most providers attempt to follow OpenAI's API format with extensions
5. **Secrets management**: Centralized API key storage and retrieval
6. **Streaming support**: Server-sent events (SSE) for real-time response streaming

---

## 2. API Abstraction Layer

### Router/Dispatcher Implementation

The main routing infrastructure is established in **`src/server-startup.js`**:

```javascript
export function setupPrivateEndpoints(app) {
    app.use('/', userDataRouter);
    app.use('/api/users', usersPrivateRouter);
    app.use('/api/users', usersAdminRouter);
    app.use('/api/moving-ui', movingUIRouter);
    app.use('/api/images', imagesRouter);
    app.use('/api/quick-replies', quickRepliesRouter);
    app.use('/api/avatars', avatarsRouter);
    app.use('/api/themes', themesRouter);
    app.use('/api/openai', openAiRouter);
    app.use('/api/google', googleRouter);
    app.use('/api/anthropic', anthropicRouter);
    app.use('/api/tokenizers', tokenizersRouter);
    app.use('/api/presets', presetsRouter);
    app.use('/api/secrets', secretsRouter);
    app.use('/thumbnail', thumbnailRouter);
    app.use('/api/novelai', novelAiRouter);
    app.use('/api/extensions', extensionsRouter);
    app.use('/api/assets', assetsRouter);
    app.use('/api/files', filesRouter);
    app.use('/api/characters', charactersRouter);
    app.use('/api/chats', chatsRouter);
    app.use('/api/groups', groupsRouter);
    app.use('/api/worldinfo', worldInfoRouter);
    app.use('/api/stats', statsRouter);
    app.use('/api/backgrounds', backgroundsRouter);
    app.use('/api/sprites', spritesRouter);
    app.use('/api/content', contentManagerRouter);
    app.use('/api/settings', settingsRouter);
    app.use('/api/sd', stableDiffusionRouter);
    app.use('/api/horde', hordeRouter);
    app.use('/api/vector', vectorsRouter);
    app.use('/api/translate', translateRouter);
    app.use('/api/extra/classify', classifyRouter);
    app.use('/api/extra/caption', captionRouter);
    app.use('/api/search', searchRouter);
    app.use('/api/backends/text-completions', textCompletionsRouter);
    app.use('/api/openrouter', openRouterRouter);
    app.use('/api/backends/kobold', koboldRouter);
    app.use('/api/backends/chat-completions', chatCompletionsRouter);
    app.use('/api/speech', speechRouter);
    app.use('/api/azure', azureRouter);
    app.use('/api/volcengine', volcengineRouter);
    app.use('/api/minimax', minimaxRouter);
    app.use('/api/data-maid', dataMaidRouter);
    app.use('/api/backups', backupsRouter);
    app.use('/api/image-metadata', imageMetadataRouter);
}
```

### File Structure

**Backend Core Files:**

```
src/endpoints/
├── backends/
│   ├── chat-completions.js    # Chat completion providers (2600+ lines)
│   ├── text-completions.js    # Text completion providers (646+ lines)
│   └── kobold.js               # KoboldAI-specific handling
├── openai.js                   # OpenAI-specific endpoints (image gen, etc.)
├── anthropic.js                # Claude-specific extensions
├── google.js                   # Google AI / Vertex AI
├── openrouter.js               # OpenRouter extensions
├── novelai.js                  # NovelAI implementation
└── secrets.js                  # API key management
```

### Chat Completions Router

The primary routing logic in **`src/endpoints/backends/chat-completions.js`**:

```javascript
router.post('/generate', async function (request, response) {
    try {
        if (!request.body) return response.status(400).send({ error: true });

        const postProcessingType = request.body.custom_prompt_post_processing;
        if (Array.isArray(request.body.messages) && postProcessingType) {
            console.info('Applying custom prompt post-processing of type', postProcessingType);
            request.body.messages = postProcessPrompt(
                request.body.messages,
                postProcessingType,
                getPromptNames(request));
        }

        if (request.body.json_schema?.value) {
            request.body.json_schema.value = flattenSchema(request.body.json_schema.value, request.body.chat_completion_source);
        }

        switch (request.body.chat_completion_source) {
            case CHAT_COMPLETION_SOURCES.CLAUDE: 
                return await sendClaudeRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AI21: 
                return await sendAI21Request(request, response);
            case CHAT_COMPLETION_SOURCES.MAKERSUITE: 
                return await sendMakerSuiteRequest(request, response);
            case CHAT_COMPLETION_SOURCES.VERTEXAI: 
                return await sendMakerSuiteRequest(request, response);
            case CHAT_COMPLETION_SOURCES.MISTRALAI: 
                return await sendMistralAIRequest(request, response);
            case CHAT_COMPLETION_SOURCES.COHERE: 
                return await sendCohereRequest(request, response);
            case CHAT_COMPLETION_SOURCES.DEEPSEEK: 
                return await sendDeepSeekRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AIMLAPI: 
                return await sendAimlapiRequest(request, response);
            case CHAT_COMPLETION_SOURCES.XAI: 
                return await sendXaiRequest(request, response);
            case CHAT_COMPLETION_SOURCES.CHUTES: 
                return await sendChutesRequest(request, response);
            case CHAT_COMPLETION_SOURCES.ELECTRONHUB: 
                return await sendElectronHubRequest(request, response);
            case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: 
                return await sendAzureOpenAIRequest(request, response);
        }

        // Default OpenAI-compatible handling continues below...
```

### Text Completions Router

**`src/endpoints/backends/text-completions.js`** handles legacy/text-based providers:

```javascript
router.post('/generate', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    try {
        if (request.body.api_server.indexOf('localhost') !== -1) {
            request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
        }

        const apiType = request.body.api_type;
        const baseUrl = request.body.api_server;
        console.debug(request.body);

        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', async function () {
            if (request.body.api_type === TEXTGEN_TYPES.KOBOLDCPP && !response.writableEnded) {
                await abortKoboldCppRequest(request, trimV1(baseUrl));
            }
            controller.abort();
        });

        let url = trimV1(baseUrl);

        switch (request.body.api_type) {
            case TEXTGEN_TYPES.GENERIC:
            case TEXTGEN_TYPES.VLLM:
            case TEXTGEN_TYPES.FEATHERLESS:
            case TEXTGEN_TYPES.APHRODITE:
            case TEXTGEN_TYPES.OOBA:
            case TEXTGEN_TYPES.TABBY:
            case TEXTGEN_TYPES.KOBOLDCPP:
            case TEXTGEN_TYPES.TOGETHERAI:
            case TEXTGEN_TYPES.INFERMATICAI:
            case TEXTGEN_TYPES.HUGGINGFACE:
                url += '/v1/completions';
                break;
            case TEXTGEN_TYPES.DREAMGEN:
                url += '/api/openai/v1/completions';
                break;
            case TEXTGEN_TYPES.MANCER:
                url += '/oai/v1/completions';
                break;
            case TEXTGEN_TYPES.LLAMACPP:
                url += '/completion';
                break;
            case TEXTGEN_TYPES.OLLAMA:
                url += '/api/generate';
                break;
            case TEXTGEN_TYPES.OPENROUTER:
                url += '/v1/chat/completions';
                break;
        }
        // ... request processing continues
    }
});
```

---

## 3. Provider Implementations

### OpenAI (Reference Implementation)

OpenAI serves as the **baseline format** that most other providers attempt to emulate:

``````javascript
// filepath: src/endpoints/backends/chat-completions.js (lines 2042-2100)

// Default OpenAI-compatible handling
let apiUrl;
let apiKey;
let headers;
let bodyParams;
const isTextCompletion = Boolean(request.body.model && TEXT_COMPLETION_MODELS.includes(request.body.model)) 
    || typeof request.body.messages === 'string';

if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
    apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString();
    apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.OPENAI);
    headers = {};
    bodyParams = {
        logprobs: request.body.logprobs,
        top_logprobs: undefined,
    };
    
    // Handle o1/o3 reasoning models
    if (OPENAI_REASONING_EFFORT_MODELS.some(model => request.body.model.startsWith(model))) {
        bodyParams.reasoning_effort = OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] || undefined;
    }
    
    // Handle o4 verbosity models
    if (OPENAI_VERBOSITY_MODELS.some(model => request.body.model.startsWith(model))) {
        bodyParams.verbosity = request.body.verbosity;
    }
    
    if (request.body.logprobs > 0) {
        bodyParams.top_logprobs = request.body.logprobs;
        bodyParams.logprobs = true;
    }
}
```

**Request Format (Standard OpenAI):**

```javascript
{
    model: "gpt-4",
    messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello!" }
    ],
    temperature: 0.7,
    max_tokens: 150,
    stream: false,
    top_p: 1.0,
    frequency_penalty: 0,
    presence_penalty: 0,
    logprobs: false,
    tools: [],  // Optional function calling
    response_format: { type: "json_object" }  // Optional JSON mode
}
```

**Response Parsing:**

```javascript
// Standard OpenAI response structure
{
    id: "chatcmpl-xxx",
    object: "chat.completion",
    created: 1677652288,
    model: "gpt-4",
    choices: [{
        index: 0,
        message: {
            role: "assistant",
            content: "Hello! How can I help you today?"
        },
        finish_reason: "stop"
    }],
    usage: {
        prompt_tokens: 13,
        completion_tokens: 9,
        total_tokens: 22
    }
}
```

### Claude (Anthropic)

Claude requires significant format conversion due to its unique API structure:

```javascript
async function sendClaudeRequest(request, response) {
    const apiUrl = new URL(request.body.reverse_proxy || API_CLAUDE).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.CLAUDE);
    
    if (!apiKey) {
        console.warn(color.red(`Claude API key is missing.`));
        return response.status(400).send({ error: true });
    }

    try {
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            controller.abort();
        });
        
        const additionalHeaders = {};
        const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
        
        // Detect model capabilities
        const useTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
        const useSystemPrompt = Boolean(request.body.use_sysprompt);
        const useThinking = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(request.body.model);
        const useWebSearch = /^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(request.body.model) && Boolean(request.body.enable_web_search);
        const isLimitedSampling = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(request.body.model);
        const useVerbosity = /^claude-(opus-4-5|opus-4-6|sonnet-4-6)/.test(request.body.model);
        
        // Convert messages to Claude format
        const convertedPrompt = convertClaudeMessages(
            request.body.messages, 
            request.body.assistant_prefill, 
            useSystemPrompt, 
            useTools, 
            getPromptNames(request)
        );
        
        // Build request body
        let requestBody = {
            model: request.body.model,
            max_tokens: request.body.max_tokens,
            stream: request.body.stream,
            temperature: request.body.temperature,
            top_p: request.body.top_p,
            top_k: request.body.top_k,
            messages: convertedPrompt.messages,
        };
        
        // Add system prompt if present
        if (convertedPrompt.systemPrompt && convertedPrompt.systemPrompt.length > 0) {
            requestBody.system = convertedPrompt.systemPrompt;
        }
        
        // Handle tools/function calling
        if (useTools && !request.body.json_schema) {
            requestBody.tools = request.body.tools
                .filter(tool => tool && typeof tool === 'object')
                .map(fn => ({ 
                    name: fn.name, 
                    description: fn.description, 
                    input_schema: flattenSchema(fn.parameters, request.body.chat_completion_source) 
                }));
        }
        
        // Structured output via forced tool
        if (request.body.json_schema) {
            const jsonTool = {
                name: request.body.json_schema.name,
                description: request.body.json_schema.description || 'Well-formed JSON object',
                input_schema: request.body.json_schema.value,
            };
            requestBody.tools = [...(requestBody.tools || []), jsonTool];
            requestBody.tool_choice = { type: 'tool', name: request.body.json_schema.name };
        }
        
        // Enable thinking mode for supported models
        if (useThinking && request.body.include_thinking) {
            const budgetTokens = calculateClaudeBudgetTokens(request.body.thinking_budget, request.body.max_tokens);
            const minThinkTokens = 1000;
            
            if (requestBody.max_tokens <= minThinkTokens) {
                const newValue = requestBody.max_tokens + minThinkTokens;
                console.warn(color.yellow(`Claude thinking requires a minimum of ${minThinkTokens} response tokens.`));
                console.info(color.blue(`Increasing response length to ${newValue}.`));
                requestBody.max_tokens = newValue;
            }
            
            requestBody.thinking = {
                type: 'enabled',
                budget_tokens: budgetTokens,
            };
            
            // Thinking mode has strict sampling requirements
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }
        
        // Verbosity control (effort parameter)
        if (useVerbosity && request.body.verbosity && !requestBody.output_config?.effort) {
            betaHeaders.push('effort-2025-11-24');
            requestBody.output_config ??= {};
            requestBody.output_config.effort = request.body.verbosity;
        }
        
        if (betaHeaders.length) {
            additionalHeaders['anthropic-beta'] = betaHeaders.join(',');
        }
        
        console.debug('Claude request:', requestBody);
        
        const generateResponse = await fetch(apiUrl + '/messages', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': apiKey,
                ...additionalHeaders,
            },
        });
        
        if (request.body.stream) {
            forwardFetchResponse(generateResponse, response);
        } else {
            if (!generateResponse.ok) {
                const generateResponseText = await generateResponse.text();
                console.warn(color.red(`Claude API returned error: ${generateResponse.status} ${generateResponse.statusText}\n${generateResponseText}`));
                return response.status(500).send({ error: true });
            }
            
            const generateResponseJson = await generateResponse.json();
            const responseText = generateResponseJson?.content?.[0]?.text || '';
            console.debug('Claude response:', generateResponseJson);
            
            // Wrap to OpenAI format for compatibility
            const reply = { 
                choices: [{ 'message': { 'content': responseText } }], 
                content: generateResponseJson.content 
            };
            return response.send(reply);
        }
    } catch (error) {
        console.error(color.red(`Error communicating with Claude: ${error}`));
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        }
    }
}
```

**Claude Message Format Conversion:**

```javascript
export function convertClaudeMessages(messages, prefillString, useSysPrompt, useTools, names) {
    let systemPrompt = [];
    
    if (useSysPrompt) {
        // Collect system messages from the beginning
        let i;
        for (i = 0; i < messages.length; i++) {
            if (messages[i].role !== 'system') {
                break;
            }
            systemPrompt.push(extractClaudeSystemContent(messages[i]));
        }
        messages.splice(0, i);
    }
    
    // Convert remaining messages to Claude format
    messages = messages.map(msg => {
        const content = [];
        
        if (typeof msg.content === 'string') {
            content.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text') {
                    content.push({ type: 'text', text: part.text });
                } else if (part.type === 'image_url') {
                    content.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: extractMediaType(part.image_url.url),
                            data: extractBase64(part.image_url.url),
                        },
                    });
                }
            }
        }
        
        return {
            role: msg.role,
            content: content,
        };
    });
    
    // Add prefill if specified
    if (prefillString) {
        messages.push({
            role: 'assistant',
            content: [{ type: 'text', text: prefillString.trimEnd() }],
        });
    }
    
    return { messages, systemPrompt };
}
```

### OpenRouter (Aggregator/Proxy)

OpenRouter acts as a proxy/aggregator supporting multiple providers:

```javascript
else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
    apiUrl = API_OPENROUTER;
    apiKey = readSecret(request.user.directories, SECRET_KEYS.OPENROUTER);
    headers = { ...OPENROUTER_HEADERS };
    bodyParams = {};
    
    // OpenRouter-specific features
    if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
        bodyParams.provider = {
            order: request.body.provider,
            allow_fallbacks: request.body.allow_fallbacks ?? true,
            require_parameters: request.body.require_parameters ?? false,
        };
    }
    
    if (Array.isArray(request.body.quantizations) && request.body.quantizations.length > 0) {
        bodyParams.provider ??= {};
        bodyParams.provider.quantizations = request.body.quantizations;
    }
    
    // Transforms (middle-out optimization)
    const transforms = getOpenRouterTransforms(request);
    if (transforms !== undefined) {
        bodyParams.transforms = transforms;
    }
    
    // Plugins (web search, etc.)
    const plugins = getOpenRouterPlugins(request);
    if (plugins.length > 0) {
        bodyParams.plugins = plugins;
    }
    
    // Reasoning models support
    if (request.body.reasoning_effort) {
        bodyParams.reasoning ??= {};
        bodyParams.reasoning.effort = request.body.reasoning_effort;
    }
    
    // Caching support for Claude via OpenRouter
    const isClaude = /^anthropic\/claude/.test(request.body.model);
    if (isClaude && request.body.openrouter_cache_prompts) {
        const cachingAtDepth = parseInt(request.body.cachingAtDepth) || -1;
        const cacheTTL = request.body.cacheTTL || 600;
        
        if (cachingAtDepth !== -1) {
            cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
        }
    }
    
    // Gemini caching via OpenRouter
    const isGemini = /google\/gemini/.test(request.body.model);
    const isCacheableGemini = isGemini && await isOpenRouterModelCacheable(request.body.model);
    const enableGeminiSystemPromptCache = getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');
    
    if (isCacheableGemini && enableGeminiSystemPromptCache) {
        cachingSystemPromptForOpenRouter(request.body.messages);
    }
}
```

**OpenRouter Helper Functions:**

```javascript
function getOpenRouterTransforms(request) {
    switch (request.body.middleout) {
        case 'on':
            return ['middle-out'];
        case 'off':
            return [];
        case 'auto':
            return undefined;
    }
}

function getOpenRouterPlugins(request) {
    const plugins = [];
    
    if (request.body.enable_web_search) {
        plugins.push({ 'id': 'web' });
    }
    
    return plugins;
}
```

### KoboldAI / Text Generation WebUI

Text completion providers use a different API paradigm:

```javascript
// Request body building for different text-gen types
if (request.body.api_type === TEXTGEN_TYPES.GENERIC) {
    request.body = _.pickBy(request.body, (_, key) => OPENAI_KEYS.includes(key));
    if (Array.isArray(request.body.stop)) { 
        request.body.stop = request.body.stop.slice(0, 4); 
    }
    args.body = JSON.stringify(request.body);
}

if (request.body.api_type === TEXTGEN_TYPES.OPENROUTER) {
    if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
        request.body.provider = {
            allow_fallbacks: request.body.allow_fallbacks ?? true,
            order: request.body.provider,
        };
    } else {
        delete request.body.provider;
    }
    
    if (Array.isArray(request.body.quantizations) && request.body.quantizations.length > 0) {
        request.body.provider ??= {};
        request.body.provider.quantizations = request.body.quantizations;
    }
    
    request.body = _.pickBy(request.body, (_, key) => OPENROUTER_KEYS.includes(key));
    args.body = JSON.stringify(request.body);
}

if (request.body.api_type === TEXTGEN_TYPES.OLLAMA) {
    const keepAlive = Number(getConfigValue('ollama.keepAlive', -1, 'number'));
    const numBatch = Number(getConfigValue('ollama.batchSize', -1, 'number'));
    
    if (numBatch > 0) {
        request.body.num_batch = numBatch;
    }
    
    args.body = JSON.stringify({
        model: request.body.model,
        prompt: request.body.prompt,
        stream: request.body.stream ?? false,
        keep_alive: keepAlive,
        raw: true,
        options: _.pickBy(request.body, (_, key) => OLLAMA_KEYS.includes(key)),
    });
}

// Special Ollama streaming handler
if (request.body.api_type === TEXTGEN_TYPES.OLLAMA && request.body.stream) {
    const stream = await fetch(url, args);
    parseOllamaStream(stream, request, response);
} else if (request.body.stream) {
    const completionsStream = await fetch(url, args);
    forwardFetchResponse(completionsStream, response);
} else {
    const completionsReply = await fetch(url, args);
    
    if (completionsReply.ok) {
        const data = await completionsReply.json();
        console.debug('Endpoint response:', data);
        
        // Map InfermaticAI response to OAI format
        if (apiType === TEXTGEN_TYPES.INFERMATICAI) {
            data.choices = (data?.choices || []).map(choice => ({ 
                text: choice?.message?.content || choice.text, 
                logprobs: choice?.logprobs, 
                index: choice?.index 
            }));
        }
        
        return response.send(data);
    }
}
```

**Ollama Special Streaming Handler:**

```javascript
async function parseOllamaStream(jsonStream, request, response) {
    try {
        if (!jsonStream.body) {
            throw new Error('No body in the response');
        }
        
        let partialData = '';
        jsonStream.body.on('data', (data) => {
            const chunk = data.toString();
            partialData += chunk;
            
            while (true) {
                let json;
                try {
                    json = JSON.parse(partialData);
                } catch (e) {
                    break;
                }
                
                const text = json.response || '';
                const thinking = json.thinking || '';
                const chunk = { choices: [{ text, thinking }] };
                response.write(`data: ${JSON.stringify(chunk)}\n\n`);
                
                partialData = '';
                
                if (json.done) {
                    response.write('data: [DONE]\n\n');
                    response.end();
                    return;
                }
            }
        });
        
        jsonStream.body.on('end', () => {
            if (!response.writableEnded) {
                response.write('data: [DONE]\n\n');
                response.end();
            }
        });
    } catch (error) {
        console.error('Ollama stream error:', error);
        if (!response.headersSent) {
            response.sendStatus(500);
        }
    }
}
```

### Google (MakerSuite / Vertex AI)

Google requires different handling based on authentication method:

```javascript
export async function getGoogleApiConfig(request, model, endpoint = 'generateContent') {
    let url = '';
    let baseUrl = '';
    const headers = {};
    const safetySettings = request.body.use_makersuite ? GEMINI_SAFETY : VERTEX_SAFETY;
    let apiName = '';
    
    if (request.body.use_vertexai) {
        // Vertex AI path
        apiName = 'Vertex AI';
        const authType = request.body.vertexai_auth_type || 'service_account';
        const apiUrl = trimTrailingSlash(request.body.reverse_proxy || API_VERTEX_AI);
        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        baseUrl = `${apiUrl}/${apiVersion}`;
        
        if (authType === 'apikey') {
            // API key mode
            const keyParam = request.body.reverse_proxy 
                ? `?key=${request.body.proxy_password}` 
                : `?key=${readSecret(request.user.directories, SECRET_KEYS.VERTEXAI)}`;
            const region = request.body.vertexai_region || 'us-central1';
            const projectId = request.body.vertexai_project_id;
            
            url = projectId
                ? `${baseUrl}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`
                : `${baseUrl}/publishers/google/models/${model}:${endpoint}`;
            headers['x-goog-api-key'] = keyParam;
        } else if (authType === 'full') {
            // Full service account mode
            const serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT);
            if (!serviceAccountJson) {
                throw new Error('Vertex AI service account JSON is missing');
            }
            
            const projectId = getProjectIdFromServiceAccount(serviceAccountJson);
            const region = request.body.vertexai_region || 'us-central1';
            url = `${baseUrl}/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${endpoint}`;
            
            // Get OAuth token
            const auth = await getVertexAIAuth(request.user.directories);
            headers['Authorization'] = `Bearer ${auth.access_token}`;
        }
    } else {
        // Google AI Studio
        apiName = 'Google AI Studio';
        const apiKey = request.body.reverse_proxy 
            ? request.body.proxy_password 
            : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE);
        const apiUrl = trimTrailingSlash(request.body.reverse_proxy || API_MAKERSUITE);
        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        baseUrl = `${apiUrl}/${apiVersion}`;
        url = `${baseUrl}/models/${model}:${endpoint}`;
        headers['x-goog-api-key'] = apiKey;
    }
    
    return { url, headers, apiName, baseUrl, safetySettings };
}
```

---

## 4. Compatibility Mechanisms

### OpenAI Format Standardization

SillyTavern attempts to standardize on OpenAI's format whenever possible:

```javascript
// Standard request transformation
const requestBody = {
    'messages': request.body.messages,
    'model': request.body.model,
    'temperature': request.body.temperature,
    'max_tokens': request.body.max_tokens,
    'stream': request.body.stream,
    'presence_penalty': request.body.presence_penalty,
    'frequency_penalty': request.body.frequency_penalty,
    'top_p': request.body.top_p,
    'top_k': request.body.top_k,
    'logit_bias': request.body.logit_bias,
    'seed': request.body.seed,
    ...bodyParams,
};
```

### Message Format Conversions

**Standard OpenAI Message:**
```javascript
{
    role: "user" | "assistant" | "system",
    content: "text" | [{type: "text", text: "..."}, {type: "image_url", image_url: {...}}],
    name: "optional_name"
}
```

**Claude Conversion:**
```javascript
{
    role: "user" | "assistant",  // No "system" in messages
    content: [
        {type: "text", text: "..."},
        {type: "image", source: {type: "base64", media_type: "image/png", data: "..."}}
    ]
}
```

**MistralAI Conversion:**

```javascript
export function convertMistralMessages(messages, names) {
    return messages.map(msg => {
        if (msg.role === 'system') {
            // MistralAI doesn't support system role in all models
            return { role: 'user', content: `[SYSTEM]\n${msg.content}` };
        }
        return msg;
    });
}
```

### Chat Completion vs Text Completion

The system distinguishes between these two paradigms:

**Chat Completion** (conversational):
- Messages array with roles
- Context management
- Multi-turn conversations
- Function/tool calling

**Text Completion** (legacy):
- Single prompt string
- No role concept
- Direct continuation
- Simpler parameter set

```javascript
// Detection logic
const isTextCompletion = Boolean(request.body.model && TEXT_COMPLETION_MODELS.includes(request.body.model)) 
    || typeof request.body.messages === 'string';

if (isTextCompletion) {
    // Convert messages to single prompt
    const textPrompt = convertTextCompletionPrompt(request.body.messages);
    requestBody.prompt = textPrompt;
} else {
    // Use messages array
    requestBody.messages = request.body.messages;
}
```

### Streaming Implementation

Server-Sent Events (SSE) are used for streaming:

```javascript
export function forwardFetchResponse(fetchResponse, expressResponse) {
    expressResponse.setHeader('Content-Type', 'text/event-stream');
    expressResponse.setHeader('Cache-Control', 'no-cache');
    expressResponse.setHeader('Connection', 'keep-alive');
    
    fetchResponse.body.on('data', (chunk) => {
        if (!expressResponse.writableEnded) {
            expressResponse.write(chunk);
        }
    });
    
    fetchResponse.body.on('end', () => {
        if (!expressResponse.writableEnded) {
            expressResponse.end();
        }
    });
    
    fetchResponse.body.on('error', (error) => {
        console.error('Stream error:', error);
        if (!expressResponse.headersSent) {
            expressResponse.sendStatus(500);
        }
    });
}
```

**Client-side streaming parsing:**

```javascript
async function* streamData() {
    let text = '';
    const swipes = [];
    const state = { reasoning: '', images: [], signature: '' };
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        
        const rawData = value.data;
        if (rawData === '[DONE]') return;
        
        tryParseStreamingError(response, rawData);
        const parsed = JSON.parse(rawData);
        
        if (canMultiSwipe && Array.isArray(parsed?.choices) && parsed?.choices?.[0]?.index > 0) {
            const swipeIndex = parsed.choices[0].index - 1;
            swipes[swipeIndex] = (swipes[swipeIndex] || '') + getStreamingReply(parsed, state);
        } else {
            text += getStreamingReply(parsed, state);
        }
        
        yield { text, swipes, state };
    }
}
```

### Error Handling

Each provider has its own error handling approach:

```javascript
// Generic error handling pattern
if (!generateResponse.ok) {
    const errorText = await generateResponse.text();
    console.warn(`Provider returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
    
    const errorJson = tryParse(errorText) ?? { error: true };
    return response.status(500).send(errorJson);
}
```

**OpenAI-specific:**
```javascript
const quota_error = fetchResponse.status === 429 && errorData?.error?.type === 'insufficient_quota';
console.error('Chat completion request error: ', message, responseText);

if (!response.headersSent) {
    response.send({ error: { message }, quota_error: quota_error });
}
```

**Claude-specific:**
```javascript
if (!generateResponse.ok) {
    const generateResponseText = await generateResponse.text();
    console.warn(color.red(`Claude API returned error: ${generateResponse.status} ${generateResponse.statusText}\n${generateResponseText}\n${divider}`));
    return response.status(500).send({ error: true });
}
```

---

## 5. Configuration & Settings

### Provider Configuration

Settings are managed through a combination of:

1. **Frontend settings** (`public/scripts/*-settings.js`)
2. **Backend configuration** (`src/endpoints/`)
3. **API keys** (secrets system)

**Chat Completion Settings:**

```javascript
const oai_settings = {
    chat_completion_source: 'openai',
    openai_model: 'gpt-4',
    claude_model: 'claude-3-5-sonnet-20241022',
    openrouter_model: 'openai/gpt-4',
    mistralai_model: 'mistral-large-latest',
    temperature: 0.7,
    top_p: 1.0,
    top_k: 0,
    max_tokens: 300,
    frequency_penalty: 0,
    presence_penalty: 0,
    stream: true,
    reverse_proxy: '',
    proxy_password: '',
    // ... many more settings
};
```

**Text Completion Settings:**

```javascript
export const textgenerationwebui_settings = {
    temp: 0.7,
    temperature_last: false,
    rep_pen: 1.1,
    rep_pen_range: 0,
    top_k: 40,
    top_p: 0.9,
    top_a: 0,
    tfs: 1,
    typical_p: 1,
    min_p: 0.05,
    max_tokens: 512,
    streaming: true,
    type: 'ooba',  // API type
    mancer_model: 'mytholite',
    togetherai_model: 'Gryphe/MythoMax-L2-13b',
    // ... more settings
};
```

### API Key Management

Centralized secrets system in **`src/endpoints/secrets.js`**:

```javascript
export const SECRET_KEYS = {
    HORDE: 'api_key_horde',
    MANCER: 'api_key_mancer',
    VLLM: 'api_key_vllm',
    APHRODITE: 'api_key_aphrodite',
    TABBY: 'api_key_tabby',
    OPENAI: 'api_key_openai',
    NOVEL: 'api_key_novel',
    CLAUDE: 'api_key_claude',
    DEEPL: 'deepl',
    LIBRE: 'libre',
    OPENROUTER: 'api_key_openrouter',
    AI21: 'api_key_ai21',
    MAKERSUITE: 'api_key_makersuite',
    VERTEXAI: 'api_key_vertexai',
    MISTRALAI: 'api_key_mistralai',
    TOGETHERAI: 'api_key_togetherai',
    CUSTOM: 'api_key_custom',
    COHERE: 'api_key_cohere',
    PERPLEXITY: 'api_key_perplexity',
    GROQ: 'api_key_groq',
    DEEPSEEK: 'api_key_deepseek',
    XAI: 'api_key_xai',
    CHUTES: 'api_key_chutes',
    ELECTRONHUB: 'api_key_electronhub',
    NANOGPT: 'api_key_nanogpt',
    AIMLAPI: 'api_key_aimlapi',
    MOONSHOT: 'api_key_moonshot',
    FIREWORKS: 'api_key_fireworks',
    ZAI: 'api_key_zai',
    SILICONFLOW: 'api_key_siliconflow',
    POLLINATIONS: 'api_key_pollinations',
    // ... more keys
};

export class SecretManager {
    /**
     * Reads a secret from the secrets file
     */
    static read(directories, key) {
        const secretsPath = path.join(directories.root, SECRETS_FILE);
        
        if (!fs.existsSync(secretsPath)) {
            return null;
        }
        
        try {
            const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
            return secrets[key] || null;
        } catch (error) {
            console.error('Failed to read secrets:', error);
            return null;
        }
    }
    
    /**
     * Writes a secret to the secrets file
     */
    static write(directories, key, value) {
        const secretsPath = path.join(directories.root, SECRETS_FILE);
        let secrets = {};
        
        if (fs.existsSync(secretsPath)) {
            secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        }
        
        secrets[key] = value;
        writeFileAtomicSync(secretsPath, JSON.stringify(secrets, null, 4), 'utf8');
    }
}

// Legacy compatibility functions
export function readSecret(directories, key) {
    return SecretManager.read(directories, key);
}

export function writeSecret(directories, key, value) {
    return SecretManager.write(directories, key, value);
}
```

### Provider-Specific Settings

**OpenRouter Settings:**

```javascript
{
    openrouter_providers: [],  // Preferred providers
    openrouter_quantizations: [],  // Model quantizations
    openrouter_allow_fallbacks: true,
    openrouter_sort_models: 'alphabetically',
    openrouter_group_models: true,
    openrouter_use_fallback: false,
    openrouter_cache_prompts: false,
    middleout: 'auto',  // Middle-out optimization
    enable_web_search: false,
}
```

**Azure OpenAI Settings:**

```javascript
{
    azure_base_url: 'https://YOUR-RESOURCE.openai.azure.com',
    azure_deployment_name: 'YOUR-DEPLOYMENT',
    azure_api_version: '2024-02-15-preview',
}
```

**Claude-Specific:**

```javascript
{
    claude_model: 'claude-3-5-sonnet-20241022',
    assistant_prefill: '',  // Prefill text
    use_sysprompt: true,
    include_thinking: false,
    thinking_budget: 0.5,  // Budget ratio
    cachingAtDepth: -1,  // Prompt caching
    cacheTTL: 600,  // Cache time-to-live
}
```

---

## 6. Current Architecture Issues

### Issue 1: Massive Switch/Case Statements

**Location:** `src/endpoints/backends/chat-completions.js`, lines 2033-2042

**Problem:** The main `/generate` endpoint uses a giant switch statement to route requests:

```javascript
switch (request.body.chat_completion_source) {
    case CHAT_COMPLETION_SOURCES.CLAUDE: return await sendClaudeRequest(request, response);
    case CHAT_COMPLETION_SOURCES.AI21: return await sendAI21Request(request, response);
    case CHAT_COMPLETION_SOURCES.MAKERSUITE: return await sendMakerSuiteRequest(request, response);
    case CHAT_COMPLETION_SOURCES.VERTEXAI: return await sendMakerSuiteRequest(request, response);
    case CHAT_COMPLETION_SOURCES.MISTRALAI: return await sendMistralAIRequest(request, response);
    case CHAT_COMPLETION_SOURCES.COHERE: return await sendCohereRequest(request, response);
    case CHAT_COMPLETION_SOURCES.DEEPSEEK: return await sendDeepSeekRequest(request, response);
    case CHAT_COMPLETION_SOURCES.AIMLAPI: return await sendAimlapiRequest(request, response);
    case CHAT_COMPLETION_SOURCES.XAI: return await sendXaiRequest(request, response);
    case CHAT_COMPLETION_SOURCES.CHUTES: return await sendChutesRequest(request, response);
    case CHAT_COMPLETION_SOURCES.ELECTRONHUB: return await sendElectronHubRequest(request, response);
    case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: return await sendAzureOpenAIRequest(request, response);
}
```

**Why it's bad:**
- Adding new providers requires modifying core routing logic
- Violates Open/Closed Principle
- Makes testing harder (can't easily mock providers)
- Difficult to maintain as it grows

### Issue 2: Duplicated Code Across Providers

**Example:** Request body building is repeated in nearly identical form:

**ElectronHub (lines 1334-1408):**
```javascript
async function sendElectronHubRequest(request, response) {
    const apiUrl = API_ELECTRONHUB;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB);
    
    if (!apiKey) {
        console.warn('Electron Hub key is missing.');
        return response.status(400).send({ error: true });
    }
    
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });
    
    try {
        let bodyParams = {};
        
        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }
        
        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            ...bodyParams,
        };
        
        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        // ... rest of handler
    }
}
```

**Chutes (lines 1446-1522):**
```javascript
async function sendChutesRequest(request, response) {
    const apiUrl = API_CHUTES;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES);
    
    if (!apiKey) {
        console.warn('Chutes key is missing.');
        return response.status(400).send({ error: true });
    }
    
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        controller.abort();
    });
    
    try {
        let bodyParams = {};
        
        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }
        
        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'seed': request.body.seed,
            'reasoning_effort': request.body.reasoning_effort,
            ...bodyParams,
        };
        
        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        // ... rest of handler
    }
}
```

**~90% of the code is identical.** This is repeated for ~15+ providers.

### Issue 3: Inconsistent Error Handling

Different providers use different error handling patterns:

**Pattern A (Claude):**
```javascript
if (!generateResponse.ok) {
    const generateResponseText = await generateResponse.text();
    console.warn(color.red(`Claude API returned error: ${generateResponse.status}`));
    return response.status(500).send({ error: true });
}
```

**Pattern B (DeepSeek):**
```javascript
if (!generateResponse.ok) {
    const errorText = await generateResponse.text();
    console.warn(`DeepSeek API returned error: ${generateResponse.status}`);
    const errorJson = tryParse(errorText) ?? { error: true };
    return response.status(500).send(errorJson);
}
```

**Pattern C (OpenAI default):**
```javascript
if (!fetchResponse.ok) {
    const message = fetchResponse.statusText || 'Unknown error occurred';
    const quota_error = fetchResponse.status === 429 && errorData?.error?.type === 'insufficient_quota';
    
    if (!response.headersSent) {
        response.send({ error: { message }, quota_error: quota_error });
    }
}
```

**Why it's bad:**
- Inconsistent error messages to users
- Different error formats make client-side handling difficult
- Some providers check `response.headersSent`, others don't
- No unified error logging/telemetry

### Issue 4: Hard-Coded Provider URLs

**Location:** Throughout `chat-completions.js`

```javascript
const API_OPENAI = 'https://api.openai.com/v1';
const API_CLAUDE = 'https://api.anthropic.com/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_COHERE_V1 = 'https://api.cohere.ai/v1';
const API_COHERE_V2 = 'https://api.cohere.ai/v2';
const API_PERPLEXITY = 'https://api.perplexity.ai';
const API_GROQ = 'https://api.groq.com/openai/v1';
// ... 20+ more
```

**Why it's bad:**
- URLs scattered throughout codebase
- No easy way to change URLs for testing
- Can't easily add URL versioning
- Makes mocking difficult

### Issue 5: Mixed Concerns in Route Handlers

Provider functions handle multiple responsibilities:

```javascript
async function sendClaudeRequest(request, response) {
    // 1. Configuration/validation
    const apiUrl = new URL(request.body.reverse_proxy || API_CLAUDE).toString();
    const apiKey = ...;
    
    // 2. Request body transformation
    const convertedPrompt = convertClaudeMessages(...);
    
    // 3. Feature detection
    const useThinking = /^claude-(3-7|opus-4|sonnet-4)/.test(request.body.model);
    
    // 4. Building request
    let requestBody = { ... };
    
    // 5. HTTP communication
    const generateResponse = await fetch(...);
    
    // 6. Response handling
    if (request.body.stream) { ... }
    
    // 7. Error handling
    catch (error) { ... }
}
```

**Violation of Single Responsibility Principle** - each function does too much.

### Issue 6: No Provider Abstraction

There's no interface or base class defining what a provider must implement:

```javascript
// What SHOULD exist but doesn't:
interface Provider {
    validateConfig(): boolean;
    buildRequest(request): object;
    sendRequest(requestBody): Promise<Response>;
    parseResponse(response): object;
    handleError(error): object;
}
```

### Issue 7: Prompt Conversion Sprawl

Message conversion functions are scattered:

**In `prompt-converters.js`:**
- `convertClaudeMessages()` - 180 lines
- `convertClaudePrompt()` - 260 lines  
- `convertMistralMessages()` - 40 lines
- `convertGooglePrompt()` - 150 lines
- `convertCohereMessages()` - 100 lines
- `convertAI21Messages()` - 60 lines

**Why it's bad:**
- No consistent conversion interface
- Some providers have 2-3 different conversion functions
- Hard to test conversion logic in isolation
- Difficult to add new message features (like multi-modal)

---

## 7. Improvement Recommendations (Backward-Compatible)

### Recommendation 1: Provider Registry Pattern

**Goal:** Eliminate switch statements and enable dynamic provider registration.

**Implementation:**

```javascript
// NEW FILE: src/providers/ProviderRegistry.js

class ProviderRegistry {
    constructor() {
        this.providers = new Map();
    }
    
    /**
     * Register a provider with its handler
     * @param {string} name - Provider identifier
     * @param {ProviderHandler} handler - Provider implementation
     */
    register(name, handler) {
        if (this.providers.has(name)) {
            console.warn(`Provider ${name} already registered, overwriting`);
        }
        this.providers.set(name, handler);
    }
    
    /**
     * Get provider handler by name
     * @param {string} name - Provider identifier
     * @returns {ProviderHandler|null}
     */
    get(name) {
        return this.providers.get(name) || null;
    }
    
    /**
     * Check if provider exists
     * @param {string} name - Provider identifier
     * @returns {boolean}
     */
    has(name) {
        return this.providers.has(name);
    }
    
    /**
     * Get all registered provider names
     * @returns {string[]}
     */
    listProviders() {
        return Array.from(this.providers.keys());
    }
}

export const providerRegistry = new ProviderRegistry();
```

**Before (switch statement):**

```javascript
router.post('/generate', async function (request, response) {
    switch (request.body.chat_completion_source) {
        case 'claude': return await sendClaudeRequest(request, response);
        case 'openai': return await sendOpenAIRequest(request, response);
        // ... 12 more cases
    }
});
```

**After (registry lookup):**

```javascript
// src/endpoints/backends/chat-completions.js
import { providerRegistry } from '../../providers/ProviderRegistry.js';

router.post('/generate', async function (request, response) {
    try {
        if (!request.body) {
            return response.status(400).send({ error: true });
        }
        
        const provider = providerRegistry.get(request.body.chat_completion_source);
        
        if (!provider) {
            return response.status(400).send({ 
                error: `Unknown provider: ${request.body.chat_completion_source}` 
            });
        }
        
        return await provider.handle(request, response);
    } catch (error) {
        console.error('Provider error:', error);
        return response.status(500).send({ error: error.message });
    }
});
```

**Registration (during startup):**

```javascript
// src/providers/index.js
import { providerRegistry } from './ProviderRegistry.js';
import { ClaudeProvider } from './ClaudeProvider.js';
import { OpenAIProvider } from './OpenAIProvider.js';
import { MistralProvider } from './MistralProvider.js';
// ... import all providers

export function registerProviders() {
    providerRegistry.register('claude', new ClaudeProvider());
    providerRegistry.register('openai', new OpenAIProvider());
    providerRegistry.register('mistralai', new MistralProvider());
    providerRegistry.register('openrouter', new OpenRouterProvider());
    providerRegistry.register('cohere', new CohereProvider());
    // ... register all providers
    
    console.log(`Registered ${providerRegistry.listProviders().length} providers`);
}
```

**Benefits:**
- ✅ No more switch statements
- ✅ Easy to add new providers without touching core routing
- ✅ Providers can be registered/unregistered dynamically
- ✅ 100% backward compatible (just refactors existing code)

---

### Recommendation 2: Base Provider Class

**Goal:** Eliminate code duplication and enforce consistent interface.

**Implementation:**

```javascript
// NEW FILE: src/providers/BaseProvider.js

export class BaseProvider {
    constructor(config = {}) {
        this.config = {
            apiUrl: config.apiUrl || '',
            secretKey: config.secretKey || '',
            defaultModel: config.defaultModel || '',
            supportStreaming: config.supportStreaming !== false,
            supportTools: config.supportTools !== false,
            ...config,
        };
    }
    
    /**
     * Main entry point - handles the full request/response cycle
     * @param {express.Request} request 
     * @param {express.Response} response 
     */
    async handle(request, response) {
        const controller = new AbortController();
        
        // Setup abort handling
        request.socket.removeAllListeners('close');
        request.socket.on('close', () => controller.abort());
        
        try {
            // 1. Validate configuration
            const validationError = this.validateRequest(request);
            if (validationError) {
                return response.status(400).send({ error: validationError });
            }
            
            // 2. Build request body
            const requestBody = await this.buildRequestBody(request);
            
            // 3. Send request
            const apiResponse = await this.sendRequest(requestBody, request, controller.signal);
            
            // 4. Handle response
            if (request.body.stream) {
                return this.handleStreamingResponse(apiResponse, response);
            } else {
                return this.handleNonStreamingResponse(apiResponse, response);
            }
        } catch (error) {
            return this.handleError(error, response);
        }
    }
    
    /**
     * Validate request and configuration
     * @param {express.Request} request 
     * @returns {string|null} Error message or null if valid
     */
    validateRequest(request) {
        const apiKey = this.getApiKey(request);
        if (!apiKey) {
            return `${this.config.name} API key is missing`;
        }
        
        if (!request.body.model) {
            return 'Model is required';
        }
        
        return null;
    }
    
    /**
     * Get API key from secrets or request
     * @param {express.Request} request 
     * @returns {string|null}
     */
    getApiKey(request) {
        if (request.body.reverse_proxy && request.body.proxy_password) {
            return request.body.proxy_password;
        }
        return readSecret(request.user.directories, this.config.secretKey);
    }
    
    /**
     * Build standardized request body
     * @param {express.Request} request 
     * @returns {Promise<object>}
     */
    async buildRequestBody(request) {
        const baseBody = {
            model: request.body.model,
            temperature: request.body.temperature,
            max_tokens: request.body.max_tokens,
            stream: request.body.stream,
            top_p: request.body.top_p,
        };
        
        // Add messages (provider-specific conversion happens in subclass)
        baseBody.messages = await this.convertMessages(request.body.messages, request);
        
        // Add optional parameters
        if (request.body.presence_penalty) {
            baseBody.presence_penalty = request.body.presence_penalty;
        }
        if (request.body.frequency_penalty) {
            baseBody.frequency_penalty = request.body.frequency_penalty;
        }
        
        // Add provider-specific parameters
        const customParams = await this.addCustomParameters(request);
        return { ...baseBody, ...customParams };
    }
    
    /**
     * Convert messages to provider format
     * Default implementation returns messages as-is
     * Override this in subclasses for provider-specific conversion
     * @param {object[]} messages 
     * @param {express.Request} request 
     * @returns {Promise<object[]>}
     */
    async convertMessages(messages, request) {
        return messages;
    }
    
    /**
     * Add provider-specific parameters
     * Override this in subclasses
     * @param {express.Request} request 
     * @returns {Promise<object>}
     */
    async addCustomParameters(request) {
        return {};
    }
    
    /**
     * Send HTTP request to provider API
     * @param {object} requestBody 
     * @param {express.Request} request 
     * @param {AbortSignal} signal 
     * @returns {Promise<Response>}
     */
    async sendRequest(requestBody, request, signal) {
        const apiUrl = request.body.reverse_proxy || this.config.apiUrl;
        const apiKey = this.getApiKey(request);
        
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...this.getCustomHeaders(request),
        };
        
        console.debug(`${this.config.name} request:`, requestBody);
        
        return await fetch(apiUrl + this.config.endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            signal: signal,
        });
    }
    
    /**
     * Get custom headers for provider
     * Override in subclasses if needed
     * @param {express.Request} request 
     * @returns {object}
     */
    getCustomHeaders(request) {
        return {};
    }
    
    /**
     * Handle streaming response
     * @param {Response} apiResponse 
     * @param {express.Response} response 
     */
    async handleStreamingResponse(apiResponse, response) {
        if (!apiResponse.ok) {
            return this.handleHttpError(apiResponse, response);
        }
        
        forwardFetchResponse(apiResponse, response);
    }
    
    /**
     * Handle non-streaming response
     * @param {Response} apiResponse 
     * @param {express.Response} response 
     */
    async handleNonStreamingResponse(apiResponse, response) {
        if (!apiResponse.ok) {
            return this.handleHttpError(apiResponse, response);
        }
        
        const data = await apiResponse.json();
        console.debug(`${this.config.name} response:`, data);
        
        // Convert to standardized format
        const standardized = this.standardizeResponse(data);
        return response.send(standardized);
    }
    
    /**
     * Convert provider response to OpenAI format
     * Override in subclasses if needed
     * @param {object} data 
     * @returns {object}
     */
    standardizeResponse(data) {
        return data; // Default: assume OpenAI format
    }
    
    /**
     * Handle HTTP errors
     * @param {Response} apiResponse 
     * @param {express.Response} response 
     */
    async handleHttpError(apiResponse, response) {
        const errorText = await apiResponse.text();
        console.warn(`${this.config.name} API error: ${apiResponse.status} ${apiResponse.statusText}\n${errorText}`);
        
        const errorData = tryParse(errorText) || { error: true };
        return response.status(apiResponse.status).send(errorData);
    }
    
    /**
     * Handle general errors
     * @param {Error} error 
     * @param {express.Response} response 
     */
    handleError(error, response) {
        console.error(`${this.config.name} error:`, error);
        
        if (!response.headersSent) {
            return response.status(500).send({ 
                error: error.message || 'Unknown error' 
            });
        } else if (!response.writableEnded) {
            response.end();
        }
    }
}
```

**Example Provider Implementation:**

```javascript
// NEW FILE: src/providers/ClaudeProvider.js

import { BaseProvider } from './BaseProvider.js';
import { convertClaudeMessages } from '../prompt-converters.js';
import { SECRET_KEYS } from '../endpoints/secrets.js';

export class ClaudeProvider extends BaseProvider {
    constructor() {
        super({
            name: 'Claude',
            apiUrl: 'https://api.anthropic.com/v1',
            endpoint: '/messages',
            secretKey: SECRET_KEYS.CLAUDE,
        });
    }
    
    async convertMessages(messages, request) {
        const useSystemPrompt = Boolean(request.body.use_sysprompt);
        const useTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
        const prefill = request.body.assistant_prefill || '';
        
        return convertClaudeMessages(messages, prefill, useSystemPrompt, useTools, getPromptNames(request));
    }
    
    async addCustomParameters(request) {
        const params = {};
        
        // Add top_k if specified
        if (request.body.top_k) {
            params.top_k = request.body.top_k;
        }
        
        // Add thinking mode
        const useThinking = /^claude-(3-7|opus-4|sonnet-4)/.test(request.body.model);
        if (useThinking && request.body.include_thinking) {
            params.thinking = {
                type: 'enabled',
                budget_tokens: this.calculateThinkingBudget(request),
            };
        }
        
        // Add tools
        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            params.tools = request.body.tools.map(fn => ({
                name: fn.name,
                description: fn.description,
                input_schema: fn.parameters,
            }));
        }
        
        return params;
    }
    
    getCustomHeaders(request) {
        return {
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'output-128k-2025-02-19,context-1m-2025-08-07',
        };
    }
    
    standardizeResponse(data) {
        // Convert Claude format to OpenAI format
        const content = data.content?.[0]?.text || '';
        return {
            choices: [{
                message: {
                    role: 'assistant',
                    content: content,
                },
                finish_reason: data.stop_reason,
            }],
            usage: data.usage,
        };
    }
    
    calculateThinkingBudget(request) {
        const budgetRatio = request.body.thinking_budget || 0.5;
        return Math.floor(request.body.max_tokens * budgetRatio);
    }
}
```

**Simple Provider Example:**

```javascript
// NEW FILE: src/providers/MistralProvider.js

import { BaseProvider } from './BaseProvider.js';
import { convertMistralMessages } from '../prompt-converters.js';
import { SECRET_KEYS } from '../endpoints/secrets.js';

export class MistralProvider extends BaseProvider {
    constructor() {
        super({
            name: 'MistralAI',
            apiUrl: 'https://api.mistral.ai/v1',
            endpoint: '/chat/completions',
            secretKey: SECRET_KEYS.MISTRALAI,
        });
    }
    
    async convertMessages(messages, request) {
        return convertMistralMessages(messages, getPromptNames(request));
    }
}
```

**Benefits:**
- ✅ ~200 lines of duplicated code eliminated per provider
- ✅ Consistent error handling across all providers
- ✅ Easy to add new providers (just extend base class)
- ✅ Provider-specific logic is isolated
- ✅ 100% backward compatible

---

### Recommendation 3: Unified Error Handler

**Goal:** Standardize error handling and logging across all providers.

**Implementation:**

```javascript
// NEW FILE: src/providers/ErrorHandler.js

export class ProviderError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'ProviderError';
        this.details = details;
        this.timestamp = new Date().toISOString();
    }
}

export class ErrorHandler {
    /**
     * Standardized error response formatting
     * @param {Error|ProviderError} error 
     * @param {string} provider 
     * @returns {object}
     */
    static formatError(error, provider) {
        const baseError = {
            error: {
                message: error.message || 'Unknown error',
                provider: provider,
                timestamp: error.timestamp || new Date().toISOString(),
            },
        };
        
        // Add additional details if available
        if (error.details) {
            baseError.error.details = error.details;
        }
        
        // Add stack trace in development
        if (process.env.NODE_ENV === 'development') {
            baseError.error.stack = error.stack;
        }
        
        return baseError;
    }
    
    /**
     * Parse HTTP error response
     * @param {Response} response 
     * @param {string} responseText 
     * @param {string} provider 
     * @returns {object}
     */
    static parseHttpError(response, responseText, provider) {
        // Try to parse as JSON first
        const parsed = tryParse(responseText);
        
        if (parsed && parsed.error) {
            return {
                error: {
                    message: parsed.error.message || parsed.error,
                    type: parsed.error.type || 'http_error',
                    code: parsed.error.code || response.status,
                    provider: provider,
                },
            };
        }
        
        // Fallback to generic error
        return {
            error: {
                message: responseText || response.statusText || 'HTTP error',
                code: response.status,
                provider: provider,
            },
        };
    }
    
    /**
     * Handle rate limiting errors
     * @param {number} status 
     * @param {object} errorData 
     * @param {string} provider 
     * @returns {object}
     */
    static handleRateLimit(status, errorData, provider) {
        const isRateLimit = status === 429;
        const isQuotaError = errorData?.error?.type === 'insufficient_quota';
        
        return {
            error: {
                message: errorData?.error?.message || 'Rate limit exceeded',
                type: isQuotaError ? 'quota_exceeded' : 'rate_limit',
                code: status,
                provider: provider,
                retry_after: errorData?.error?.retry_after,
            },
            quota_error: isQuotaError,
            rate_limit: isRateLimit,
        };
    }
    
    /**
     * Log error with consistent format
     * @param {Error} error 
     * @param {string} provider 
     * @param {object} context 
     */
    static log(error, provider, context = {}) {
        const logData = {
            timestamp: new Date().toISOString(),
            provider: provider,
            error: error.message,
            ...context,
        };
        
        if (error.details) {
            logData.details = error.details;
        }
        
        console.error(`[${provider}]`, JSON.stringify(logData, null, 2));
    }
}
```

**Usage in BaseProvider:**

```javascript
// Updated BaseProvider.handleHttpError()
async handleHttpError(apiResponse, response) {
    const errorText = await apiResponse.text();
    
    // Use unified error handler
    const errorResponse = ErrorHandler.parseHttpError(
        apiResponse, 
        errorText, 
        this.config.name
    );
    
    // Log error
    ErrorHandler.log(
        new Error(errorResponse.error.message),
        this.config.name,
        {
            status: apiResponse.status,
            url: apiResponse.url,
        }
    );
    
    // Check for rate limiting
    if (apiResponse.status === 429) {
        const rateLimitError = ErrorHandler.handleRateLimit(
            apiResponse.status,
            tryParse(errorText),
            this.config.name
        );
        return response.status(429).send(rateLimitError);
    }
    
    return response.status(apiResponse.status).send(errorResponse);
}
```

**Before:**

```javascript
// Inconsistent across providers
if (!generateResponse.ok) {
    const errorText = await generateResponse.text();
    console.warn(`Provider returned error: ${errorText}`);
    return response.status(500).send({ error: true });
}
```

**After:**

```javascript
// Consistent error handling
if (!apiResponse.ok) {
    return this.handleHttpError(apiResponse, response);
}
```

**Benefits:**
- ✅ Consistent error format across all providers
- ✅ Better error logging and debugging
- ✅ Rate limit handling standardized
- ✅ Easy to add error telemetry/monitoring
- ✅ 100% backward compatible

---

### Recommendation 4: Configuration Registry

**Goal:** Centralize provider URLs and configuration.

**Implementation:**

```javascript
// NEW FILE: src/providers/ProviderConfig.js

export const PROVIDER_CONFIGS = {
    openai: {
        name: 'OpenAI',
        apiUrl: 'https://api.openai.com/v1',
        endpoints: {
            chat: '/chat/completions',
            completions: '/completions',
            models: '/models',
            embeddings: '/embeddings',
        },
        secretKey: 'api_key_openai',
        features: {
            streaming: true,
            tools: true,
            vision: true,
            reasoning: true,
        },
        models: {
            reasoning: ['o1-preview', 'o1-mini', 'o3-mini'],
            vision: ['gpt-4-vision-preview', 'gpt-4o'],
        },
    },
    
    claude: {
        name: 'Claude',
        apiUrl: 'https://api.anthropic.com/v1',
        endpoints: {
            messages: '/messages',
        },
        secretKey: 'api_key_claude',
        features: {
            streaming: true,
            tools: true,
            vision: true,
            thinking: true,
        },
        models: {
            thinking: ['claude-3-7', 'claude-opus-4', 'claude-sonnet-4'],
        },
        headers: {
            'anthropic-version': '2023-06-01',
        },
    },
    
    mistralai: {
        name: 'MistralAI',
        apiUrl: 'https://api.mistral.ai/v1',
        endpoints: {
            chat: '/chat/completions',
        },
        secretKey: 'api_key_mistralai',
        features: {
            streaming: true,
            tools: true,
        },
    },
    
    openrouter: {
        name: 'OpenRouter',
        apiUrl: 'https://openrouter.ai/api/v1',
        endpoints: {
            chat: '/chat/completions',
            models: '/models',
        },
        secretKey: 'api_key_openrouter',
        features: {
            streaming: true,
            tools: true,
            providers: true,
            caching: true,
        },
        headers: {
            'HTTP-Referer': 'https://sillytavern.app',
            'X-Title': 'SillyTavern',
        },
    },
    
    // ... all other providers
};

export class ProviderConfig {
    /**
     * Get configuration for a provider
     * @param {string} providerName 
     * @returns {object|null}
     */
    static get(providerName) {
        return PROVIDER_CONFIGS[providerName] || null;
    }
    
    /**
     * Get API URL for provider
     * @param {string} providerName 
     * @param {string} endpoint 
     * @returns {string}
     */
    static getUrl(providerName, endpoint = 'chat') {
        const config = this.get(providerName);
        if (!config) return null;
        
        return config.apiUrl + (config.endpoints[endpoint] || '');
    }
    
    /**
     * Check if provider supports a feature
     * @param {string} providerName 
     * @param {string} feature 
     * @returns {boolean}
     */
    static supportsFeature(providerName, feature) {
        const config = this.get(providerName);
        return config?.features?.[feature] === true;
    }
    
    /**
     * Get custom headers for provider
     * @param {string} providerName 
     * @returns {object}
     */
    static getHeaders(providerName) {
        const config = this.get(providerName);
        return config?.headers || {};
    }
}
```

**Usage:**

```javascript
// In BaseProvider constructor
constructor(providerName) {
    const config = ProviderConfig.get(providerName);
    if (!config) {
        throw new Error(`Unknown provider: ${providerName}`);
    }
    
    this.config = config;
}

// In provider implementations
getCustomHeaders(request) {
    return ProviderConfig.getHeaders(this.config.name);
}

// Feature detection
if (ProviderConfig.supportsFeature('claude', 'thinking')) {
    // Add thinking parameters
}
```

**Benefits:**
- ✅ All provider URLs in one place
- ✅ Easy to update API versions
- ✅ Feature flags for capability detection
- ✅ Easy to add test/staging URLs
- ✅ 100% backward compatible

---

### Recommendation 5: Message Converter Interface

**Goal:** Standardize message conversion across providers.

**Implementation:**

```javascript
// NEW FILE: src/providers/MessageConverter.js

export class MessageConverter {
    /**
     * Convert messages to provider-specific format
     * @param {object[]} messages 
     * @param {string} provider 
     * @param {object} options 
     * @returns {object}
     */
    static convert(messages, provider, options = {}) {
        const converter = this.getConverter(provider);
        return converter(messages, options);
    }
    
    /**
     * Get converter function for provider
     * @param {string} provider 
     * @returns {function}
     */
    static getConverter(provider) {
        const converters = {
            'claude': this.convertClaude,
            'mistralai': this.convertMistral,
            'google': this.convertGoogle,
            'cohere': this.convertCohere,
            'ai21': this.convertAI21,
            'openai': this.convertOpenAI, // passthrough
        };
        
        return converters[provider] || this.convertOpenAI;
    }
    
    /**
     * Convert to Claude format
     * @param {object[]} messages 
     * @param {object} options 
     * @returns {object}
     */
    static convertClaude(messages, options) {
        const { prefill = '', useSystemPrompt = true, useTools = false } = options;
        
        let systemPrompt = [];
        let convertedMessages = [...messages];
        
        // Extract system messages
        if (useSystemPrompt) {
            while (convertedMessages.length && convertedMessages[0].role === 'system') {
                const sysMsg = convertedMessages.shift();
                systemPrompt.push({
                    type: 'text',
                    text: sysMsg.content,
                });
            }
        }
        
        // Convert message format
        convertedMessages = convertedMessages.map(msg => ({
            role: msg.role,
            content: this.convertContent(msg.content, 'claude'),
        }));
        
        // Add prefill
        if (prefill) {
            convertedMessages.push({
                role: 'assistant',
                content: [{ type: 'text', text: prefill.trimEnd() }],
            });
        }
        
        return {
            messages: convertedMessages,
            system: systemPrompt.length ? systemPrompt : undefined,
        };
    }
    
    /**
     * Convert message content to provider format
     * @param {string|array} content 
     * @param {string} provider 
     * @returns {string|array}
     */
    static convertContent(content, provider) {
        if (typeof content === 'string') {
            return provider === 'claude' ? [{ type: 'text', text: content }] : content;
        }
        
        if (!Array.isArray(content)) {
            return content;
        }
        
        // Handle multi-modal content
        return content.map(part => {
            if (part.type === 'text') {
                return part;
            }
            
            if (part.type === 'image_url') {
                // Provider-specific image format
                switch (provider) {
                    case 'claude':
                        return {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: this.extractMediaType(part.image_url.url),
                                data: this.extractBase64(part.image_url.url),
                            },
                        };
                    default:
                        return part;
                }
            }
            
            return part;
        });
    }
    
    /**
     * Extract media type from data URL
     * @param {string} url 
     * @returns {string}
     */
    static extractMediaType(url) {
        const match = url.match(/data:([^;]+);/);
        return match ? match[1] : 'image/png';
    }
    
    /**
     * Extract base64 data from data URL
     * @param {string} url 
     * @returns {string}
     */
    static extractBase64(url) {
        const match = url.match(/base64,(.+)$/);
        return match ? match[1] : url;
    }
    
    /**
     * Convert to MistralAI format
     * @param {object[]} messages 
     * @returns {object[]}
     */
    static convertMistral(messages) {
        return messages.map(msg => {
            // MistralAI doesn't support system role in some models
            if (msg.role === 'system') {
                return {
                    role: 'user',
                    content: `[SYSTEM]\n${msg.content}`,
                };
            }
            return msg;
        });
    }
    
    /**
     * OpenAI passthrough (no conversion needed)
     * @param {object[]} messages 
     * @returns {object[]}
     */
    static convertOpenAI(messages) {
        return messages;
    }
    
    // ... other converter methods
}
```

**Usage in BaseProvider:**

```javascript
async convertMessages(messages, request) {
    const options = {
        prefill: request.body.assistant_prefill || '',
        useSystemPrompt: Boolean(request.body.use_sysprompt),
        useTools: Array.isArray(request.body.tools) && request.body.tools.length > 0,
    };
    
    return MessageConverter.convert(messages, this.config.name, options);
}
```

**Benefits:**
- ✅ Centralized conversion logic
- ✅ Easy to test message conversion
- ✅ Consistent handling of multi-modal content
- ✅ Easy to add new conversion rules
- ✅ 100% backward compatible

---

## Summary

This document provides a comprehensive analysis of SillyTavern's API compatibility architecture, covering:

1. **Overview** - 25+ supported providers across chat and text completion paradigms
2. **Abstraction Layer** - Express routing and provider dispatch mechanisms
3. **Provider Implementations** - Detailed code examples for OpenAI, Claude, OpenRouter, KoboldAI, and Google
4. **Compatibility Mechanisms** - Format standardization, message conversion, streaming, and error handling
5. **Configuration** - API key management and provider-specific settings
6. **Architecture Issues** - 7 specific problems with code examples
7. **Improvement Recommendations** - 5 concrete refactoring proposals with full implementation code

All recommendations are **backward-compatible** and can be implemented incrementally without breaking existing functionality.

**Key Takeaways for Multi-Provider Systems:**

- **Provider Registry Pattern** eliminates switch statements and enables plugin-like extensibility
- **Base Provider Class** reduces duplication and enforces consistent interfaces
- **Unified Error Handling** improves debugging and user experience
- **Configuration Centralization** simplifies maintenance and testing
- **Message Conversion Abstraction** isolates format-specific logic and improves testability

These patterns can be directly applied to the caretaker agent project for supporting multiple LLM backends while maintaining clean, maintainable code.