---
title: Vision and Media Input
topics: [architecture, vision]
sources:
  - id: media-js
    type: file
    path: src/vision/media.js
  - id: vision-js
    type: file
    path: src/vision/vision.js
  - id: zai-vision-js
    type: file
    path: src/vision/zai-vision.js
  - id: slug-ids-js
    type: file
    path: slug-ids.js
  - id: server-js
    type: file
    path: server.js
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: providers-js
    type: file
    path: providers.js
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: gemini-file-api-js
    type: file
    path: src/vision/gemini-file-api.js
  - id: video-build-spec
    type: file
    path: docs/video-build-spec.md
---

# Vision and Media Input

Proto-Familiar 0.9.0 introduces multimodal image input, letting the ward send images to the Familiar alongside messages. The vision system is built in layers: a content-addressed media store (`media.js`), a materialization seam (`vision.js`) that converts stored attachments into provider-consumable image data at chat time, and graceful degradation when modality is not available. Starting in 0.11.33-alpha, the same store and materialization seam grow a `video` media kind, covered in the Video media section below [@video-build-spec].

The load-bearing constraint is that `message.content` stays a plain string forever. Media rides beside it as an optional `attachments` field, so every existing string-assuming consumer keeps working untouched. The reference seam where attachments become LLM-visible content is exactly one code path: `materializeAttachments()` in `vision.js` [@vision-js].

## Media storage

`media.js` maintains a content-addressed store at `media/<sha>.<ext>` on disk, keyed by file hash [@media-js]. Every asset gets a `.json` sidecar recording metadata (MIME type, dimensions if image, timestamp), and the folder maintains a `.slugs.json` index mapping friendly names to hashes for user-facing references [@media-js].

**Deduplication**: `saveAsset()` hashes incoming bytes and stores only once per unique content — two uploads of the identical file produce one asset on disk [@media-js].

**Image dimensions**: The system reads JPEG SOF markers, PNG IHDR chunks, GIF screen descriptors, and WebP VP8/VP8L/VP8X headers in pure JavaScript without native libraries — no external imagemagick or GraphicsMagick dependency [@media-js]. This means dimension lookup is fast and side-effect-free [@media-js].

**Capabilities**: `MEDIA_MAX_BYTES` caps uploads at 6 MB and `IMAGE_MIME_EXT` whitelists recognized formats; both limits are enforced at save time [@media-js]. The module is designed to never throw: validation is early and loud, and callers can rely on the API [@media-js].

**Friendly names**: When an asset arrives with a camera-original name like `IMG_1234.jpg`, `PXL_9876.jpg`, `DSC_5432.jpg`, or `Screenshot_timestamp`, `slug-ids.js` normalizes the label to a generic fallback (`img-xxxxxx`) to avoid cluttering the UI with uninformative names [@slug-ids-js]. `meaningSlugId()` preserves any name that does not match the camera-noise patterns [@slug-ids-js].

**Shared with audio**: the [Voice](voice) milestone's Pass 1 extended this same content-addressed store to hold voice-note and read-aloud audio alongside images, deriving kind and file extension from one shared `MEDIA_KINDS` lookup table so an asset can no longer be stored as one media kind while carrying another kind's file extension [@media-js].

## Materialization: attachments to vision data

`materializeAttachments(apiMessages, {connection, settings, visibleAudiences})` converts stored attachments to LLM-visible image data at chat time, handling audience gating and modality fallback [@vision-js].

**Audience gating**: The function checks which audiences have vision access before materializing any attachment. If an attachment is private to an audience not listed in `visibleAudiences`, it contributes nothing to the turn — not even a text stand-in — fail-closed [@vision-js].

**Modality limit**: At most 4 images per turn are materialized into live `image_url` data-URL parts, newest-first. Older attachments in the same turn degrade to text stand-ins (see below) [@vision-js].

**Stand-in text**: When an image cannot be sent (modality off, over the limit, audience gated), `buildStandin()` and `contentWithStandins()` render a human-readable trace like `[image: sunset.jpg]` inline in the string content [@vision-js].

