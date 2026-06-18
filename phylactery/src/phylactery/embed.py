"""Local embedder — all-MiniLM-L6-v2 via fastembed, 384-dim.

Lazy-loads the model on first call so startup is instant.
Model files cache in ~/.cache/huggingface/ after first download.
Returns packed float32 bytes (struct.pack('384f', ...)) for sqlite-vec.
"""

from __future__ import annotations

import struct
from typing import Sequence

DIMS = 384
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

_model = None


def _get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(MODEL_NAME)
    return _model


def embed_texts(texts: Sequence[str]) -> list[bytes]:
    """Embed a batch of texts. Returns packed float32 bytes per text."""
    model = _get_model()
    results = list(model.embed(list(texts)))
    return [struct.pack(f"{DIMS}f", *vec.tolist()) for vec in results]


def embed_text(text: str) -> bytes:
    return embed_texts([text])[0]


def pack_vec(floats: list[float]) -> bytes:
    return struct.pack(f"{DIMS}f", *floats)


def unpack_vec(blob: bytes) -> list[float]:
    return list(struct.unpack(f"{DIMS}f", blob))
