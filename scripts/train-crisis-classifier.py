#!/usr/bin/env python3
"""
train-crisis-classifier.py — offline trainer for the crisis classifier
(docs/crisis-classifier-build-spec.md). Safety-critical: the OUTPUT is a small
JSON of weights that the app reads at runtime; the app never trains and never
runs this. Run it where the datasets are reachable (the ward's machine):

    uv run --with 'datasets>=2' --with scikit-learn --with pandas --with pyarrow \
        scripts/train-crisis-classifier.py

It writes models/crisis-classifier.json and prints the metrics that are the
sign-off gate (gate 2 in the spec). NOTHING is wired into the app by running it.

Two heads, both TF-IDF (1-2 gram) + logistic regression:
  - distress       : suicide vs non-suicide  (trained on the light-clean bulk)
  - normalization  : pro-suicide "settled/normalising" REGISTER vs help-seeking +
                     neutral. DETECTION-ONLY. Trained only if the gated
                     sanctioned-suicide set is present; skipped otherwise. The
                     source text is NEVER emitted — only weights. (spec §5.5)

The distress probability is mapped onto the app's tiers using the Columbia
`severity` set (av9ash/CSSR-S). Recall on severe/high is a gate: it must not
fall below the phrase list's, so class_weight is balanced (favouring recall).

Offline smoke test (no HuggingFace needed):
    python3 scripts/train-crisis-classifier.py --source local \
        --distress-csv tests/fixtures/crisis_smoke.csv --out /tmp/art.json
"""
import argparse, json, math, re, sys, datetime
from pathlib import Path

# ── The shared normalization (THE exact-values seam) ────────────────────────
# Mirrored byte-for-byte in src/safety/crisis-classifier.js `normalizeForMl`.
# Deliberately light + fully replicable in JS: lowercase, drop URLs, keep only
# a-z + apostrophe + spaces (drops digits/punct/non-ascii), collapse 3+ char
# repeats to 2, squeeze whitespace. Matches the light-clean training corpus.
NORMALIZER_VERSION = "letters-v1"
_URL_RE   = re.compile(r"https?://\S+|www\.\S+")
_KEEP_RE  = re.compile(r"[^a-z'\s]")
_REPEAT_RE = re.compile(r"(.)\1{2,}")
_WS_RE    = re.compile(r"\s+")

def normalize(text: str) -> str:
    t = (text or "").lower()
    t = _URL_RE.sub(" ", t)
    t = _KEEP_RE.sub(" ", t)
    t = _REPEAT_RE.sub(r"\1\1", t)
    t = _WS_RE.sub(" ", t).strip()
    return t

def tokenize(norm_text: str):
    """Whitespace tokens of the ALREADY-normalized text. Simple on purpose, so
    the JS side reproduces it exactly (no sklearn regex subtleties)."""
    return [tok for tok in norm_text.split(" ") if tok]

# ── Curated eval negatives (the false-positives we must NOT fire on) ────────
# Mundane frustration / helpless-about-a-task — the ward's reported softening.
MUNDANE_NEG = [
    "i can't do this, nothing i try works",
    "ugh i give up on this stupid bug, nothing works",
    "i don't know how to solve this software problem",
    "i'm so done with this deploy, it keeps failing",
    "this is hopeless, the build won't compile no matter what",
    "i can't figure this out and it's driving me crazy",
    "i'm exhausted, this project is killing me",
    "i want to die, this meeting could have been an email",
]
# For the normalization head: registers that must read as NEGATIVE (not endorsement).
NORMALIZATION_NEG = [
    "the movie's villain wanted to end it all, so dark",
    "philosophically, is suicide ever a rational choice? interesting debate",
    "i believe in bodily autonomy and assisted dying for the terminally ill",
    "my grandad died by suicide years ago and i still miss him",
    "this horror game is so bleak, everyone dies at the end",
]

def sigmoid(x): return 1.0 / (1.0 + math.exp(-x))


