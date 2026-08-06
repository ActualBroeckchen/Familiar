# PocketTTS — the reference I should have written first

Facts extracted from installed source, not from docs pages or memory. Every
claim here is checkable in `pocket_tts` 2.1.0 or `sherpa-onnx` C++.

**Why this exists:** I made four confident wrong claims about this library —
the seed twice, `copy_state`, and `maxNumSentences` — and each one cost a live
test on my human's machine. Every answer was in source I had already
downloaded. This is the antidote.

> **The rule:** a docstring summary is a paraphrase. When behaviour disagrees
> with what you remember, read `pocket_tts/models/tts_model.py` or
> `sherpa-onnx/csrc/offline-tts-pocket-impl.h`. Both are on disk.

---

## Two engines, two different libraries

We can drive PocketTTS through either. They share a model family and **nothing
else** — different APIs, different defaults, different bugs.

| | `sherpa` (`audio-worker.mjs`) | `pocket` (`voicebox/`) |
|---|---|---|
| library | `sherpa-onnx-node`, C++/ONNX | `pocket-tts`, PyTorch |
| model | `2026-01` (only ONNX export) | `english_2026-04` |
| voice conditioning | an embedding vector | a full KV-cache state |
| config surface | `extra` string→value map | Python kwargs |
| install | ships, ~216 MB | ~600 MB |

---

## `pocket-tts` (the Python sidecar)

### Signatures — copy these, don't recall them

```python
TTSModel.load_model(
    language=None, config=None,
    temp=0.7, lsd_decode_steps=1, noise_clamp=None,
    eos_threshold=-4.0, quantize=False,
) -> Self

model.get_state_for_audio_prompt(audio_conditioning, truncate=False) -> dict
model.generate_audio(model_state, text, max_tokens=50, frames_after_eos=None, copy_state=True) -> Tensor
model.generate_audio_stream(model_state, text, max_tokens=50, frames_after_eos=None, copy_state=True)
```

### `default_parameters.py`, verbatim

```python
DEFAULT_TEMPERATURE      = 0.7
DEFAULT_LSD_DECODE_STEPS = 1      # note: ONE, not 4
DEFAULT_NOISE_CLAMP      = None
DEFAULT_EOS_THRESHOLD    = -4.0
DEFAULT_FRAMES_AFTER_EOS = None
MAX_TOKEN_PER_CHUNK      = 50     # + TODO: english_2026-04 supports bigger
```

### ⚠️ `copy_state` — the one that cost two tests

```python
if copy_state:
    model_state = copy.deepcopy(model_state)
```

- **`True` (default)** — deep-copies before generating. Your state is preserved
  and every chunk starts from the *same* pristine conditioning.
- **`False`** — mutates in place. State accumulates across calls.

I read `False` as "carry the KV cache forward for continuity." It *does* thread
state — that part was right — but it accumulates unboundedly and degrades. What
my human heard: one clean paragraph, then static, then nothing. **Leave it at
the default** unless you are deliberately experimenting.

### ⚠️ Long text is already handled — do not pre-chunk

`generate_audio_stream` calls `split_into_best_sentences` itself, splitting on
**token** boundaries with the model's own tokenizer at `max_tokens=50`. Feeding
it pre-chunked text fights that and gains nothing. **Hand it the whole
message.**

### ⚠️ There is NO cross-chunk continuity — upstream says so

```python
# This is a very simplistic way of handling long texts. We could do much better
# by using teacher forcing, but it would be a bit slower.
# TODO: add the teacher forcing method for long texts where we use the audio of
# one chunk as conditioning for the next chunk.
```

Each 50-token chunk is an independent generation from the same voice state.
**Long-form voice continuity is an unimplemented TODO upstream**, not a feature
the sidecar unlocks. What the sidecar genuinely buys is a *stronger conditioning
signal* (a full KV-cache state rather than an embedding vector) and a newer
model — which may well be enough. It is not the architectural fix I claimed
when proposing it.

### Text is normalised for you (`prepare_text_prompt`)

Applied to every chunk, before generation:

- `\n` and `\r` → space; doubled spaces collapsed
- `;` → `,` when `remove_semicolons`
- first character upper-cased
- trailing `.` appended if the text ends alphanumeric
- fewer than 5 words → padded with 8 leading spaces (`pad_with_spaces_for_short_inputs`)
- ≤ 4 words → `frames_after_eos` guess 3, else 1

**Newlines are destroyed.** Paragraph structure cannot survive into prosody, so
do not build anything that depends on it.

### Generation length

```python
_TOKENS_PER_SECOND_ESTIMATE = 3.0
_GEN_SECONDS_PADDING        = 2.0
gen_len_sec = token_count / 3.0 + 2.0
max_gen_len = ceil(gen_len_sec * mimi.frame_rate)
```