**Capability probe and caching**: Uncached vision capability (e.g., `visionCapable: 'auto'`) is resolved via `looksVisionCapable()`, a tight allowlist of known vision-capable model families [@vision-js]. Models outside the allowlist default to BLIND — their images are described instead of sent live. This conservative default reflects [a design decision made after an incident](../decisions/vision-capability-defaults): betting safety on provider rejection is unsafe when some blind models silently accept requests and confabulate [@vision-js]. After a successful live image turn, the result is cached in `tomes/.vision-capability.json` keyed by `provider:model` [@vision-js]. This allowlist + caching approach avoids extra LLM calls while defaulting ambiguous cases toward safety [@vision-js].

**Implementation in chat loops**: Both non-streaming and streaming chat paths in `server.js` wire the mid-turn fallback [@server-js]. The non-streaming loop wraps `runToolCallLoop` with a retry; the streaming loop re-runs the round with `round--` on the pre-header `!upstream.ok` branch when modality errors occur [@server-js].

**Field stripping**: After materialization, the internal `attachments` field is stripped from every outgoing message so strict LLM providers never see the unknown field [@vision-js].

**Modality detection**: `isModalityError()` classifies a 4xx response as a modality rejection so the fallback logic can distinguish it from other errors [@vision-js].

**Blind-image confabulation guard**: Even with allowlist protection, a fresh image without a description might reach a model that cannot see it (e.g., during transition or fallback cases). To prevent confabulation, `materializeAttachments()` injects a hard system-level constraint: when an image lacks a description, the materializer adds a system line stating the Familiar cannot see images without descriptions and will not guess or name unseen content — it will plainly say it cannot see and ask. This guard applies through the shared `materializeAttachments()` seam (via `blindImageStandins`), protecting all surfaces (web, Discord, voice) equally. The constraint rides at the prompt level, above any user or tool content, so models cannot dismiss it [@vision-js].

## Messages with attachments

Messages on the wire carry both `content: string` and an optional `attachments: [{id, kind, mime}]` field [@vision-js]. This shape is preserved through session logs and memorization: the string stays a string, and attachment metadata travels beside it.

Every existing consumer of `message.content` — timestamp stamp/strip in `message-sanitize`, the `INPUT_CHAR_CAP` enforcement, memorization filters that check `typeof m.content === 'string'` — keeps working unchanged because they never meet the attachments field [@vision-js].

## Graceful degradation

Vision is designed to degrade gracefully at every point: if the media store is unavailable, if an image cannot be read, if the connection lacks vision capability, or if the feature is disabled [@vision-js].

`PROTO_FAMILIAR_VISION_DISABLED=1` disables the whole subsystem; there is also an in-app setting (defaulting ON, inert until an image is sent) [@vision-js]. Critically, no image path may 500 the chat turn — the system always fails to stand-in text or drops the image silently [@vision-js].

## Image description caching (Pass 2)

`describeAsset()` calls a vision-capable model to produce a semantic description of an image, then caches the result on the asset metadata forever [@vision-js]. The description is never regenerated — once set, the Familiar has immediate access to "what this image looks like" without calling the model again.

**Capability-aware connection selection**: `resolveVisionConnection(settings)` picks among the ward's assigned vision connection, the primary connection, and any other available connection, checking each for actual vision capability. Unlike the plain `connectionForFeature`, only connections that can actually see are candidates — there is no use describing an image to a blind connection [@vision-js].

**Injection safety**: The description prompt explicitly frames text inside an image as external data to be read, never executed, protecting against prompt injection through text in image content. The resulting description is sanitized through `injection-guard` before caching [@vision-js].

**Fire-and-forget triggering**: When the chat path emits a stand-in for an undescribed asset (via `materializeAttachments`), the system fires `describeAsset()` as a background task from `server.js` so the description lands asynchronously without blocking the turn [@vision-js]. Memorization also triggers descriptions for images in session memories.

**Stand-in evolution**: Once a description is cached, `buildStandin()` uses it instead of a generic `[image]` placeholder, so the Familiar's references become specific ("a sunset over water") and traverse descriptions without needing the model to re-see the bytes.

