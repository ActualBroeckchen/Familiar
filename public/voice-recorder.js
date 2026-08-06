/**
 * Recording a voice note in the browser, and handing over something the
 * recogniser can actually read.
 *
 * ── Why this converts to wav instead of uploading what MediaRecorder gives ──
 * MediaRecorder produces webm/opus (or mp4/aac on Safari). Nothing on the
 * server can decode either without shipping a media library, and the
 * recogniser wants 16 kHz mono PCM. The browser, however, already has a
 * complete audio decoder and resampler in it — `decodeAudioData` and
 * `OfflineAudioContext` — so the conversion happens on the one machine where
 * it is free, and the server stores the one format it can always read.
 *
 * That also means a voice note stays readable years later with no codec
 * dependency, which matters for a store whose whole point is that things
 * persist.
 *
 * ── 16 kHz mono, and why that is not a downgrade ────────────────────────
 * SenseVoice takes 16 kHz. Handing it 48 kHz stereo means it resamples
 * internally anyway, so the extra bytes buy nothing and cost three times the
 * disk. A voice note is speech, not music.
 */

/** What the recogniser wants. Not a preference — resampling to anything else just gets undone. */
export const TARGET_RATE = 16000;

/** 24 MB at 32 KB/s. The recorder stops here and says so, rather than failing on upload. */
export const MAX_SECONDS = 12 * 60;

/**
 * Interleave-free mono downmix.
 *
 * Averaging the channels rather than taking the left one: a headset mic often
 * records to one channel only, and picking the wrong one yields silence — a
 * failure that looks exactly like "the microphone didn't work".
 */
export function toMono(audioBuffer) {
  const n = audioBuffer.length;
  const channels = audioBuffer.numberOfChannels;
  // A real AudioBuffer always has at least one channel, but dividing by zero
  // here yields NaN samples, which clamp to silence — indistinguishable from
  // "the microphone didn't work". Cheaper to refuse than to debug.
  if (!channels) return new Float32Array(n);
  if (channels === 1) return audioBuffer.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i];
  }
  for (let i = 0; i < n; i++) out[i] /= channels;
  return out;
}

/**
 * Float samples → a 16-bit PCM wav file.
 *
 * Clamped before scaling: a sample slightly outside [-1, 1] (which happens
 * after resampling) would otherwise wrap around to the opposite extreme and
 * become an audible click.
 */
export function encodeWav(samples, sampleRate = TARGET_RATE) {
  const bytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const ascii = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // format: PCM
  view.setUint16(22, 1, true);           // channels: mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, bytes, true);

  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

/**
 * A recorded blob → a 16 kHz mono wav blob.
 *
 * `OfflineAudioContext` does the resampling, which is the browser's own
 * implementation rather than a hand-rolled one — resampling written badly
 * sounds like aliasing and transcribes like nonsense, and this is not the
 * place to find that out.
 */
export async function toWav(blob, { AudioContextCtor, OfflineCtor } = {}) {
  const AC = AudioContextCtor || window.AudioContext || window.webkitAudioContext;
  const OC = OfflineCtor || window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC || !OC) throw new Error('this browser has no audio decoder');

  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.round(decoded.duration * TARGET_RATE));
    const off = new OC(1, frames, TARGET_RATE);

    // Copy the mono mix into a fresh buffer at the SOURCE rate and let the
    // offline context resample it on render. Doing the downmix first means
    // the resampler runs once over one channel instead of twice over two.
    const mono = toMono(decoded);
    const src = off.createBufferSource();
    const holder = off.createBuffer(1, mono.length, decoded.sampleRate);
    holder.getChannelData(0).set(mono);
    src.buffer = holder;
    src.connect(off.destination);
    src.start();

    const rendered = await off.startRendering();
    return new Blob([encodeWav(rendered.getChannelData(0), TARGET_RATE)], { type: 'audio/wav' });
  } finally {
    // An AudioContext left open holds the microphone indicator on in some
    // browsers, which is alarming and untrue.
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

/** 0:41 — the same shape the stand-in uses, so the UI and the model agree. */
export function elapsedLabel(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Start recording. Returns a handle with `stop()` and `cancel()`.
 *
 * `cancel()` exists and is not decoration: pressing record and then thinking
 * better of it must be one button, not a recording my human then has to find
 * and delete. Cancelling releases the microphone and resolves nothing.
 */
export async function startRecording({ onTick, maxSeconds = MAX_SECONDS } = {}) {
  // The microphone API only exists in a SECURE CONTEXT (https:// or localhost).
  // Over Tailscale on plain http:// — which is how a phone reaches this — the
  // browser hides `navigator.mediaDevices` entirely, so `.getUserMedia` throws
  // "undefined is not an object". Say what's actually wrong and how to fix it,
  // rather than leaking that raw TypeError.
  if (!navigator.mediaDevices?.getUserMedia) {
    const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
    throw new Error(insecure
      ? 'Recording needs a secure connection. This page is on http://, and browsers only allow the microphone over https:// or on localhost. On the same machine, open http://localhost:8742. To use your phone over Tailscale, serve over HTTPS (e.g. `tailscale serve`) and open the https:// address.'
      : 'This browser did not expose a microphone (no navigator.mediaDevices). Try a current Chrome/Safari/Firefox, and make sure the page is on https:// or localhost.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  const startedAt = Date.now();
  let cancelled = false;
  const release = () => { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* gone */ } } };

  const finished = new Promise((resolve) => {
    rec.onstop = () => {
      release();
      resolve(cancelled ? null : new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
  });

  const tick = setInterval(() => {
    const secs = (Date.now() - startedAt) / 1000;
    onTick?.(secs, elapsedLabel(secs));
    // Stopping at the cap rather than letting the upload fail afterwards:
    // losing a twelve-minute recording to a size limit nobody mentioned is
    // the kind of thing that makes someone never try the feature again.
    if (secs >= maxSeconds && rec.state === 'recording') rec.stop();
  }, 250);
  finished.finally?.(() => clearInterval(tick));

  rec.start();
  return {
    get seconds() { return (Date.now() - startedAt) / 1000; },
    get state() { return rec.state; },
    stop() { clearInterval(tick); if (rec.state === 'recording') rec.stop(); return finished; },
    cancel() { clearInterval(tick); cancelled = true; if (rec.state === 'recording') rec.stop(); else release(); return finished; },
  };
}