Bounded per chunk from token count — so a runaway is naturally capped here,
unlike the sherpa path.

### Untested knobs

`noise_clamp` (clamps noise sampling), `truncate` on `get_state_for_audio_prompt`,
`quantize=True` (needs `torchao`), and the `*_24l` language variants — larger,
slower, English has none.

---

## `sherpa-onnx` (the shipped engine)

### Config lives in an untyped `extra` map

This is why I twice concluded there was no seed: `extra` is
`{[key: string]: number | string}`, so **neither the JS typedefs nor the
compiled strings list what it accepts.** The C++ header does:

```
max_frames                default 500
frames_after_eos          default 3
temperature               default 0.7
chunk_size                default 15
max_reference_audio_len   default 10   (seconds)
max_char_in_sentence      default 200
min_char_in_sentence      default 30
seed                      default -1   ← random every call
```

### ⚠️ `seed: -1` re-randomises PER SENTENCE

```cpp
auto sentences = SplitByPunctuation(text);
for (...) GenerateSingleSentence(sentences[i], gen_config, View(&voice_embedding), ...)
  └─ NormalDataGenerator normal_gen(0, stddev, seed);
```

The voice embedding is shared and cached, so it stays a similar speaker — but
prosody, energy and clarity are re-rolled every sentence. **Always pass a fixed
seed.** `voice-generation.js` refuses `-1` rather than forwarding it.

### ⚠️ The runt fragment → up to 40 s of noise

`SplitLongSentence` splits at `max_char_in_sentence` and drops the remainder
into its own chunk — *after* `MergeShortSentences` has already run, so it is
never merged back. A 205-char sentence became `[…199 chars, 'real.']`. Then:

```cpp
if (eos_step < 0 && p_logit[0] > -4) eos_step = step;   // eos_step = 0
if (eos_step > 0 && (step >= eos_step + frames_after_eos)) break;
                ^^^ 0 > 0 is false — never fires
```

EOS at step 0 means the loop never breaks and runs the full frame budget. Keep
`max_char_in_sentence` well clear of real sentence lengths, and keep
`runawaySampleLimit` clamped **below** the frame ceiling or it cannot fire.

### ⚠️ `Generate`'s loop drops words in two silent ways

Read from `sherpa-onnx/csrc/offline-tts-pocket-impl.h` (`Generate`), not recalled:

```cpp
bool should_continue = true;
for (int32_t i = 0; i < total && should_continue; ++i) {
  GeneratedAudio cur = GenerateSingleSentence(sentences[i], gen_config,
                                              View(&voice_embedding),
                                              should_continue, wrapped_cb);
  if (cur.samples.empty()) {
    continue;                     // (2)
  }
  result.samples.insert(...);
}
```

and inside `GenerateSingleSentence`:

```cpp
if (callback) {
  should_continue = callback(out.GetTensorData<float>(), n, ...);   // (1)
}
```

1. **A progress callback that returns false abandons the ENTIRE REST of the
   message**, not just the sentence it was called from — `should_continue` is
   the loop's own condition. Our worker returns `0` on a runaway trip and on a
   dead pipe, so a runaway anywhere silences everything after it.
2. **A sentence that renders no samples is skipped in silence** — no error, no
   flag, the loop simply moves on.

Neither surfaces as a failure, so the only signal is audio that is far shorter
than the text predicts (`expectedSpeechSeconds`, warned about in the read-aloud
loop). Keeping the sentence count at ONE (see `wholeUtteranceMin`) is also what
keeps both of these to a single possible occurrence.

### The voice-embedding cache is NOT a source of voice swapping

Checked while hunting exactly that. `GetVoiceEmbedding` hashes the reference
audio **after** resampling and after the `max_reference_audio_len` truncation,
then `cache_.Get(hash)`; the hit path allocates from the stored shape and copies
the stored floats, so a hit returns the same embedding the miss would have
computed. Different clips hash differently. The embedding is also fetched ONCE
per `Generate` and shared by every sentence via `View(&voice_embedding)` — so
within one call the speaker cannot change. Drift within a message comes from the
LM reset, not from this cache.

### ⚠️ `maxNumSentences` is inert

PocketTTS's `Generate` never reads it — it does its own `SplitByPunctuation`
unconditionally. Not a consistency lever. The seed is.

### ⚠️ LM state resets per utterance

```cpp
auto lm_main_state = model_->GetLmMainInitState();
```

Every utterance is a fresh trajectory. `min_char_in_sentence` (via
`MergeShortSentences`) makes resets *rarer* by merging more text into one
utterance — it cannot remove them. Upstream's 30 merges nothing.

