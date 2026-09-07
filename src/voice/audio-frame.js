/**
 * Length-framed messages over stdio (voice spec §2).
 *
 * The audio worker is a child process, and the two things it carries are very
 * different: small JSON control frames ("start a stream", "here is a partial
 * transcript") and large raw PCM buffers. Both share one pipe, so both need
 * framing — stdio hands over whatever-sized chunks it likes, and a reader that
 * assumes a write arrives as one read is a reader that works until the day the
 * buffers fill.
 *
 * No sockets, no ports. Same posture as the MCP children: a pipe the operating
 * system already cleans up when the process dies.
 *
 * ── Wire format ─────────────────────────────────────────────────────────
 *   [4 bytes: payload length, big-endian][1 byte: kind][payload]
 *
 *   kind 0 — JSON control frame; payload is UTF-8 JSON
 *   kind 1 — PCM audio; payload is [2 bytes: stream id][16 kHz mono s16le]
 *
 * The stream id rides INSIDE the PCM payload rather than in a JSON frame
 * alongside it, because audio and its routing must not be able to arrive out
 * of order or get separated by a dropped frame. One frame, one answer to
 * "which stream is this?".
 *
 * ── Why a size cap ──────────────────────────────────────────────────────
 * A corrupted or hostile length prefix would otherwise ask us to buffer four
 * gigabytes. The cap turns that into a clean protocol error, and a protocol
 * error is something supervision can restart. Nothing legitimate approaches it:
 * a second of 16 kHz mono audio is 32 KB.
 */

export const KIND_JSON = 0;
export const KIND_PCM = 1;

const HEADER_BYTES = 5;

/** 8 MB — four minutes of audio in one frame, orders of magnitude past anything real. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Encode a JSON control frame. */
export function encodeJson(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt32BE(body.length, 0);
  out.writeUInt8(KIND_JSON, 4);
  body.copy(out, HEADER_BYTES);
  return out;
}

/** Encode a PCM frame for one stream. `pcm` is 16 kHz mono s16le. */
export function encodePcm(streamId, pcm) {
  const id = Number(streamId) & 0xffff;
  const body = Buffer.allocUnsafe(2 + pcm.length);
  body.writeUInt16BE(id, 0);
  Buffer.from(pcm).copy(body, 2);

  const out = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  out.writeUInt32BE(body.length, 0);
  out.writeUInt8(KIND_PCM, 4);
  body.copy(out, HEADER_BYTES);
  return out;
}

/**
 * An incremental reader.
 *
 * Feed it whatever chunks arrive; it emits whole frames as they complete. A
 * frame split across ten reads and ten frames inside one read are the same
 * case to it, which is the entire point — those are not edge cases on a pipe,
 * they are Tuesday.
 *
 * On a protocol violation it stops emitting and reports `error` once. Carrying
 * on after a bad length prefix would mean interpreting audio as a header, and
 * a stream that has lost sync cannot be resynchronised by guessing — the
 * supervisor restarts the worker instead.
 */
export function createFrameReader({ onFrame, onError = null, maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  let buf = Buffer.alloc(0);
  let broken = false;

  const fail = (reason, detail) => {
    if (broken) return;
    broken = true;
    buf = Buffer.alloc(0);
    try { onError?.({ reason, detail }); } catch { /* a reporter must not break the reader */ }
  };

  return {
    /** Feed bytes. Returns how many whole frames this chunk completed. */
    push(chunk) {
      if (broken || !chunk?.length) return 0;
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      let emitted = 0;

      for (;;) {
        if (buf.length < HEADER_BYTES) break;
        const len = buf.readUInt32BE(0);

        if (len > maxFrameBytes) {
          fail('frame-too-large', `${len} bytes exceeds the ${maxFrameBytes}-byte limit`);
          return emitted;
        }
        if (buf.length < HEADER_BYTES + len) break;   // the rest is still in flight

        const kind = buf.readUInt8(4);
        const body = buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
        buf = buf.subarray(HEADER_BYTES + len);

        if (kind === KIND_JSON) {
          let parsed;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch (err) {
            // Malformed JSON is one bad frame, not a lost stream: the length
            // prefix still told us exactly where it ended, so sync is intact
            // and the next frame is readable. Report and carry on.
            try { onError?.({ reason: 'bad-json', detail: String(err?.message ?? err) }); } catch { /* ignore */ }
            continue;
          }
          try { onFrame({ kind: KIND_JSON, message: parsed }); } catch { /* a handler must not break the reader */ }
        } else if (kind === KIND_PCM) {
          if (body.length < 2) {
            try { onError?.({ reason: 'short-pcm', detail: `${body.length} bytes` }); } catch { /* ignore */ }
            continue;
          }
          const streamId = body.readUInt16BE(0);
          try { onFrame({ kind: KIND_PCM, streamId, pcm: body.subarray(2) }); } catch { /* ignore */ }
        } else {
          // An unknown kind is survivable the same way: framing held, so skip
          // this one. Forward compatibility comes free.
          try { onError?.({ reason: 'unknown-kind', detail: String(kind) }); } catch { /* ignore */ }
          continue;
        }
        emitted++;
      }
      return emitted;
    },

    /** Bytes held back waiting for the rest of a frame. Observability, not state to poke. */
    pending() { return buf.length; },

    /** True once framing has been lost and the stream needs restarting rather than reading. */
    isBroken() { return broken; },

    reset() { buf = Buffer.alloc(0); broken = false; },
  };
}