def load_hf(repo_id, split, text_col, label_col):
    from datasets import load_dataset
    ds = load_dataset(repo_id, split=split)
    rows = []
    for r in ds:
        t = r.get(text_col)
        rows.append((t, r.get(label_col)))
    return rows


def to_binary_label(v):
    """Map assorted label encodings to 1 (suicide/positive) / 0 (not) / None."""
    if v is None: return None
    if isinstance(v, (int, float)):
        return 1 if v >= 1 else 0
    s = str(v).strip().lower()
    if s in ("suicide", "1", "true", "yes", "positive"): return 1
    if s in ("non-suicide", "nonsuicide", "not suicide", "0", "false", "no", "negative"): return 0
    return None


def build_vectorizer():
    from sklearn.feature_extraction.text import TfidfVectorizer
    # Pre-normalized text in; whitespace tokenizer + 1-2 grams; sublinear tf +
    # l2 norm are the sklearn defaults we replicate in JS. min_df drops hapax
    # noise; max_features caps the artifact size.
    return TfidfVectorizer(
        preprocessor=normalize,
        tokenizer=tokenize,
        token_pattern=None,
        ngram_range=(1, 2),
        min_df=5,
        max_features=20000,
        sublinear_tf=True,
        norm="l2",
    )


def train_head(texts, labels):
    from sklearn.linear_model import LogisticRegression
    vec = build_vectorizer()
    X = vec.fit_transform(texts)
    clf = LogisticRegression(max_iter=1000, class_weight="balanced", C=1.0)
    clf.fit(X, labels)
    vocab = {t: int(i) for t, i in vec.vocabulary_.items()}
    idf = [float(x) for x in vec.idf_]
    coef = [0.0] * len(vocab)
    for i, w in enumerate(clf.coef_[0]):
        coef[i] = float(w)
    return {
        "vocab": vocab,
        "idf": idf,
        "coef": coef,
        "intercept": float(clf.intercept_[0]),
    }, vec, clf


def head_top_tokens(head, n=25):
    inv = {i: t for t, i in head["vocab"].items()}
    order = sorted(range(len(head["coef"])), key=lambda i: head["coef"][i], reverse=True)
    return [[inv[i], round(head["coef"][i], 4)] for i in order[:n]]


def score_head(head, text):
    """Replicate the JS inference exactly (parity is validated in JS tests)."""
    toks = tokenize(normalize(text))
    grams = list(toks) + [f"{toks[i]} {toks[i+1]}" for i in range(len(toks) - 1)]
    counts = {}
    for g in grams:
        counts[g] = counts.get(g, 0) + 1
    vocab, idf, coef = head["vocab"], head["idf"], head["coef"]
    vec = {}
    for g, c in counts.items():
        idx = vocab.get(g)
        if idx is None:
            continue
        vec[idx] = (1.0 + math.log(c)) * idf[idx]  # sublinear tf * idf
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    dot = sum((v / norm) * coef[idx] for idx, v in vec.items())
    return sigmoid(dot + head["intercept"])