**⚠️ Do NOT set it from the text length.** I tried exactly that — merge the
whole message into one utterance, get one trajectory and one voice — and it
loses words. PocketTTS generates per sentence and was trained on
sentence-length audio, so an over-long "sentence" reaches EOS early and stops.
Measured on the real engine, one 899-character message, same seed and voice:

| `min_char_in_sentence` | duration | chars/sec | |
|---|---|---|---|
| 300 | 42.96 s | 20.9 | full |
| 500 | 38.32 s | 23.5 | ok |
| 899 (one utterance) | 24.80 s | **36.3** | **half the text gone** |

Speech is ~18–25 chars/second; 36 is not fast speech, it is missing words. So
this is a genuine trade with no winning setting — small values drift the voice
(a reset per utterance), large values swallow content. **400 is where the text
still renders in full.** Wanting both is what the sidecar is for: it carries a
KV-cache state and needs no resets at all.

### The voice-embedding cache is NOT a source of voice swapping

Checked while hunting exactly that. `GetVoiceEmbedding` hashes the reference
audio **after** resampling and after the `max_reference_audio_len` truncation,
then `cache_.Get(hash)`; the hit path allocates from the stored shape and copies
the stored floats, so a hit returns the same embedding the miss would have
computed. Different clips hash differently. The embedding is also fetched ONCE
per `Generate` and shared by every sentence via `View(&voice_embedding)` — so
within one call the speaker cannot change. Drift within a message comes from the
LM reset, not from this cache.

### ⚠️ `maxNumSentences` is inert

PocketTTS's `Generate` never reads it — it does its own `SplitByPunctuation`
unconditionally. Not a consistency lever. The seed is.

### ⚠️ LM state resets per utterance

```cpp
auto lm_main_state = model_->GetLmMainInitState();
```

Every utterance is a fresh trajectory. `min_char_in_sentence` (via
`MergeShortSentences`) makes resets *rarer* by merging more text into one
utterance — it cannot remove them. Upstream's 30 merges nothing.

**Set it from the TEXT, not to a constant.** A fixed floor (we shipped 400)
makes an ordinary message one trajectory and leaves a long one as several —
which my human heard as the voice changing partway through a reply, on this
engine only. `wholeUtteranceMin(text)` in `voice-generation.js` covers the whole
part instead, capped by what the frame budget can hold. Verified on the real
engine: 782 chars → 37.0 s across several utterances at 400, 31.1 s as one.
`generationExtras` already clamps `max_char_in_sentence` to `min + 200`, so
raising the floor cannot re-open the runt-fragment split above.

---

## Voices and reference clips

- **Sample quality is reproduced.** Upstream: *"we recommend cleaning the
  sample… because the audio quality of the sample is also reproduced."* Kyutai
  use `_enhanced` for every VCTK voice in their own list.
- Measured on `p255_023`: identical pitch/duration/voiced-fraction, ~23% more
  high-frequency energy in the enhanced cut.
- **Not every clip has an enhanced variant** — 369 of 377. LibriVox
  (`voice-zero`) and `alba-mackenna` are original-only. Look it up
  (`preferEnhanced`); never assume.
- Longer reference is better; 10–20 s recommended, and `max_reference_audio_len`
  defaults to **10**, not 12.

## The tokenizer has 4000 tokens

No token contains a curly quote (`'` `"` `"`) or an ellipsis (`…`). SentencePiece
byte-falls-back, so an ordinary apostrophe becomes three rarely-seen tokens.
Normalise to ASCII first. The em-dash **is** present.

---

## What a working configuration looks like

Confirmed by ear on the reference laptop, 2026-07, on a multi-paragraph
message — one voice throughout, no shift at paragraph boundaries.

```
backend                  pocket (voicebox/)
reference clip           p255_023_ENHANCED, the whole file
generate_audio_stream    the entire message, ONE call
copy_state               left at its default (True)
lsd_decode_steps         1  (upstream's default)
temp                     0.7
eos_threshold            -4.0
max_tokens               50 (untouched)
```

Every failure before this came from overriding one of these:
pre-chunking the text, `copy_state=False`, 4 decode steps, or the un-enhanced
reference. **The working configuration is almost entirely upstream's defaults.**
The one deliberate deviation is the enhanced reference clip, which upstream
also recommends.

## Checklist before claiming anything about this library

1. Is the value in `extra`? Then the typedefs and the strings won't show it —
   read the header.
2. Does the library already do this? `split_into_best_sentences` and
   `prepare_text_prompt` both do more than they sound like.
3. Am I about to say a flag means continuity? Check whether it means *copying*.
4. Have I confirmed which engine is actually running? `[voice] speaking
   through …` in the boot log, or `backend.using` on `/api/voice/status`.
   One whole test was analysed against the wrong backend.
