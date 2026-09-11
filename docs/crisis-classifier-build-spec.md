# Crisis classifier — build spec (a raise-only second opinion on distress)

> **Status: DESIGN — awaiting ward review + a validated model. Nothing here is
> wired into the live threat path yet.** This is safety-critical code
> (`crisis-signals.js` / `threat-tracker.js` class): every behavioural change
> needs the ward's sign-off, and this whole pass does too. It is NOT covered by
> any "keep working / auto-merge" grant.

## 0. Why

The current detector (`crisis-signals.js`) is a hand-written tiered regex
lexicon. The ward's own note: it was **created fairly blindly** — no evidence
base for which phrases matter or how much. It is careful and auditable, but its
weakness is **recall**: a fixed phrase list misses the many ways a person voices
ideation. The `vibhorag101/suicide_prediction_dataset_phr` dataset (~230k Reddit
posts, binary `suicide`/`non-suicide`) gives us, for the first time, (a) a way to
**measure** recall/precision instead of guessing, and (b) a source to learn a
broader signal from.

The ward chose to add an **ML classifier as a second signal** (not a
replacement). This spec is that, built so it can only ever *help* the detector
catch more, never cause it to catch less.

## 0.1 What we are actually fixing (both directions)

The detector is miscalibrated BOTH ways, and the overhaul must fix both:
- **Recall** — a hand-built list misses real ideation (the original motivation).
- **Precision** — it over-fires on mundane frustration, and a false distress hit
  softens the Familiar out of its firm-caretaker register (the ward's live pain:
  being gentle when it should be authoritative about small anti-rut tasks).

Two causes, only one of which is this detector (measured, 2026-09):
1. **A real regex over-fire.** e.g. *"I can't do this, nothing I try works"* trips
   `cant_continue` at HIGH (4) — the mundane damping only knows specific tech
   nouns, so bare frustration reads as crisis. THIS the detector fix addresses.
2. **LLM prompt-level softening.** The literal *"I don't know how to solve this
   software problem"* scores **0** here — the softening there is the model's own
   read of helplessness in the personality / `surface-context` prompts, NOT the
   threat tier. A SEPARATE prompt pass (anchor tone to identity — firm, not
   default-care), tracked apart from this classifier. Naming it so it isn't
   mistaken for a detector bug.

## 1. Invariants (the safety spine)

1. **Additive, never a replacement.** The regex scorer stays and keeps running;
   the classifier is a separate combined signal.
2. **Tier-asymmetric adjustment (the ward-decision at the heart of this).**
   - **SEVERE and HIGH: raise-only, never lowered.** Neither the classifier nor
     any regex narrowing may reduce a severe/high signal. A real crisis is never
     softened. (Recall-protected, absolutely.)
   - **MILD and MODERATE: precision-tunable.** Here a *confident not-distress*
     classifier verdict (and data-validated damping) MAY suppress a hit — because
     a false MILD/MODERATE is exactly what dilutes the firm register, and its
     cost is low (normal tone restored; the SEVERE/HIGH detectors and the triage
     LLM still catch any real escalation). This is a deliberate, ward-signed
     loosening of the old pure-"raise-only" rule, made to fix the reported harm.
3. **The classifier alone caps at HIGH, never SEVERE.** SEVERE drives auto-contact
   of trusted people (`cerebellum.js`); a statistical score must not trigger that
   alone. It raises to HIGH, handing the moment to the triage LLM to judge in
   context.
4. **Never remove a SEVERE/HIGH regex signal without evidence.** Non-severe
   patterns may be tightened where held-out data shows a clear false-positive with
   NO loss of true-positive recall; a severe/high phrase is never removed blind.
5. **Recall must not drop and precision must rise — both shown on held-out data
   before shipping.** Validation is a gate, not a nicety (§7). Specifically:
   severe/high recall stays at 100% of the current detector's on the eval set.
6. **Graceful degradation is absolute.** A missing / unparseable / version-
   mismatched artifact → classifier contributes 0, regex path unaffected, chat
   never breaks; a thrown inference is caught as "no signal". NB with the
   asymmetry, "no classifier" means non-severe hits are NOT suppressed — i.e.
   degradation fails toward the *current* (more sensitive) behaviour, never toward
   a softer one.
7. **Off-switch in the wiring commit.** `crisisClassifierEnabled` (synced) +
   `PROTO_FAMILIAR_CRISIS_CLASSIFIER_DISABLED=1`; stands down under
   `PROTO_FAMILIAR_THREAT_DISABLED=1`.