def evaluate(head, texts, labels, name):
    tp = fp = tn = fn = 0
    for t, y in zip(texts, labels):
        p = score_head(head, t)
        pred = 1 if p >= 0.5 else 0
        if y == 1 and pred == 1: tp += 1
        elif y == 1 and pred == 0: fn += 1
        elif y == 0 and pred == 1: fp += 1
        else: tn += 1
    recall = tp / (tp + fn) if (tp + fn) else float("nan")
    precision = tp / (tp + fp) if (tp + fp) else float("nan")
    return {"name": name, "tp": tp, "fp": fp, "tn": tn, "fn": fn,
            "recall": round(recall, 4), "precision": round(precision, 4)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["hf", "local"], default="hf")
    ap.add_argument("--distress-csv", help="local CSV (text,label) for --source local")
    ap.add_argument("--out", default="models/crisis-classifier.json")
    ap.add_argument("--no-normalization", action="store_true",
                    help="skip the pro-suicide-register head even if its data is present")
    args = ap.parse_args()

    if args.source == "local":
        import csv
        rows = []
        with open(args.distress_csv, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                rows.append((r["text"], to_binary_label(r["label"])))
        distress_rows = [(t, y) for t, y in rows if t and y is not None]
        distress_test = distress_rows  # smoke test: reuse
    else:
        # TRAIN bulk: the light-clean set (natural text → JS-replicable) — §7.
        train = load_hf("vibhorag101/phr_suicide_prediction_dataset_clean_light", "train", "text", "label")
        test  = load_hf("vibhorag101/phr_suicide_prediction_dataset_clean_light", "test",  "text", "label")
        distress_rows = [(t, to_binary_label(y)) for t, y in train]
        distress_rows = [(t, y) for t, y in distress_rows if t and y is not None]
        distress_test = [(t, to_binary_label(y)) for t, y in test]
        distress_test = [(t, y) for t, y in distress_test if t and y is not None]

    texts = [t for t, _ in distress_rows]
    labels = [y for _, y in distress_rows]
    print(f"[train] distress head: {len(texts)} rows "
          f"({sum(labels)} suicide / {len(labels)-sum(labels)} non)", file=sys.stderr)
    distress, _vec, _clf = train_head(texts, labels)

    report = {"distress_heldout": evaluate(distress, [t for t, _ in distress_test],
                                           [y for _, y in distress_test], "distress/heldout")}
    # Precision guard: the mundane-frustration set must mostly read as NOT distress.
    mundane_fp = sum(1 for t in MUNDANE_NEG if score_head(distress, t) >= 0.5)
    report["mundane_false_positives"] = f"{mundane_fp}/{len(MUNDANE_NEG)}"

    artifact = {
        "version": 1,
        "kind": "tfidf-logreg",
        "normalizer": {"version": NORMALIZER_VERSION,
                       "note": "mirrored in crisis-classifier.js normalizeForMl"},
        "tokenizer": {"ngram": [1, 2], "sublinear_tf": True, "norm": "l2"},
        "distress": distress,
        "normalization": None,   # filled below iff the gated set is present
        "meta": {
            "trainedAt": datetime.datetime.utcnow().isoformat() + "Z",
            "rows": len(texts),
            "metrics": report,
            "distress_top_tokens": head_top_tokens(distress),
        },
    }

    # NORMALIZATION head — only if the gated sanctioned-suicide set is reachable.
    # DETECTION-ONLY: we read its text solely to fit weights; we never emit it.
    if args.source == "hf" and not args.no_normalization:
        try:
            pos = load_hf("trentmkelly/sanctioned-suicide-forum-scrape", "train", "text", None)
            # Negatives: help-seeking (SuicideWatch) + neutral, so the head learns
            # the ENDORSING register specifically, not "mentions suicide".
            neg_src = [t for t, _ in distress_rows][:len(pos)]
            n_texts = [t for t, _ in pos if t] + neg_src
            n_labels = [1] * sum(1 for t, _ in pos if t) + [0] * len(neg_src)
            print(f"[train] normalization head: {sum(n_labels)} pos / {len(n_labels)-sum(n_labels)} neg", file=sys.stderr)
            norm_head, _, _ = train_head(n_texts, n_labels)
            # FP guard: fiction/philosophy/autonomy/grief must NOT read as endorsement.
            guard_fp = sum(1 for t in NORMALIZATION_NEG if score_head(norm_head, t) >= 0.5)
            artifact["normalization"] = norm_head
            artifact["meta"]["normalization_top_tokens"] = head_top_tokens(norm_head)
            artifact["meta"]["metrics"]["normalization_guard_false_positives"] = f"{guard_fp}/{len(NORMALIZATION_NEG)}"
        except Exception as e:  # gated/absent → skip gracefully (spec §5.5)
            print(f"[train] normalization head skipped ({e})", file=sys.stderr)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, ensure_ascii=True), encoding="utf-8")
    print(f"[train] wrote {out} ({out.stat().st_size} bytes)", file=sys.stderr)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
