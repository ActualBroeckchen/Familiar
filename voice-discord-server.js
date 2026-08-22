/**
 * voice-discord-server.js — wires the Discord voice adapter (Pass 3) to a call
 * engine and exposes join/leave, the mirror of `attachVoiceCall` for the web.
 *
 * It owns nothing platform-specific of its own: the transport is
 * `voice-discord-adapter.js`, the ASR/TTS workers are the SAME ones the web call
 * path uses (injected), and the spine is `call-engine.js` unchanged. This module
 * is just the glue — register the adapter, start/stop the one call, forward the
 * gateway's roster events, and run the turn.
 *
 * Pass 3b (ward-signed §5): the ward's voice runs a real ward-private turn; a
 * REGISTERED VILLAGER's voice runs a turn gated to the ROOM's audience (recall
 * scoped, ward-private withheld, the outgoing filter applied — all by /api/chat
 * when sessionAudience is the room input), stored at the room's tag, and given NO
 * ward-private history. A STRANGER (unregistered speaker) is transcribed for the
 * log but never answered or stored (fail-closed). Threat scoring stays ward-only
 * (the turn-runner gates it). Memorization is split per audience tag so nothing
 * is stored above its clearance. The gated turn carries no tools (a villager
 * can't drive tool writes by voice — the safe bound; text keeps its tool gate).
 *
 * Graceful degradation: the transport deps are loaded lazily at join, so a
 * missing/failed install (or the env off-switch) makes a join return a reason,
 * never crash the gateway or the chat path.
 */

import path from 'node:path';

import { createCallEngine, isCallActiveFromFile, isCallActiveFromFileSync } from './call-engine.js';
import { createDiscordCallAdapter, loadDiscordVoiceDeps } from './voice-discord-adapter.js';
import { discordVoiceAdapterCreator, setVoiceRosterListener, discordVoiceChannelMembers, discordBotUserId, findWardVoiceChannel, discordVoiceDisplayName } from './discord-gateway.js';
import { resolveCallAudience, wardVoiceState } from './voice-call-audience.js';
import { createTagSegment, createRoomListenerMap } from './voice-tagging.js';
import { registerPushAdapterFactory, formatItemForPush } from './cerebellum.js';
import { findVillagerByAlias, getRegistry, villagerByAlias } from './village.js';
import {
  isGroupCall, attributeSpeaker, prefixTurn, diffRoster,
  formatPresenceNote, buildGreetingPrompt, parseGreeting,
} from './voice-presence.js';
import { callProviderChat } from './llm-call.js';
import { substituteMacros } from './macros.js';
import { audienceTagFor } from './audience.js';
import { createSynthesizer } from './voice-synthesize.js';
import { createVoiceChatTurn } from './voice-chat-turn.js';
import { createVoiceTurnRunner } from './voice-call-turn.js';
import { voiceThreatEnabled } from './voice-call-server.js';
import { speakableText, isLikelyNoiseTranscript } from './voice-speech.js';
import { scoreMessage } from './crisis-signals.js';
import { recordThreat, getThreat, THREAT_TIERS } from './threat-tracker.js';
import { enqueueSessionByDay } from './memorization.js';
import { writeSessionLog, stampMessages, turnMessages } from './session-log.js';
import { slugifyLabel, sessionSlugId } from './slug-ids.js';
import { MODELS_SUBDIR } from './voice-fetch.js';
import { ASR_MODEL_DIR, voiceOfflineAsrEnabled, ensureOfflineAsrModel, voiceCallSettleMs } from './voice-transcribe.js';

/** Hard off-switch — same pattern as every other loop/feature. */
export function discordVoiceDisabled() {
  return process.env.PROTO_FAMILIAR_DISCORD_VOICE_DISABLED === '1';
}

function asrLang(settings) {
  const l = String(settings?.voiceAsrLanguage ?? 'en').toLowerCase().trim();
  return /^[a-z]{2}$/.test(l) ? l : 'en';
}

