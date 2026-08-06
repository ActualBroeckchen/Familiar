/*
 * voice-call-capture-worklet.js — the mic-capture AudioWorklet for a live call.
 *
 * Runs on the audio rendering thread, so capture doesn't glitch when the main
 * thread is busy (the reason to prefer this over the deprecated
 * ScriptProcessorNode). It does the minimum here — accumulate mono input and
 * hand whole blocks to the main thread — so the resample, barge detection and
 * socket send stay in one place (voice-call.js `processCaptureBlock`), shared
 * with the ScriptProcessor fallback.
 *
 * `process()` is called with 128-sample render quanta; posting each one would
 * flood the main thread with messages, so blocks are coalesced to ~2048 samples
 * (~43 ms at 48 kHz) before being posted — the same granularity the old
 * ScriptProcessor delivered.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n >= this._buf.length) {
          // Copy out — the buffer is reused for the next block.
          this.port.postMessage(this._buf.slice(0));
          this._n = 0;
        }
      }
    }
    return true; // keep the processor alive for the life of the call
  }
}

registerProcessor('capture-processor', CaptureProcessor);