## 2. Architecture

```
  (offline, where the dataset is reachable)         (runtime, in the app)
  scripts/train-crisis-classifier.py                src/safety/crisis-classifier.js
    dataset → clean → tokenize → TF-IDF → logreg       load artifact (once)
    → evaluate (recall/precision + guards)             scoreMessageML(text) → { p, contribution }
    → emit  models/crisis-classifier.json                     │
                         │                                    ▼
                         └────────── artifact ──────►  combined at the ONE seam with
                                  (vocab + weights)     scoreMessage()'s regex level
                                                        (raise-only, capped at HIGH)
```

- **Model: TF-IDF (word 1–2 grams, capped vocab) + logistic regression.** The
  only sane choice that runs in-process with no native dependency and no network:
  inference is a tokenize → sparse dot-product → sigmoid, pure JS. It is also
  **auditable** — the top-weighted tokens can be listed for ward review, unlike a
  transformer. (A transformer/onnx path is explicitly out of scope: heavy dep,
  latency, and a fully opaque score feeding a safety tier.)
- **Trainer is Python/sklearn** (an offline dev tool, not a runtime dep), because
  that is the correct tool for TF-IDF+logreg and the artifact it emits is
  language-neutral. The **runtime never trains and never runs Python** — it only
  reads the JSON artifact. (Exact-values rule: the numbers are machine-generated;
  the JS only repeats them.)

## 3. Artifact format (`models/crisis-classifier.json`, git-ignored — it's large + machine-built)

```json
{
  "version": 1,
  "kind": "tfidf-logreg",
  "tokenizer": { "lowercase": true, "ngram": [1, 2], "token_re": "<the exact regex, mirrored in JS>" },
  "vocab": { "term": <index>, ... },
  "idf":   [<float per vocab index>],
  "coef":  [<float per vocab index>],
  "intercept": <float>,
  "calibration": { "threshold": <float>, "note": "p below this contributes 0" },
  "meta": { "trainedAt": "...", "rows": N, "metrics": { ... }, "topTokens": [["term", w], ...] }
}
```

The artifact is **git-ignored** (megabytes, machine-built, per-install), the same
posture as the media store and the pin overlay. A separate tiny committed file
(or the build spec) records the *expected* `version` so a stale artifact is
detected and ignored rather than trusted.

## 4. Tokenizer parity (the exact-values seam)

The JS inference tokenizer MUST produce the same tokens as the Python trainer, or
every score is quietly wrong. So the tokenizer is defined once, minimally
(lowercase, a single documented `token_re`, 1–2 grams), and the **regex string is
carried in the artifact** and applied verbatim on both sides. A parity test
(§10) pins a handful of strings to their expected token lists on the JS side, and
the trainer emits those same fixtures so drift is caught.

## 5. Combination & tier ceiling (the safety seam — `crisis-signals` + classifier)

At the one place a message is scored for threat, the regex `level` and the
classifier are combined:

- `p = sigmoid(coef · tfidf(text) + intercept)`.
- `contribution = 0` when `p < threshold` (no signal — never negative).
- Above threshold, `contribution` scales with `p` up to a cap `CLASSIFIER_MAX`
  chosen so the classifier ALONE reaches at most the HIGH tier's threshold in
  `threat-tracker` — never SEVERE.
- `finalLevel = max(regexLevel, regexLevel + contribution)` — i.e. it only ever
  adds. (Written as a max so it is *obviously* raise-only to a reviewer.)