/**
 * @param {object}   deps
 * @param {string}   deps.rootDir
 * @param {number}   deps.port                    the local server port (for the /api/chat turn)
 * @param {function} deps.readSettings
 * @param {function} deps.getListeningWorker      () => worker | Promise<worker>  (ASR — shared with web)
 * @param {function} deps.getTtsWorker            () => Promise<worker>           (TTS — shared with web)
 * @param {function} deps.resolveVoiceForSettings (settings) => Promise<voice>
 * @param {function} deps.ensureTtsLoaded         (worker) => Promise<{ok, sampleRate}>
 * @param {function} deps.connectionForFeature    (settings, feature) => {provider, apiKey, model}
 * @param {function} [deps.log]
 * @returns {{ joinVoiceCall, leaveVoiceCall, isCallActive }}
 */
export function attachDiscordVoice(deps) {
  const {
    rootDir, port, readSettings, getListeningWorker, getTtsWorker,
    resolveVoiceForSettings, ensureTtsLoaded, connectionForFeature,
    log = (m) => console.log(`[discord-voice] ${m}`),
  } = deps;

  const synthesize = createSynthesizer({ readSettings, getTtsWorker, resolveVoiceForSettings, ensureTtsLoaded, log });
  const runVoiceChatTurn = createVoiceChatTurn({ port, readSettings, connectionForFeature, log });

  // Per-call state. A voice call is a SHARED audio space — every reply is spoken
  // aloud to everyone present — so the WHOLE call is gated to the room's audience
  // (the lowest clearance present), not per-speaker. `callHistory` is that one
  // shared conversation at the current clearance; `callTag` records the clearance
  // it was built at, so a roster change (someone joining and dropping the
  // clearance) resets it and a more-private stretch never re-surfaces to a
  // newcomer. `refToUser` maps a speaker slug to a Discord user id; `callMeta`
  // holds the room. All keyed by callId; one call at a time.
  const HISTORY_MAX = 20;
  const callHistory = new Map();        // callId → [{role,content}] at the current clearance
  const callTag = new Map();            // callId → audienceTag the history was built at
  const refToUser = new Map();          // speakerRef → discord user id
  const callMeta = new Map();           // callId → { guildId, channelId, locationKey, wardUserId }
  // Memorization sessions, one per AUDIENCE TAG the call passed through (a solo
  // stretch → ward-private, a stretch with villagers present → the room's tag), so
  // nothing is stored above the clearance it was actually said at.
  const memSessions = new Map();        // callId → Map<audienceTag, { sessionId, messages }>
  // Group-call presence (voice Pass 3 tail). `prevRosterIds` is the last-seen set
  // of present ids, for diffing joins/leaves; `presence` stages what changed +
  // whether the next turn should carry a "who's here" note; `greeted` dedups the
  // proactive hello so an arrival is greeted once per stay, not on every roster
  // wobble. All keyed by callId.
  const prevRosterIds = new Map();      // callId → Set<userId> present as of the last roster read
  const presence = new Map();           // callId → { dirty, joined:[names], left:[names] }
  const greeted  = new Map();           // callId → Set<userId> already greeted this stay

  // `speaker` attributes the user turn — a group call's room session mixes
  // several villagers, so a bare "user" would lose who said what. The ward
  // speaks unattributed (null), exactly like Discord text.
  function accumulate(callId, audienceTag, userMsg, assistantMsg, speaker = null) {
    let byTag = memSessions.get(callId);
    if (!byTag) { byTag = new Map(); memSessions.set(callId, byTag); }
    let sess = byTag.get(audienceTag);
    if (!sess) { sess = { sessionId: sessionSlugId(), messages: [], startedAt: Date.now() }; byTag.set(audienceTag, sess); }
    sess.messages.push(...turnMessages(userMsg, assistantMsg, { speaker }));
  }

  // Resolve the audience a turn is gated to — the lowest clearance of everyone
  // who can HEAR (the live VC roster). Pure decision in voice-call-audience.js;
  // here we inject the real roster, the villager lookup, and the tag resolver.
  async function callAudience(meta) {
    const registry = await getRegistry().catch(() => null);
    return resolveCallAudience({
      members:        meta ? discordVoiceChannelMembers(meta.guildId, meta.channelId) : [],
      wardUserId:     meta?.wardUserId,
      botId:          discordBotUserId(),
      resolveVillager: (uid) => findVillagerByAlias({ platform: 'discord', id: uid }),
      resolveTag:     (input) => (registry ? audienceTagFor(input, registry) : null),
      location:       meta?.locationKey ?? null,
    });
  }

  // ── Group-call presence (voice Pass 3 tail) ─────────────────────────────
  // Off-switches: the whole presence/attribution layer (a correctness fix,
  // on by default) drops back to the old unlabelled behaviour under the env
  // flag; the proactive spoken hello is separately gated (ward toggle + env)
  // because it's the one piece that makes me SPEAK unprompted.
  const presenceEnabled  = () => process.env.PROTO_FAMILIAR_VOICE_PRESENCE_DISABLED !== '1';
  const greetingsEnabled = () =>
    process.env.PROTO_FAMILIAR_VOICE_GREETINGS_DISABLED !== '1'
    && readSettings()?.voiceProactiveGreetings !== false;

  const botId = () => discordBotUserId();
  const wardName = () => (readSettings()?.userName || '').trim() || 'my human';

  // Resolve a set of Discord ids to names in ONE registry read (villager name
  // wins, else the cached Discord display name, else a short opaque tag). Used
  // for the roster and for naming who joined/left.
  async function nameMap(ids, meta) {
    const reg = await getRegistry().catch(() => null);
    const wn = wardName();
    const out = new Map();
    for (const id of ids) {
      if (meta?.wardUserId && id === meta.wardUserId) { out.set(id, { name: wn, isWard: true }); continue; }
      const v = reg ? villagerByAlias(reg, { platform: 'discord', id }) : null;
      out.set(id, { name: v?.name || discordVoiceDisplayName(id) || `guest-${String(id).slice(0, 6)}`, isWard: false });
    }
    return out;
  }

  // The humans in the call right now (bot excluded), named. One reg read.
  async function namedRoster(meta) {
    const ids = (meta ? discordVoiceChannelMembers(meta.guildId, meta.channelId) : []).filter(id => id !== botId());
    const names = await nameMap(ids, meta);
    return ids.map(id => ({ id, ...names.get(id) }));
  }

  // A VOICE_STATE_UPDATE landed. Diff the roster, stage the join/left names for
  // the next turn's presence note, and (if enabled) fire a proactive hello that
  // rides the engine's next-silence gap — so it never talks over someone who is
  // mid-sentence as the join happens. Fully guarded; never throws into the loop.
  async function onRosterChange() {
    if (!presenceEnabled()) return;
    const callId = engine.currentCallId();
    const meta = callId ? callMeta.get(callId) : null;
    if (!callId || !meta) return;

    const presentIds = (discordVoiceChannelMembers(meta.guildId, meta.channelId) || []).filter(id => id !== botId());
    const prev = prevRosterIds.get(callId) ?? new Set();
    const { joined, left } = diffRoster([...prev], presentIds);
    prevRosterIds.set(callId, new Set(presentIds));
    if (!joined.length && !left.length) return;

    const names = await nameMap([...new Set([...presentIds, ...joined, ...left])], meta);
    const nameOf = (id) => names.get(id)?.name || 'someone';

    const pend = presence.get(callId) ?? { dirty: false, joined: [], left: [] };
    for (const id of joined) pend.joined.push(nameOf(id));
    for (const id of left)   pend.left.push(nameOf(id));
    pend.dirty = true;
    presence.set(callId, pend);

    // A rejoin should greet again — forget anyone who left.
    const seen = greeted.get(callId) ?? new Set();
    for (const id of left) seen.delete(id);
    greeted.set(callId, seen);

    // Proactive hello — non-ward arrivals only (my human's own presence is the
    // call itself, not a guest to greet), deduped per stay, stood down under
    // distress (triage owns those moments, not small talk).
    if (greetingsEnabled()) {
      for (const id of joined) {
        if (meta.wardUserId && id === meta.wardUserId) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        greetArrival(callId, nameOf(id)).catch(err => log(`greet failed: ${err?.message ?? err}`));
      }
    }
  }

  // Compose a short, in-voice hello and speak it at the next quiet gap. Leak-free
  // (the prompt names only who arrived — no recall), so it's safe to say aloud to
  // the whole channel regardless of clearance. Recorded into the shared call
  // history once actually spoken, so I know I already greeted them.
  async function greetArrival(callId, name) {
    const s = readSettings();
    const threat = await getThreat({ tomesDir: path.join(rootDir, 'tomes') }).catch(() => ({ weight: 0 }));
    if ((threat?.weight ?? 0) >= THREAT_TIERS.moderate) return;   // stand down under distress
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!(conn?.apiKey && conn?.provider && conn?.model)) return;
    const prompt = substituteMacros(buildGreetingPrompt({ name, event: 'joined' }), s);
    const raw = await callProviderChat({ provider: conn.provider, apiKey: conn.apiKey, model: conn.model, prompt, temperature: 0.8, maxTokens: 2000 });
    const line = parseGreeting(raw);
    if (!line || !engine.isCallActive() || engine.currentCallId() !== callId) return;
    const spoken = await engine.speakProactive(() => synthesize(line));
    if (spoken) {
      const hist = callHistory.get(callId);
      if (Array.isArray(hist)) { hist.push({ role: 'assistant', content: line }); callHistory.set(callId, hist.slice(-HISTORY_MAX)); }
    }
  }

  // ── The turn (Pass 3b, ward-signed §5) ──────────────────────────────────
  // WARD: a real ward-private turn (full context). REGISTERED VILLAGER: a turn
  // gated to the ROOM's audience — recall scoped, ward-private withheld, the
  // outgoing filter applied (all by /api/chat when sessionAudience is the room
  // input), stored at the room's tag, and given NO ward-private history. STRANGER
  // (unregistered speaker): transcribed for the log but never answered or stored
  // (fail-closed). Threat scoring stays ward-only (the runner gates it).
  async function runTurn(transcript, ctx) {
    const heard = String(transcript ?? '').trim();
    if (!heard) return null;
    const meta = callMeta.get(ctx.callId);
    const isWard = ctx?.speakerRef === 'ward';

    // Resolve a non-ward speaker — for attribution and the stranger fail-close.
    // The ward is always answered; an unregistered non-ward speaker never is. This
    // is the ONLY thing keyed on WHO spoke; the audience below is keyed on who can
    // HEAR, which in a shared voice channel is everyone present.
    let speakerName = null;
    if (!isWard) {
      const userId = refToUser.get(ctx.speakerRef);
      let villager = null;
      try { villager = userId ? await findVillagerByAlias({ platform: 'discord', id: userId }) : null; } catch { /* treat as stranger */ }
      if (!villager || !meta) {
        log(`heard from ${ctx?.speakerRef ?? '?'} (unregistered) — not answered (stranger, fail-closed)`);
        return null;
      }
      speakerName = villager.name;
    }

    // AUDIENCE = who can HEAR the reply. A voice call is a shared audio space — the
    // reply is spoken ALOUD to everyone in the channel — so every turn, ward or
    // villager, is gated to the room's audience: the lowest clearance present. Ward
    // alone in the channel → ward-private (like a ward DM); ANY villager present →
    // the room's tag (like a guild text channel). This matches the text model,
    // where a shared channel is room-gated regardless of speaker. Gating the ward's
    // own turn to ward-private — the old behaviour — spoke my human's private
    // recall aloud to the villagers who can hear; this closes that leak.
    const { audienceTag, sessionAudience } = await callAudience(meta);

    // One shared call history at the CURRENT clearance. If the clearance changed
    // (a roster change — someone joined or left), reset it so a more-private
    // stretch is never re-spoken to a newcomer.
    if (callTag.get(ctx.callId) !== audienceTag) { callHistory.set(ctx.callId, []); callTag.set(ctx.callId, audienceTag); }
    const hist = callHistory.get(ctx.callId) ?? [];

    // Group-call attribution: when 2+ humans share the call, prefix every turn
    // with WHO said it — my human included, so I can tell their turns from a
    // villager's (before this the transcript was a flat wall of "user" turns
    // tagged with raw snowflakes I can't distinguish). Solo → no prefix, so a
    // one-on-one call reads exactly as it did. The label rides both the live
    // transcript AND the stored call history, but NOT the memory write (that
    // carries the speaker as its own field).
    let attributedHeard = heard;
    const systemNotes = [];
    if (presenceEnabled()) {
      const roster = await namedRoster(meta);
      const group  = isGroupCall(roster);
      const label  = attributeSpeaker({ name: isWard ? wardName() : speakerName, isGroup: group, isWard });
      attributedHeard = prefixTurn(label, heard);

      // Presence note — surfaced once after a roster change (or at call start),
      // then it goes quiet until the next change. Annotation only: never stored,
      // never moves the threat tier — like the room-sound note below.
      const pend = presence.get(ctx.callId);
      if (pend?.dirty) {
        try {
          const note = formatPresenceNote({ roster, joined: pend.joined, left: pend.left });
          if (note) systemNotes.push(note);
        } catch (err) { log(`presence note failed: ${err?.message ?? err}`); }
        presence.set(ctx.callId, { dirty: false, joined: [], left: [] });
      }
    }

    // §8.4 room-sound annotation — a one-off "what I can hear" line, deduped per
    // call. Annotation only: never stored, never moves the threat tier.
    if (Array.isArray(ctx.roomSounds) && ctx.roomSounds.length) {
      try { const line = roomListeners.for(ctx.callId).note(ctx.roomSounds); if (line) systemNotes.push(line); }
      catch (err) { log(`room-sound note failed: ${err?.message ?? err}`); }
    }

    const turnHistory = systemNotes.length ? [...hist, ...systemNotes.map(content => ({ role: 'system', content }))] : hist;

    const reply = await runVoiceChatTurn({ transcript: attributedHeard, history: turnHistory, sessionAudience });
    if (reply) {
      callHistory.set(ctx.callId, [...hist, { role: 'user', content: attributedHeard }, { role: 'assistant', content: reply }].slice(-HISTORY_MAX));
      // Store the turn at the SAME tag the reply was gated to; attribute a
      // villager's turn to them, the ward's unattributed. The memory write takes
      // the RAW heard text — the speaker rides as its own field, not a prefix.
      accumulate(ctx.callId, audienceTag, heard, reply, speakerName);
    }
    return reply;
  }

  // D2 (ward-signed): the ward's spoken words can raise the threat tier. The
  // runner below gates this to speakerRef === 'ward', so a villager's voice never
  // moves my human's tier (spec §5 — threat scoring stays ward-only).
  async function scoreThreat(transcript) {
    const { level, signals } = scoreMessage(transcript);
    if (level > 0) await recordThreat({ delta: level, source: 'voice', signals });
  }

  // Reuse the web's turn-runner wrapper: threat-score (ward-only) → runTurn →
  // speakable → synthesize. Same orchestration + safety gate, one implementation.
  const onTurn = createVoiceTurnRunner({
    runTurn, synthesize,
    speakable: speakableText,
    scoreThreat,
    threatEnabled: () => voiceThreatEnabled(readSettings()),
    log,
  });

  // On hang-up, memorize each audience session at ITS OWN tag — the ward's turns
  // at ward-private, a villager's at the room's tag — so nothing is stored above
  // its clearance (the whole point of keeping them separate while the call ran).
  async function memorizeCall(callId) {
    const byTag = memSessions.get(callId);
    memSessions.delete(callId);
    if (!byTag) return;
    const s = readSettings();
    const conn = connectionForFeature(s, 'chat') || connectionForFeature(s, 'pondering');
    if (!(conn?.apiKey && conn?.provider && conn?.model)) { log('call ended but no connection to memorize it with'); return; }
    for (const [audienceTag, sess] of byTag) {
      if (!sess || sess.messages.length < 2) continue;
      // Land each audience segment as its OWN reviewable session log, STAMPED
      // with that segment's tag — a villager's segment lands at the room's tag,
      // never ward-private, so a log carries no more clearance than the turns in
      // it (the same per-tag split memorization uses). Then memorize.
      if (process.env.PROTO_FAMILIAR_VOICE_SESSION_LOG_DISABLED !== '1') {
        const endedIso = new Date().toISOString();
        const r = await writeSessionLog({
          sessionId:  sess.sessionId,
          startedAt:  new Date(sess.startedAt ?? Date.now()).toISOString(),
          endedAt:    endedIso,
          origin:     'voice-call-discord',
          audienceTag,
          provider:   conn.provider, model: conn.model,
          messages:   stampMessages(sess.messages, endedIso),
        }, { logsDir: path.join(rootDir, 'logs') });
        if (!r.ok) log(`session log (${audienceTag}) not written: ${r.reason}`);
      }
      try {
        const r = await enqueueSessionByDay({
          sessionId: sess.sessionId, messages: sess.messages,
          provider: conn.provider, apiKey: conn.apiKey, model: conn.model,
          audienceTag,
        });
        log(`voice call ${callId} ended — queued ${sess.messages.length} lines for memory at ${audienceTag} (${r.enqueued} enqueued, ${r.skipped} skipped)`);
      } catch (err) { log(`memorizeCall (${audienceTag}) failed: ${err?.message ?? err}`); }
    }
  }

  // A barge cut a reply short (2c). Annotate the call's last assistant turn with
  // what was actually heard, so the next spoken turn knows it was interrupted. The
  // interrupter could be anyone in the channel, so the marker is neutral (not
  // "my human"), and it rides the one shared call history.
  function onReplyInterrupted(ctx, { spokenUpTo }) {
    const hist = callHistory.get(ctx.callId);
    if (!Array.isArray(hist)) return;
    const heard = String(spokenUpTo ?? '').trim();
    const cut = heard ? `${heard} —[interrupted here]` : '[interrupted before I got a word out]';
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i]?.role === 'assistant') { hist[i].content = cut; break; }
    }
  }

  // Room-sound tagging (§8.4) — inert until the ward opts in AND the model is
  // installed. A per-call listener dedups so a persistent sound is named once.
  const tagSegment = createTagSegment({ getWorkerThen: (fn) => getWorkerThen(fn), readSettings, log });
  const roomListeners = createRoomListenerMap();

  const engine = createCallEngine({
    worker: {
      request: (...a) => getWorkerThen((w) => w.request(...a)),
      sendPcm: (...a) => getWorkerThen((w) => w.sendPcm(...a)),
      on: (l) => {
        let off = () => {};
        Promise.resolve(getListeningWorker()).then((w) => { if (w) off = w.on(l); }).catch(() => {});
        return () => off();
      },
    },
    onTurn,
    onReplyInterrupted,
    streamingModelDir: path.join(rootDir, MODELS_SUBDIR, `asr-streaming-${asrLang(readSettings())}`),
    offlineModelDir: ASR_MODEL_DIR,
    offlineFinal: () => voiceOfflineAsrEnabled(readSettings()),
    ensureOffline: () => ensureOfflineAsrModel({ rootDir, log }),
    // Coalesce sentences into one turn (don't reply over a longer thought) and
    // drop ambient-noise transcripts (traffic the recogniser heard as Chinese).
    turnSettleMs: () => voiceCallSettleMs(readSettings()),
    transcriptFilter: (t) => !isLikelyNoiseTranscript(t, { language: asrLang(readSettings()) }),
    tagSegment,   // §8.4 room-sound tagging (annotation only)
    tomesDir: path.join(rootDir, 'tomes'),
    log,
  });

  async function getWorkerThen(fn) {
    const w = await getListeningWorker();
    if (!w) return { ok: false, reason: 'no-worker' };
    return fn(w);
  }

  let activeAdapter = null;

  /**
   * Join a voice channel and go live. `nameForUser` resolves a user id to a
   * display name (for the speaker slug); `wardUserId` reserves 'ward' for my
   * human so only their voice can move the threat tier (Pass 2 D2).
   */
  async function joinVoiceCall({ guildId, channelId, wardUserId = '', nameForUser } = {}) {
    if (discordVoiceDisabled()) return { ok: false, reason: 'disabled' };
    if (!guildId || !channelId) return { ok: false, reason: 'bad-target' };
    if (engine.isCallActive()) return { ok: false, reason: 'busy', callId: engine.currentCallId() };
    // One voice connection at a time across BOTH transports — don't join a
    // Discord VC while a web call is live (they'd fight over the call-state file
    // and the single ASR/TTS worker). The governor read is fail-safe.
    if (await isCallActiveFromFile(path.join(rootDir, 'tomes'))) return { ok: false, reason: 'busy-other-transport' };

    const voiceDeps = await loadDiscordVoiceDeps({ log }).catch((err) => { log(`voice deps unavailable: ${err?.message ?? err}`); return null; });
    if (!voiceDeps) return { ok: false, reason: 'deps-unavailable' };

    const slugId = (name) => slugifyLabel(name) || 'speaker';
    // Wrap nameForUser so every time the adapter mints a speaker slug we record
    // slug → user id — that's how a villager's spoken turn is resolved back to
    // their registry entry (and thus their clearance).
    const trackedNameForUser = (id) => {
      const name = nameForUser ? nameForUser(id) : `user-${id}`;
      refToUser.set(id === wardUserId ? 'ward' : slugId(name), id);
      return name;
    };

    const adapterCreator = discordVoiceAdapterCreator(guildId);
    engine.registerCallAdapter((hooks) => {
      const { adapter } = createDiscordCallAdapter({
        hooks,
        joinSpec: { guildId, channelId, adapterCreator, wardUserId, nameForUser: trackedNameForUser },
        deps: voiceDeps,
        slugId,
        log,
      });
      activeAdapter = adapter;
      return adapter;
    });

    // The gateway forwards every VOICE_STATE_UPDATE here so the adapter learns
    // who is in the channel (feeds the Pass 3b audience set) AND so I track
    // group-call presence — who's here, who came, who went — for the note + hello.
    setVoiceRosterListener((d) => {
      try { activeAdapter?.onVoiceStateChange({ userId: d?.user_id, channelId: d?.channel_id }); }
      catch (err) { log(`roster forward failed: ${err?.message ?? err}`); }
      onRosterChange().catch(err => log(`presence update failed: ${err?.message ?? err}`));
    });

    const r = await engine.startCall('discord', { guildId, channelId });
    if (!r.ok) {
      setVoiceRosterListener(null); activeAdapter = null;
      // Surface WHY — startCall carries the adapter's detail; without this the
      // ward only ever sees "join-failed" with no clue where it died.
      log(`join failed: ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
    } else {
      log(`voice call live in guild ${guildId} channel ${channelId} (${r.callId})`);
      // Remember the room, so a villager turn can build the audience gate + tag.
      callMeta.set(r.callId, { guildId, channelId, locationKey: `discord:guild:${guildId}:channel:${channelId}`, wardUserId });
      // Seed presence: whoever is ALREADY here counts as present, not as "joined"
      // (so the first turn doesn't announce my human arriving at their own call);
      // mark dirty so the first turn still names the room if it opened as a group.
      const seedIds = (discordVoiceChannelMembers(guildId, channelId) || []).filter(id => id !== botId());
      prevRosterIds.set(r.callId, new Set(seedIds));
      presence.set(r.callId, { dirty: true, joined: [], left: [] });
      greeted.set(r.callId, new Set());
    }
    return r;
  }

  async function leaveVoiceCall() {
    setVoiceRosterListener(null);
    const callId = engine.currentCallId();
    const r = await engine.endCall();
    activeAdapter = null;
    // Memorize each audience session, then drop all per-call state. Fire-and-forget
    // so a slow extraction never holds up teardown.
    if (callId) {
      memorizeCall(callId).catch(() => {});
      callHistory.delete(callId); callTag.delete(callId); callMeta.delete(callId);
      roomListeners.forget(callId);   // §8.4 per-call "already mentioned" set
      prevRosterIds.delete(callId); presence.delete(callId); greeted.delete(callId);
    }
    refToUser.clear();
    return r;
  }

  // ── Proactive voice into Discord (spec §7) ───────────────────────────────
  // The Discord half of the web `voice-call` push adapter. Two ways a proactive
  // outbox item (a triage check-in, a reminder, a warm reach-out) reaches my
  // human by voice on Discord:
  //   1. A call is already live → speak it into the call.
  //   2. No call, but `voiceProactiveJoin` is on and my human is sitting in a VC →
  //      join that channel, speak the check-in, and leave. (Discord can't ring a
  //      human; sitting in a channel is the closest thing to being reachable.)
  // BOTH are gated on my human being the ONLY human present (`wardAlone`): a
  // private check-in must never be spoken aloud where a villager or a stranger can
  // hear it. When it can't be spoken privately, this adapter declines and the item
  // still lands through the private channels (the webhook / the gateway bot-DM).
  //
  // The name is 'voice-call' — the SAME channel the web adapter records under — so
  // a check-in spoken to my human here earns the §10 escalation factor exactly
  // like a web call (`contactDeadlineFor` reads `delivery['voice-call']`). The two
  // factories never both deliver: at most one voice connection is live across the
  // transports (the shared call-state lock), and the proactive-join branch stands
  // down whenever ANY call is active (the sync file read below), so the single
  // 'voice-call' delivery record is never overwritten by a colliding second one.
  const tomesDir = path.join(rootDir, 'tomes');
  const speakItem = async (item) => {
    const text = speakableText(formatItemForPush(item))?.text?.trim();
    if (!text) return { ok: false, error: 'nothing speakable in this item' };
    const heard = await engine.speakProactive(() => synthesize(text));
    return heard;
  };

  registerPushAdapterFactory((s) => {
    const wardUserId = String(s?.discordWardUserId ?? '').trim();
    const botId = discordBotUserId();

    // 1) A live Discord call → speak into it, but only if my human is alone.
    if (engine.isCallActive()) {
      return {
        name: 'voice-call',
        deliver: async (item) => {
          try {
            const meta = callMeta.get(engine.currentCallId());
            const members = meta ? discordVoiceChannelMembers(meta.guildId, meta.channelId) : [];
            const { wardPresent, wardAlone } = wardVoiceState(members, { wardUserId, botId });
            if (!wardAlone) {
              return { ok: false, error: wardPresent ? 'others present — kept private, not spoken aloud' : 'my human is not in the call' };
            }
            const heard = await speakItem(item);
            return heard ? { ok: true, meta: { wardPresent: true } } : { ok: false, error: 'call ended before it could be spoken' };
          } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
        },
      };
    }

    // 2) No live call → proactive join, only if enabled and viable RIGHT NOW.
    // Decide viability synchronously in the factory so a non-viable dispatch adds
    // no 'voice-call' record at all (and never collides with the web adapter).
    if (!Boolean(s?.voiceProactiveJoin) || discordVoiceDisabled() || !wardUserId) return null;
    if (isCallActiveFromFileSync(tomesDir)) return null;   // a call is live on the other transport — that path speaks
    const where = findWardVoiceChannel(wardUserId);
    if (!where) return null;                                // my human isn't sitting in any VC
    const { wardAlone } = wardVoiceState(discordVoiceChannelMembers(where.guildId, where.channelId), { wardUserId, botId });
    if (!wardAlone) return null;                            // someone else is there — don't join to speak something private

    return {
      name: 'voice-call',
      deliver: async (item) => {
        // Re-check at delivery time — the roster or call state may have shifted
        // between the factory's synchronous decision and now (fail-closed).
        if (engine.isCallActive() || await isCallActiveFromFile(tomesDir)) return { ok: false, error: 'a call became active — not joining' };
        const now = findWardVoiceChannel(wardUserId);
        if (!now) return { ok: false, error: 'my human left voice before I could join' };
        const still = wardVoiceState(discordVoiceChannelMembers(now.guildId, now.channelId), { wardUserId, botId });
        if (!still.wardAlone) return { ok: false, error: 'someone else joined — kept private, not spoken aloud' };

        const j = await joinVoiceCall({
          guildId: now.guildId, channelId: now.channelId, wardUserId,
          nameForUser: (id) => `guest-${String(id).slice(0, 6)}`,
        });
        if (!j?.ok) return { ok: false, error: `proactive join failed: ${j.reason ?? 'unknown'}` };
        log(`proactive join → speaking a check-in to my human in ${now.guildId}/${now.channelId}`);
        try {
          const heard = await speakItem(item);
          return heard ? { ok: true, meta: { wardPresent: true, proactiveJoin: true } } : { ok: false, error: 'my human left before it could be spoken' };
        } catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
        finally { await leaveVoiceCall().catch(() => {}); }
      },
    };
  });

  return { joinVoiceCall, leaveVoiceCall, isCallActive: engine.isCallActive };
}
