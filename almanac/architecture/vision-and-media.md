---
title: Vision and Media Input
topics: [architecture, vision]
sources:
  - id: media-js
    type: file
    path: media.js
  - id: vision-js
    type: file
    path: vision.js
  - id: zai-vision-js
    type: file
    path: zai-vision.js
  - id: slug-ids-js
    type: file
    path: slug-ids.js
  - id: server-js
    type: file
    path: server.js
  - id: memorization-js
    type: file
    path: memorization.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: discord-gateway-js
    type: file
    path: discord-gateway.js
  - id: providers-js
    type: file
    path: providers.js
  - id: claude-md
    type: file
    path: CLAUDE.md
---

# Vision and Media Input

Proto-Familiar 0.9.0 introduces multimodal image input, letting the ward send images to the Familiar alongside messages. The vision system is built in layers: a content-addressed media store (`media.js`), a materialization seam (`vision.js`) that converts stored attachments into provider-consumable image data at chat time, and graceful degradation when modality is not available.

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

## z.ai Coding Plan vision allotment (0.9.5-alpha, PR #220)

The z.ai Coding Plan delivers vision through a separate, quota-isolated channel: a "Vision Understanding" MCP server (`@z_ai/mcp-server`, powered by GLM-4.6V) with its own 5-hour prompt resource pool, distinct from the coding-prompt allotment [@zai-vision-js]. The `zai-coding` provider connects to `https://api.z.ai/api/coding/paas/v4/chat/completions` [@providers-js].

A `zai-coding` connection can DESCRIBE images via this allotment, even though its chat models (GLM-4.6, GLM-5.2) cannot see live `image_url` parts [@zai-vision-js]. The `describeAsset()` path checks `conn.provider === 'zai-coding'` and routes to `describeViaZaiVision()` instead of `callProviderChat` [@vision-js], using dynamic import to keep the MCP spawn out of vision.js's static graph [@vision-js].

**The MCP client** (`zai-vision.js`) lazily spawns `@z_ai/mcp-server` as a stdio child (via StdioClientTransport, the same SDK Phylactery/Unruh use), keyed by API key (respawning on key change) with env `Z_AI_API_KEY` + `Z_AI_MODE=ZAI` [@zai-vision-js]. The server is installed on first use via `npx -y` and the spawn command is overridable via `PROTO_FAMILIAR_ZAI_MCP_COMMAND` (used by tests to avoid a real spawn) [@zai-vision-js]. The client discovers the `analyze_image` tool and its `inputSchema` at connect time, adapting the tool call to whatever parameter names the server uses — a `path` field → temp file on disk, a `url` field → data URL, a `base64` field → raw base64 — and filling a prompt-shaped parameter with the first-person describe prompt [@zai-vision-js].

**Graceful**: any spawn/connect/call failure returns `{ok:false}`, leaving the image description null (retried later) and never breaking the chat turn [@zai-vision-js]. Off-switch: `PROTO_FAMILIAR_ZAI_VISION_DISABLED=1` [@zai-vision-js]. Shutdown is wired into `server.js` via dynamic import [@zai-vision-js].

**Live capability**: `resolveVisionCapable()` returns `false` for `zai-coding` (the coding chat models cannot see images on the wire), so images always degrade to stand-ins in the live turn [@vision-js]. This is separate from describe-capability: `isDescribeCapable()` returns `true` for `zai-coding` because it can describe through the Vision MCP [@vision-js].

**Net effect**: a ward on the Coding Plan assigns their `zai-coding` connection to the vision feature → every image is DESCRIBED via the coding vision allotment, then read as a text stand-in, on z.ai's quota rather than a separate pay-as-you-go vision key [@vision-js].

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

Later passes (group-call presence, voiceprint enrolment, room-sound tagging) belong to the voice
milestone rather than this one; see [Voice](voice) for those.

## Deferred work

Two ward-flagged threat-scoring refinements remain (out of the main spec):

1. **Horror/fiction context exception**: Currently, the system can false-positive on fictional violence (horror film stills, dark artwork). Full weight applies to all image descriptions equally. Future work would allow context-aware interpretation to weight fictional vs. real scenarios differently.
2. **Context-aware de-escalation**: Images can only raise threat (raise-only), never lower it. De-escalation from positive images is deferred until descriptions are confident enough to trust. Full details in [Safety spine](../architecture/safety-spine).

## Related

- [Vision capability defaults](../decisions/vision-capability-defaults) — the design decision to default unknown models to BLIND and require allowlist proof before sending images live
- [Message format and attachments](../decisions/message-attachments-format) — the design decision to keep `message.content` as a plain string and ride media beside it
- [Graceful degradation](../reference/engineering-conventions) — the repo-wide principle this subsystem follows
- [Safety spine](../architecture/safety-spine) — threat detection, tracking, and escalation; now includes image-derived signals