- Fired-signal audit gains a synthetic entry `{ id:'ml_classifier', tier, p,
  contribution }` so the classifier's say is as auditable as every regex signal
  (the detector's "every trigger is logged" promise extends to it).

The `threshold` and `CLASSIFIER_MAX` are **tuned on held-out data and reviewed by
the ward**, not guessed — they trade recall against false check-ins, and false
check-ins are cheap while the SEVERE ceiling keeps false *escalations* off the
table.

## 5.5 Additional signals — recovery (down) and normalization (a new warning)

Beyond the distress classifier, two more signals, both ward-approved:

**Recovery / wellbeing (eases, within the asymmetry).** Today the down-direction
is: wellbeing/support language (the regex `safety` tier, −3/−2), time decay
(~3d half-life), and manual reset — but the Familiar's only *active* downward
lever is a full reset (all-or-nothing), while it can flag UP to severe. This adds
a **bounded** recovery read: a confident wellbeing verdict may *ease* the level,
under the SAME asymmetry — it can lower MILD/MODERATE, contribute to easing HIGH,
but NEVER single-handedly clear a SEVERE state (decay + reset still own that).
Its own off-switch. Fail-safe: absent → no easing (current behaviour).

**Normalization / pro-suicide-attitude (a new RAISE-only warning).** A distinct
signal for the register where someone has stopped arguing with the idea —
treating suicide as rational/acceptable/settled, adopting normalizing language —
which the distress detector misses and which is a recognised escalation marker.
- **Detection-only, RAISE-only, its own off-switch.** It raises concern and
  shifts the Familiar's posture toward firm, caring pushback + steering to help;
  it never lowers anything, and the triage LLM still makes the actual call.
- **The method-content boundary (hard, non-movable).** Its training source (the
  gated `sanctioned-suicide-forum-scrape`) is used ONLY to derive detection
  weights — never to generate, surface, teach, or store method content, and the
  text is never shipped. The artifact scores; it does not speak. This boundary
  does not move on request; it is the half that could harm rather than help.
- **False-positive guards (as load-bearing as the detection).** Must NOT fire on
  horror/dark-fiction fans, gallows humour, philosophical discussion of suicide,
  considered views on bodily autonomy / assisted dying, or grief / fear-driven
  reaching-out. Pathologising a belief or a personality is a failure, not a catch
  — the eval explicitly includes these as negatives.
- Trained + validated only on the ward's machine after they clear the dataset
  gate; the trainer degrades gracefully (skips this head) when the gated set is
  absent, so the rest still builds.

## 6. Distribution mismatch (Reddit posts → chat) — handled, not ignored

The dataset is long-form Reddit posts; the Familiar sees short chat turns. So:
- The regex remains the always-on floor — a short explicit "I want to die" is
  caught by regex regardless of how the classifier generalises.
- Validation includes a **short-message / chat-like eval** (§7), not just the
  Reddit held-out split, so we see transfer before trusting it.
- The threshold is tuned conservatively for the chat register.

## 7. Datasets (vetted — full sweep of the `suicide` search, ~80 repos)

The search is ~80 repos but collapses to a handful of distinct things: most are
re-uploads of ONE corpus (the Kaggle r/SuicideWatch 232K set, Nikhileswar et al.
2021), the rest are country mortality statistics, non-English, pre-tokenized,
unlabeled, empty/broken, or (one) an ethically-excluded pro-suicide forum. The
chosen set, each by role:

- **TRAIN — `vibhorag101/phr_suicide_prediction_dataset_clean_light`** (218K,
  binary, pre-split train/val/test). The decisive pick over the heavily-cleaned
  sibling: it is cleaned *minimally* (numbers/URLs/emojis/accents/whitespace only
  — **casing, punctuation, stopwords, contractions kept**), so the trainer's and
  the JS inference's shared normalization can actually MATCH it, killing the
  train/serve skew §6 worried about. (`Ram07/Detection-for-Suicide`, MIT, ships
  raw `text`+`cleaned_text` as a fully-raw fallback if we want to own cleaning.)
- **TIER CALIBRATION + PRECISION GOLD — `av9ash/CSSR-S…`** (1.2K, CC-BY): a
  Columbia-scale `severity` 0–6 per post. Maps the model's probability onto our
  severe/high/moderate/mild tiers AND is a built-in precision set — its
  severity-0-yet-emotionally-intense rows ("really struggling after a party…
  panic attack" = 0) are exactly the "distress ≠ suicidal" distinction we must
  get right.
- **RECALL STRESS — `babytreecc/Implicit-suicide-detection`** (1.6K, AFL-3.0):
  implicit / keyword-free ideation, the subtle cases a lexicon misses.
- **EVAL HARD-CASES — `apgard/youthsafebench-teen-suicide-and-self-harm`** (90):
  curated, GRADED (1–4) teen self-harm/ideation messages with linguistic tags
  (literal/figurative). Small, so it's a hand-check eval, not training.
- **OPTIONAL VALIDATION — `jingjietan/sdcnl-suicide`** (1.9K, pre-split): the
  SDCNL depression-vs-suicide set — tests the hard boundary (a depressed-but-not-
  suicidal post scoring low), the same axis as the ward's precision concern.
- **Precision hard-negatives** — the non-suicide class + the CSSR-S sev-0 rows +
  a small curated "mundane frustration / can't-do-this-nothing-works" set. The
  MILD/MODERATE precision tuning (§1.2) is validated against these.

Excluded (with reason), so the sweep is on record: country mortality/rate stats
(`electricsheep*`, `Rashmini`, `HHS-Official` — tabular, not text); clinical
feature tables (`ajaxxxx/Suicide_Risk` — age/cortisol/HRV, not text);
pre-tokenized BERT ids (`Madhavan0506` — no raw text); unlabeled
(`re-mind`/`amaye15/suicide-descriptions`); synthetic + self-flagged-inaccurate
(`infinite-dataset-hub`, 100 rows); non-English (all `*-es`, `*-gl`, Telugu,
Cantonese `lihkg`, Arabic); historical news (`npedrazzini/*`); broken/empty
viewers (`MindCastSogang/*`, `YenYein`, `maryamdavi`, `Goyam02`, and
`lensy111/relabelled` — a promising *relabelled* set but its export is currently
500-broken); and **`trentmkelly/sanctioned-suicide-forum-scrape` — excluded on
ethics** (a pro-suicide "methods" forum; gated, and we do not train on
method-instruction content regardless of access).

License note: MIT / CC-BY / AFL are all fine for *deriving weights* for the
ward's own install — the shipped artifact is numbers, not redistributed text.
Attribution kept in the trainer header + here.

## 7.5 Training + validation (the gate)

`scripts/train-crisis-classifier.py`:
1. Load the dataset (column names configurable / auto-detected — not assumed).
2. Clean + dedup; stratified train/test split.
3. TF-IDF + logreg; emit the artifact.
4. **Report, and hold as gates:**
   - recall / precision / PR-AUC on the held-out split;
   - a **regression guard**: every current regex `example` string (imported from
     `crisis-signals.js`) must still net at least its current tier under the
     combined detector — proof recall did not drop;
   - a **short-message eval**: a curated set of short ideation phrasings + benign
     short chat, to measure chat transfer and false-positive rate;
   - the top-weighted tokens, for the ward to eyeball for anything absurd.
- Data access: the cloud session can READ the Hub via the MCP connector (schema,
  card, ~100-row previews — enough to design against) but raw bulk egress to
  huggingface.co stays firewalled (a 43 MB parquet can't be pulled or streamed as
  tool output). So **training runs on the ward's machine**, where the dataset is
  reachable, via a one-command script (`uv run --with datasets --with
  scikit-learn … scripts/train-crisis-classifier.py`). The script downloads the
  dataset (public, MIT), trains, evaluates, and writes `models/crisis-classifier.json`
  + prints the metrics for gate 2. The session builds and smoke-tests that script
  against a synthetic local CSV (no HF needed); the ward runs it for real.
- Cleaning skew (measured, not ignored): the dataset text is heavily
  NLP-preprocessed (stopword-stripped, contractions expanded, likely lemmatised).
  We do NOT try to replay that pipeline in JS — instead the trainer and the JS
  inference share ONE light, fully-replicable normalization (lowercase, strip
  non-letter, collapse whitespace + 3+ repeats), and the residual (stopwords /
  unlemmatised forms in live chat) simply falls out of vocabulary and is ignored
  by TF-IDF. The high-weight content tokens (die, suicide, suffering, burden,
  worthless, end…) transfer; the short-message eval measures how much.

## 8. Ward sign-off gates (all three required before it is live)

1. **Design** — approve this spec.
2. **Model** — review the trained artifact's metrics + top tokens; confirm recall
   is up and nothing absurd is weighted high.
3. **Wiring** — approve the live combination + the chosen `threshold`/`cap`. Only
   then does the seam in §5 get wired and the off-switch ship with it.

Not auto-merged at any stage.

## 9. Testing plan

- **Inference unit tests** (JS): a tiny synthetic fixture artifact → known
  tokens, known score; graceful-degradation (missing/broken/version-mismatch
  artifact → contribution 0, never throws); off-switch → 0.
- **Combination tests**: raise-only (a low-`p` message never lowers a regex
  level; a negative would be clamped); the classifier alone never exceeds the
  HIGH ceiling; a regex SEVERE + classifier stays SEVERE (not doubled past cap).
- **Tokenizer parity test**: fixed strings → expected tokens, matching the
  trainer's emitted fixtures.
- **Trainer smoke test**: run the trainer on a tiny synthetic CSV (no HF needed)
  and assert it emits a well-formed artifact the JS loader accepts.
- **Pipeline test**: a full threat-scoring call through the combined path with a
  stubbed artifact.

## 10. Out of scope

- Transformer / neural models; any GPU or onnx runtime dependency.
- The classifier ever lowering threat, damping a regex hit, or reaching SEVERE on
  its own.
- Shipping a model the ward has not seen the metrics for.
