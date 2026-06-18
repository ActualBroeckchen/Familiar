"""Single-file backup / restore (Pillar H), passphrase-encrypted at rest.

"Back up my Familiar" / "restore my Familiar" — the whole self (identity,
memory, graph, trackers, snapshots metadata) in one portable file the ward
controls. The file is encrypted with a key derived from the ward's passphrase,
so a backup sitting in cloud storage or on a USB stick discloses nothing
without it.

Format (.phylactery file):
  magic   4 bytes  b"PHB1"
  salt    16 bytes PBKDF2 salt
  token   rest     Fernet(AES128-CBC + HMAC) of a VACUUM INTO'd .sqlite

Restore decrypts to a temp file, sanity-checks it is a real SQLite DB with a
`memories` table, then swaps it over the live DB (WAL files dropped). The MCP
connection must be re-established afterwards — thalamus does this.

⚠️ The passphrase is never stored. A lost passphrase means an unrecoverable
backup — that is the point of encryption-at-rest. Callers must surface this.
"""

from __future__ import annotations

import base64
import os
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from phylactery.db import get_conn, now_iso, default_db_path

_MAGIC = b"PHB1"
_SALT_LEN = 16
_KDF_ITERATIONS = 480_000  # OWASP-ish floor for PBKDF2-HMAC-SHA256


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=_KDF_ITERATIONS)
    return base64.urlsafe_b64encode(kdf.derive(passphrase.encode("utf-8")))


def _backups_dir() -> Path:
    return default_db_path().parent / "backups"


def export_encrypted(passphrase: str, conn: sqlite3.Connection | None = None) -> dict[str, Any]:
    """VACUUM the live DB into a temp file, encrypt it, write the .phylactery blob."""
    if not passphrase or len(passphrase) < 4:
        return {"ok": False, "error": "passphrase too short (need at least 4 characters)"}
    own_conn = conn is None
    if own_conn:
        conn = get_conn()
    tmp_path = None
    try:
        out_dir = _backups_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = now_iso().replace(":", "-").replace("+", "Z")
        out_path = out_dir / f"familiar-backup-{ts}.phylactery"

        # VACUUM INTO a private temp file (consistent, compacted copy).
        fd, tmp_name = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        tmp_path = Path(tmp_name)
        tmp_path.unlink()  # VACUUM INTO requires the target not to exist
        conn.execute(f"VACUUM INTO '{tmp_path}'")

        plaintext = tmp_path.read_bytes()
        salt = os.urandom(_SALT_LEN)
        token = Fernet(_derive_key(passphrase, salt)).encrypt(plaintext)
        out_path.write_bytes(_MAGIC + salt + token)

        return {"ok": True, "filePath": str(out_path), "sizeBytes": out_path.stat().st_size}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        if own_conn:
            conn.close()


def restore_encrypted(file_path: str, passphrase: str) -> dict[str, Any]:
    """Decrypt a .phylactery backup and swap it over the live DB."""
    src = Path(file_path)
    if not src.exists():
        return {"ok": False, "error": f"backup file not found: {file_path}"}
    tmp_path = None
    try:
        blob = src.read_bytes()
        if blob[:4] != _MAGIC:
            return {"ok": False, "error": "not a Phylactery backup file (bad magic)"}
        salt = blob[4:4 + _SALT_LEN]
        token = blob[4 + _SALT_LEN:]
        try:
            plaintext = Fernet(_derive_key(passphrase, salt)).decrypt(token)
        except InvalidToken:
            return {"ok": False, "error": "wrong passphrase or corrupted backup"}

        fd, tmp_name = tempfile.mkstemp(suffix=".sqlite")
        os.close(fd)
        tmp_path = Path(tmp_name)
        tmp_path.write_bytes(plaintext)

        # Sanity-check it's a real Phylactery DB before clobbering the live one.
        try:
            check = sqlite3.connect(str(tmp_path))
            has = check.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='memories'"
            ).fetchone()
            check.close()
        except sqlite3.DatabaseError:
            has = None
        if not has:
            return {"ok": False, "error": "decrypted file is not a valid Phylactery database"}

        live_path = default_db_path()
        for suffix in ("", "-shm", "-wal"):
            victim = Path(str(live_path) + suffix)
            if victim.exists():
                victim.unlink()
        shutil.copy2(str(tmp_path), str(live_path))
        return {"ok": True, "restoredFrom": str(src)}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if tmp_path and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