## Re-examining images (view_image tool)

The `view_image` tool (@§10) lets the Familiar ask to look at an image again during a turn, even after initial description caching. The tool executor validates the image id and checks audience gating (`discordReadAudiences`), then stashes the pending image on `toolCtx._pendingImages`.

`drainPendingImages()` (in `media.js`, not `vision.js`) runs after the tool round completes in both the non-streaming loop (`runToolCallLoop` in cerebellum) and the streaming loop in `server.js` [@cerebellum-js]. It builds a user-role message carrying the image data-URLs and clears the stash. This architecture avoids the static import cycle between cerebellum and vision [@media-js, @vision-js].

The tool is advertised (included in `composeActiveTools`) only when the turn is vision-capable, checked via `resolveVisionCapable` on the request connection [@vision-js].

## Picture→node linking

Images can be linked to knowledge graph nodes via `addAssetLink()` and `unlink_image_from_node()`, recording which entity or concept an image depicts [@media-js]. The link lives as an embodiment-local annotation on the asset metadata — bytes stay local, no write to the Phylactery graph.

Each link records `{nodeId, label, kind, by}`, deduplicated by `nodeId` per image. The link `label` is the user-facing name of the concept ("Milkyway", "Orion"). `assetsForNode(nodeId)` retrieves all images linked to a given node.

**Ward-only linking**: The tools `link_image_to_node` and `unlink_image_from_node` are refused when `discordReadAudiences(ctx) !== undefined`, restricting node association to the ward only — villagers cannot create semantic links [@media-js].

**Stand-in projection**: The picture-to-node semantic is expressed in the stand-in text itself. `buildStandin()` appends link labels inline: `[image sunset: a warm orange sunset over water — of Milkyway — shared by my human]`. The Familiar thus reads which concept each image depicts as a matter of course, without needing a separate graph query [@media-js].

**Honest scope**: The system provides semantic continuity (what the image is, and which concept it depicts) but does not build embedding stacks or pixel-level recognition — the semantic link is authoritively human- or Familiar-authored, not inferred [@media-js].

## Memorization with images (foldImageStandins)

When an image-only turn (empty text, one or more attachments) is memorized, `foldImageStandins()` in memorization.js ensures the images themselves land in the slice transcript as memorable content [@media-js, @memorization-js].

The function first describes any undescribed assets using dynamic `import('./vision.js')` at call time — keeping `vision.js` out of the static memorization↔cerebellum import cycle, which would otherwise deepen an existing circular dependency. Memorization already imports `readSettingsSync` from cerebellum; cerebellum imports `pruneConsentPending` from memorization. Adding a static vision import to either would create a three-way cycle, so dynamic import defers the import until the moment a description is needed [@cerebellum-js, @memorization-js].

Once descriptions are in place, image stand-ins are folded into the transcript so the image becomes memorable through its textual description and picture-to-node links.

## Module dependencies and import cycles

The implementation carefully manages circular dependencies:

- `vision.js` → `cerebellum.js` (for `connectionForFeature`, `primaryConnectionFrom`), `media.js`, `llm-call`, `macros`, `injection-guard`
- `cerebellum.js` → `media.js` (for `getAssetMeta`, `addAssetLink`, `removeAssetLink`, `drainPendingImages`) — NOT `vision.js`
- `discord-gateway.js` → `media.js` (for `saveAsset`, caps), `vision.js` (for `materializeAttachments`, `resolveVisionCapable`)
- `memorization.js` → `vision.js` only via dynamic import at call time [@memorization-js]
- `drainPendingImages()` lives in `media.js` (not `vision.js`) precisely so both tool loops can reach it without cerebellum importing vision [@media-js]

This separation ensures no static cycles while keeping vision machinery available where needed.

## Discord image ingest (Pass 3, 0.9.4-alpha)

When a villager shares an image in Discord, `ingestDiscordImages()` in `discord-gateway.js` [@discord-gateway-js] fetches the attachment at arrival time from the Discord CDN (`proxy_url`). Because Discord attachment URLs are signed and ephemeral, images must be fetched on arrival, not on read.

**Fetching and sizing**: Images are fetched with an 8-second timeout and bounded by `MEDIA_MAX_BYTES` (6 MB). They are downscaled via the media proxy's own resize params (long edge capped at 1568 pixels, matching the bound the browser applies client-side). No image library is added to the project — only the proxy's resize query parameters.

**Privacy gate**: Who gets ingested depends on the sender:
- Ward: always ingested
- Registered villager: yes (ingest preserves room context and speaker provenance)
- Stranger (not ward, no villager record): NEVER — their text flows through the audience gate but their bytes are not stored. This is the structural rule.

Images are saved through `saveAsset()` with `origin.surface='discord'`, `origin.speaker` (villager name; null for ward), and `audienceTag` (room's tag or 'ward-private'). A failed fetch appends `[image failed to load]` to the message content; it never blocks the turn.

**Caps**: `MAX_IMAGES_PER_MESSAGE` (4) per message. `discordMediaPerHour` (default 20, clamp [0,200]) guards busy rooms via an in-memory hourly counter (`_discordMediaHourly` Map, timestamps pruned to 1h window). A restart resets the counter harmlessly — it only guards against disk thrashing during a high-volume moment; the spec notes this is a constant unless tuning proves needed.

**Observe path + history**: `observeMessage()` ingest applies to lurked rooms too (images are present when finally turned to — threat-neutral, same as observing text). Both Discord history `.map()` blocks now preserve `attachments` beside the message string, so a past image message replays as a live image or a stand-in.

**Materialization wiring**: `materializeAttachments()` applies once to `handleTurn`'s assembled `apiMessages` (rides every tool round), fail-closed on the room's `visibleAudience` set for gated turns; ward turns don't gate. The `view_image` tool reaches the ward on Discord too: `composeDiscordTools()` now threads `visionCapable` → `composeActiveTools()` options (computed via `resolveVisionCapable(conn, settings)` in `handleTurn()`).

**Off-switch**: `PROTO_FAMILIAR_VISION_DISABLED=1` or `visionEnabled=false` ignores attachments as before. `discordVisionOff()` gates both ingest and materialization.

**Import structure**: `discord-gateway.js` imports `saveAsset` + caps from `media.js` and `materializeAttachments` + `resolveVisionCapable` from `vision.js`. No cycle: `media.js` and `vision.js` do not import `discord-gateway.js`.

## Video media (0.11.33 – 0.11.40)

Video rides the exact rails [Message attachments ride beside content](../decisions/message-attachments-format) predicted for a future modality: `message.content` stays a string, video is another `attachments` entry, and `materializeAttachments()` stays the one seam that turns a stored reference into a provider content-part [@video-build-spec]. "A video-capable model is a change here, not a message-format migration" is that decision's own framing, now exercised.

**Store.** `media.js` adds a `video` kind: `VIDEO_MIME_EXT` recognizes mp4/webm/mov/mkv/mpeg/3gp, folded into the shared `MEDIA_KINDS` table alongside images and audio [@media-js]. Two separate byte ceilings apply to the same asset: `VIDEO_MAX_BYTES` (20 MB) is the **inline-eligibility** cap — base64-encoding a bigger clip would blow the provider request-size cap — while `VIDEO_STORE_MAX_BYTES` (300 MB) is what the store will accept onto disk at all, so a long clip destined for upload has somewhere to live before it is ever sent anywhere [@media-js]. `buildStandin()` gained a video voice ("what I saw when I watched" / "I haven't watched this one yet" / "I have no way to watch videos right now") [@video-build-spec].

**Materializer.** `resolveVideoCapable(connection, settings)` in `vision.js` decides whether a video rides live: a ward per-connection `videoCapable` tri-state (`'yes'`/`'no'`/`auto`) takes priority, and `auto` falls back to `looksVideoCapable()`, a name-based allowlist [@vision-js]. `DEFAULT_MAX_LIVE_VIDEOS` fixes the live-video budget at 1 per turn (newest-first), tighter than the 4-image budget, because a wrong live attempt ships megabytes rather than kilobytes [@vision-js]. A live video becomes a `{type:'video_url', video_url:{url:'data:...'}}` content part; anything over budget or on a non-video-capable connection degrades to a text stand-in, reusing the same blind-confabulation guard images use [@vision-js].

**`looksVideoCapable()` is deliberately tighter than its vision counterpart.** [Vision capability defaults to BLIND](../decisions/vision-capability-defaults) already established the asymmetry principle — default ambiguous cases toward the cheap-to-be-wrong branch, require positive evidence before the expensive-to-be-wrong branch — for images. Video inherits that principle and tightens it further: the allowlist recognizes only names it actually knows (Gemini, Qwen-VL, GLM-V/GLM 5.3 Flash, an explicit `-video` suffix), and any provider whose model-name space is too large to pattern-match (NanoGPT, which proxies many underlying models under one connection) relies entirely on the ward's explicit `'yes'` rather than a name guess [@video-build-spec].

**Ingress.** `POST /api/media` accepts `video/*` bodies alongside `image/*` and `audio/*` [@server-js]. The web composer attaches raw video (no client-side downscale, unlike images) up to the applicable cap and renders a `<video>` thumbnail chip; because `materializeAttachments()` already runs on every chat turn, a video attachment needs no per-surface wiring to reach the model [@video-build-spec].

**Discord video ingest (0.11.34-alpha).** `ingestDiscordImages()` in `discord-gateway.js` became `ingestDiscordMedia()`, which also fetches video attachments raw (no resizer — video isn't proxy-resizable the way images are) at arrival time, capped to `VIDEO_MAX_BYTES` and gated by the same ward-always/villager-yes/stranger-never audience rule and per-message + hourly caps images use [@discord-gateway-js]. `isDiscordVideoAttachment()` detects a video by MIME type or, when Discord reports `application/octet-stream`, by file extension; an over-cap clip is skipped by its declared size before any bytes are downloaded [@discord-gateway-js].

**Connection-editor tri-state (0.11.36-alpha).** A "Can watch video?" Auto/Yes/No control sits under the vision one in the Connections editor and is stored on the connection object (`conn.videoCapable`) [@video-build-spec]. This is the robust answer to "which models take video": `looksVideoCapable()`'s Auto only recognizes the families it knows by name, so a ward on a proxy provider like NanoGPT pins their confirmed video-capable connection to `Yes` explicitly rather than waiting on a heuristic that structurally cannot cover an unbounded model space [@video-build-spec].

**Provider reality: `video_url` is not universal.** Every inline chat request goes through the OpenAI chat-completions shape (`providers.js`), even Google's Gemini via its `.../openai/chat/completions` compatibility endpoint [@providers-js]. There is no universal `video_url` content part in that shape: Qwen/DashScope and Zhipu's GLM-V/GLM 5.3 Flash accept it on their OpenAI-compat gateways, but Google's own compat layer does not — native Gemini instead wants `inline_data`/`file_data` on a different, non-OpenAI-compat endpoint [@video-build-spec]. So the inline path is honest but provider-dependent: it works wherever `video_url` is accepted (Qwen-VL, GLM-V, and video models proxied through NanoGPT) and degrades cleanly to a text stand-in everywhere else, via the existing modality-reject fallback [@video-build-spec]. GLM's video contract was checked against z.ai's own API reference and the MetaGLM cookbook: the same `{type:'video_url', video_url:{url:...}}` shape, with a 200 MB provider-side size limit well above the 20 MB inline cap — leaving a 20–200 MB GLM clip unreachable by either path today, a documented gap rather than a bug, since the File-API upload path below is Gemini-only [@video-build-spec].

## The File-API path for long clips (Gemini-only, 0.11.35-alpha)

A clip too big to inline (over `VIDEO_MAX_BYTES` but under the 300 MB store ceiling) cannot ride the OpenAI-compat `video_url` part at all; each provider that supports longer video has its own upload-and-reference flow, and only Google's is built. The path is deliberately isolated rather than folded into the shared chat handler, the same posture [CDP mode](../decisions/browser-cdp-mode) takes for a capability whose live behavior cannot be exercised from CI [@video-build-spec]:

- **`gemini-file-api.js`** is a new, standalone module; every exported function takes an injectable `fetchFn` for testability [@gemini-file-api-js]. `uploadVideoToGemini()` drives Gemini's resumable upload (start → upload+finalize → poll `files.get` until `ACTIVE`); `toGeminiRequest()` translates the OpenAI-ish chat history into Gemini's native `contents` shape (system → `system_instruction`, assistant → `model`, the `file_data` reference attached to the final user turn); `generateWithGeminiFile()` calls the native `models/<model>:generateContent` endpoint (not the OpenAI-compat one); `answerAboutVideo()` orchestrates the three. Every failure path returns `{ok:false}` rather than throwing, so a caller always has a defined fallback [@gemini-file-api-js].
- **A dedicated endpoint, not `/api/chat`.** `POST /api/video-understand {assetId, prompt, provider, model, apiKey}` in `server.js` is a separate route from the streaming/tool-loop chat handler, so a bug in the Gemini upload/poll cycle has zero blast radius on the main turn path [@server-js]. It is default-off (`videoFileApiEnabled`), ward-only, gated by `PROTO_FAMILIAR_VIDEO_DISABLED=1`, and validates that the target connection is actually Gemini before calling out [@server-js].
- **Client surface.** A too-big-to-inline pending video shows a "Watch full clip" button; clicking it posts to the endpoint (the composer's typed text becomes the prompt) and the answer lands in the chat as a normal turn. A non-Gemini primary connection is refused with an explicit message rather than silently misrouting [@video-build-spec].
- **Live shakeout still open.** Every piece above is unit-tested against a stubbed Google backend, but the real resumable-upload round-trip has not been exercised against Gemini's live API — it needs the ward's own key, the same class of gap [CDP mode](../decisions/browser-cdp-mode) records for its own live attach-and-drive [@video-build-spec].

**Known follow-ups, named rather than silently deferred**: Discord has no long-video path (the endpoint is web-only); the File-API answer is one non-streaming turn, not wired into the tool-call loop; no other provider has an uploader behind the same seam yet; a stood-in long clip has no describe/thumbnail step [@video-build-spec].

## Known gaps in video (v1)

There is no video-describe path: `describeAsset()` is image-only, so a stood-in video carries only its marker text and the don't-invent guard, never a semantic description. Frame-extraction-based description would need an `ffmpeg` dependency the project has deliberately avoided for images (see the pure-JS image-dimension reading above) and is left for a later pass [@video-build-spec].

**`describeAsset()` refuses non-image assets at the door (0.11.39).** Before this fix, a shared video on a blind connection reached the synchronous describe path anyway: `ensureDescribed()` queued it, the resolved connection's image analyzer received the video's bytes, and the request came back `HTTP 400 图片输入格式/解析错误` (image parse error) — reported on both web and on a z.ai coding-plan connection, where the analyzer is the `analyze_image` MCP tool (GLM-4.6V), an image-only tool [@video-build-spec]. `describeAsset()` now checks `meta.kind` before touching any connection and returns `{ok:false, reason:'not-image'}` for any non-image kind; a missing `kind` (a legacy pre-video image asset) still passes through untouched [@vision-js]. `ensureDescribed()` skips non-image attachments so a video is never even queued. `tests/vision.test.mjs` pins the `not-image` return, proven red before the guard existed [@vision-js].

## z.ai Coding Plan vision allotment (0.9.5-alpha, PR #220)

The z.ai Coding Plan delivers vision through a separate, quota-isolated channel: a "Vision Understanding" MCP server (`@z_ai/mcp-server`, powered by GLM-4.6V) with its own 5-hour prompt resource pool, distinct from the coding-prompt allotment [@zai-vision-js]. The `zai-coding` provider connects to `https://api.z.ai/api/coding/paas/v4/chat/completions` [@providers-js].

A `zai-coding` connection can DESCRIBE images via this allotment, even though its chat models (GLM-4.6, GLM-5.2) cannot see live `image_url` parts [@zai-vision-js]. The `describeAsset()` path checks `conn.provider === 'zai-coding'` and routes to `describeViaZaiVision()` instead of `callProviderChat` [@vision-js], using dynamic import to keep the MCP spawn out of vision.js's static graph [@vision-js].

**The MCP client** (`zai-vision.js`) lazily spawns `@z_ai/mcp-server` as a stdio child (via StdioClientTransport, the same SDK Phylactery/Unruh use), keyed by API key (respawning on key change) with env `Z_AI_API_KEY` + `Z_AI_MODE=ZAI` [@zai-vision-js]. The server is installed on first use via `npx -y` and the spawn command is overridable via `PROTO_FAMILIAR_ZAI_MCP_COMMAND` (used by tests to avoid a real spawn) [@zai-vision-js]. The client discovers the `analyze_image` tool and its `inputSchema` at connect time, adapting the tool call to whatever parameter names the server uses — a `path` field → temp file on disk, a `url` field → data URL, a `base64` field → raw base64 — and filling a prompt-shaped parameter with the first-person describe prompt [@zai-vision-js].

**Graceful**: any spawn/connect/call failure returns `{ok:false}`, leaving the image description null (retried later) and never breaking the chat turn [@zai-vision-js]. Off-switch: `PROTO_FAMILIAR_ZAI_VISION_DISABLED=1` [@zai-vision-js]. Shutdown is wired into `server.js` via dynamic import [@zai-vision-js].

**Live capability is by MODEL, not blanket-blind (0.11.40).** `resolveVisionCapable()` and `resolveVideoCapable()` used to hard-block every `zai-coding` connection, on the assumption that coding-plan chat models are text-only. That blanket block was wrong for GLM 5.3 Flash — the first natively-multimodal GLM-5 — which takes live `image_url` and `video_url` parts on the SAME OpenAI-compat chat surface as standard z.ai; the coding endpoint (`/api/coding/paas/v4/chat/completions`) differs only in URL path and quota pool, not request shape [@video-build-spec]. `looksVisionCapable()`/`looksVideoCapable()` now match `glm-?5[.\d]*-?flash` (GLM 5.3 Flash) and `resolveVisionCapable()`/`resolveVideoCapable()` no longer short-circuit on `provider === 'zai-coding'`; they fall through to the ward tri-state and the name heuristic like any other provider [@vision-js]. Older text/code coding models (bare GLM-4.6) still fail the heuristic and stay blind, routing images to the image-only `analyze_image` describe MCP as before; a ward `'yes'` on either tri-state forces a coding connection they've confirmed. This is what closed the reported gap: the ward could confirm GLM 5.3 Flash watched video on the coding plan, but the code was blocking it categorically. `tests/vision.test.mjs` pins `resolveVisionCapable`/`resolveVideoCapable` returning `true` for a `glm-5.3-flash` `zai-coding` connection and `false` for a bare `glm-4.7` one [@vision-js].

This is separate from describe-capability: `isDescribeCapable()` still returns `true` for every `zai-coding` connection regardless of model, because even a blind coding model can describe through the Vision MCP [@vision-js].

**Net effect**: a ward on the Coding Plan with an older text/code coding model assigned to vision gets every image DESCRIBED via the coding vision allotment, then read as a text stand-in. A ward with a GLM 5.3 Flash coding connection gets live `image_url`/`video_url` parts on that same connection — no separate pay-as-you-go vision key needed either way [@vision-js]. The 0.11.39 `not-image` describe guard (see Known gaps in video above) still applies underneath this as defense-in-depth: even a blind coding model's shared video never reaches the image-only describe MCP [@video-build-spec].

**Unverified**: the real @z_ai/mcp-server spawn was NOT tested end-to-end (requires a coding key + network access) [@zai-vision-js]. Built defensively with runtime schema discovery and graceful degradation; the `analyze_image` param name/shape is the main unknown. All failures degrade to `description=null`, never breaking the chat path.

## Image descriptions feeding threat scoring

Starting in 0.9.2-alpha (PR #219), image descriptions are also consumed by the safety spine: `scoreImageDescriptionThreat()` scores the description using the same crisis-signals pattern matcher that scores typed text, then feeds any positive delta through `recordThreat()` with `source:'vision'` [@vision-js]. The mechanism is orchestration around existing `crisis-signals.js` and `threat-tracker.js`; neither scorer nor tracker changed [@vision-js]. Three constraints are ward-signed: full weighting (image signals count the same as typed distress, no damping), raise-only (images can only increase threat, never lower it), and ward-images-only (only images marked `audienceTag === 'ward-private'` move threat, so villagers' shared bytes never alter the ward's safety state) [@vision-js].

The feature is known to false-positive on fictional violence (horror film stills, dark artwork) until interpretation can be context-aware. De-escalation from positive images is also deferred until descriptions are confident enough to trust [@vision-js]. Full details of the ward-signed design decisions and deferred work are in [Safety spine](../architecture/safety-spine).

## Vision milestone status

- **Pass 1** (0.9.0): introductory vision spine
- **Pass 2** (0.9.1): sight-for-everything + picture→node linking
- **Pass 2 tail** (0.9.3): composer tag UI + node graduation
- **Image threat scoring** (0.9.2): image descriptions consumed by the safety spine
- **Pass 3** (0.9.4): Discord image ingest
- **z.ai Coding Plan vision allotment** (0.9.5-alpha, PR #220): describe-only vision via z.ai's Vision MCP for the Coding Plan quota
- **Synchronous describe-before-reply** (0.9.38-alpha): `ensureDescribed()` describes a blind
  connection's undescribed images before the prompt is assembled, so the stand-in the model reads
  on THIS turn carries a real description instead of "not yet described" [@vision-js]. The web
  chat path got this wiring first; Discord initially did not, a gap named
  [RULE C](../reference/engineering-conventions) in CLAUDE.md's operating rules, fixed in 0.9.6
  [@claude-md].
- **Video inline core** (0.11.33-alpha): a `video` media kind, tight video-capability detection,
  and Discord video ingest (0.11.34).
- **Connection-editor video tri-state** (0.11.36-alpha) and **Gemini File-API path for long clips**
  (0.11.35-alpha, live shakeout still pending) — see Video media above [@video-build-spec].
- **GLM video contract verified + describe-guard fix** (0.11.37, 0.11.39): confirmed against
  z.ai's own API reference and the MetaGLM cookbook, and closed the video-through-image-describer
  400 by making `describeAsset()` refuse non-image assets — see Known gaps in video above
  [@video-build-spec].
- **z.ai coding-plan vision/video by model, not blanket-blind** (0.11.40): GLM 5.3 Flash watches
  image and video live on the coding plan; older coding models stay blind and describe-only — see
  the z.ai Coding Plan section above [@video-build-spec].

Later passes (group-call presence, voiceprint enrolment, room-sound tagging) belong to the voice
milestone rather than this one; see [Voice](voice) for those.

## Deferred work

Two ward-flagged threat-scoring refinements remain (out of the main spec):

1. **Horror/fiction context exception**: Currently, the system can false-positive on fictional violence (horror film stills, dark artwork). Full weight applies to all image descriptions equally. Future work would allow context-aware interpretation to weight fictional vs. real scenarios differently.
2. **Context-aware de-escalation**: Images can only raise threat (raise-only), never lower it. De-escalation from positive images is deferred until descriptions are confident enough to trust. Full details in [Safety spine](../architecture/safety-spine).

## Related

- [Vision capability defaults](../decisions/vision-capability-defaults) — the design decision to default unknown models to BLIND and require allowlist proof before sending images live; video's tighter allowlist and one-live-clip budget extend the same asymmetry principle
- [Message format and attachments](../decisions/message-attachments-format) — the design decision to keep `message.content` as a plain string and ride media beside it; video is the modality expansion that decision predicted
- [Graceful degradation](../reference/engineering-conventions) — the repo-wide principle this subsystem follows
- [Safety spine](../architecture/safety-spine) — threat detection, tracking, and escalation; now includes image-derived signals
- [CDP mode](../decisions/browser-cdp-mode) — the same code-is-shipped-but-live-path-unverified posture the Gemini File-API path is in, both needing a ward desktop shakeout before the untested piece can be trusted
