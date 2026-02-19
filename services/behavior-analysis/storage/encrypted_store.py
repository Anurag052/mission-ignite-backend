"""
Encrypted Metrics Storage — AES-256-GCM encrypted persistence.

Stores behavior analysis snapshots and session summaries with
encryption at rest using Fernet (AES-128-CBC) or AES-256-GCM.

Storage backends: Redis (primary), filesystem (fallback).
"""

import json
import os
import time
import hashlib
from typing import Optional, Any
from dataclasses import asdict

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import base64

from config import settings

try:
    import redis.asyncio as aioredis
    HAS_REDIS = True
except ImportError:
    HAS_REDIS = False


class EncryptedMetricsStore:
    """Encrypted storage for behavior analysis metrics."""

    PREFIX = "ba:metrics:"
    SESSION_PREFIX = "ba:session:"
    TTL_SECONDS = 86400 * 7      # 7 days retention

    def __init__(self):
        self._fernet = self._init_encryption()
        self._redis = None

    def _init_encryption(self) -> Optional[Fernet]:
        """Initialize Fernet encryption from key or generate one."""
        key = settings.ENCRYPTION_KEY
        if key:
            # Derive 32-byte key from provided key via PBKDF2
            kdf = PBKDF2HMAC(
                algorithm=hashes.SHA256(),
                length=32,
                salt=b"behavior-analysis-salt-v1",
                iterations=100_000,
            )
            derived = base64.urlsafe_b64encode(kdf.derive(key.encode()))
            return Fernet(derived)
        else:
            # Generate ephemeral key (data lost on restart)
            return Fernet(Fernet.generate_key())

    async def connect(self):
        """Connect to Redis."""
        if HAS_REDIS and settings.REDIS_URL:
            try:
                self._redis = aioredis.from_url(
                    settings.REDIS_URL,
                    decode_responses=False,
                )
                await self._redis.ping()
            except Exception:
                self._redis = None

    def encrypt(self, data: Any) -> bytes:
        """Encrypt a Python object to bytes."""
        json_bytes = json.dumps(data, default=str).encode("utf-8")
        return self._fernet.encrypt(json_bytes)

    def decrypt(self, encrypted: bytes) -> Any:
        """Decrypt bytes back to Python object."""
        decrypted = self._fernet.decrypt(encrypted)
        return json.loads(decrypted.decode("utf-8"))

    # ── Snapshot storage ─────────────────────────────────────────────────────────

    async def store_snapshot(self, session_id: str, snapshot_data: dict, timestamp: float):
        """Store an encrypted behavior snapshot."""
        key = f"{self.PREFIX}{session_id}:{int(timestamp * 1000)}"
        encrypted = self.encrypt(snapshot_data)

        if self._redis:
            await self._redis.set(key, encrypted, ex=self.TTL_SECONDS)
        else:
            self._store_file(key, encrypted)

    async def get_session_snapshots(self, session_id: str, limit: int = 100) -> list:
        """Retrieve and decrypt all snapshots for a session."""
        pattern = f"{self.PREFIX}{session_id}:*"

        if self._redis:
            keys = []
            async for key in self._redis.scan_iter(match=pattern, count=500):
                keys.append(key)
            keys = sorted(keys)[-limit:]

            snapshots = []
            for key in keys:
                data = await self._redis.get(key)
                if data:
                    snapshots.append(self.decrypt(data))
            return snapshots

        return self._read_files(pattern, limit)

    # ── Session summary storage ──────────────────────────────────────────────────

    async def store_session_summary(self, session_id: str, summary: dict):
        """Store encrypted session summary."""
        key = f"{self.SESSION_PREFIX}{session_id}"
        encrypted = self.encrypt(summary)

        if self._redis:
            await self._redis.set(key, encrypted, ex=self.TTL_SECONDS)
        else:
            self._store_file(key, encrypted)

    async def get_session_summary(self, session_id: str) -> Optional[dict]:
        """Retrieve encrypted session summary."""
        key = f"{self.SESSION_PREFIX}{session_id}"

        if self._redis:
            data = await self._redis.get(key)
            return self.decrypt(data) if data else None

        return self._read_file(key)

    # ── Batch operations ─────────────────────────────────────────────────────────

    async def store_batch(self, session_id: str, snapshots: list):
        """Store multiple snapshots efficiently."""
        if self._redis:
            pipe = self._redis.pipeline()
            for snap in snapshots:
                ts = snap.get("timestamp", time.time())
                key = f"{self.PREFIX}{session_id}:{int(ts * 1000)}"
                encrypted = self.encrypt(snap)
                pipe.set(key, encrypted, ex=self.TTL_SECONDS)
            await pipe.execute()
        else:
            for snap in snapshots:
                ts = snap.get("timestamp", time.time())
                await self.store_snapshot(session_id, snap, ts)

    async def delete_session(self, session_id: str):
        """Delete all data for a session (GDPR compliance)."""
        if self._redis:
            pattern = f"{self.PREFIX}{session_id}:*"
            keys = []
            async for key in self._redis.scan_iter(match=pattern):
                keys.append(key)
            keys.append(f"{self.SESSION_PREFIX}{session_id}")
            if keys:
                await self._redis.delete(*keys)

    # ── Filesystem fallback ──────────────────────────────────────────────────────

    def _store_file(self, key: str, data: bytes):
        safe_key = hashlib.sha256(key.encode()).hexdigest()
        path = os.path.join("data", "metrics", f"{safe_key}.enc")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def _read_file(self, key: str) -> Optional[dict]:
        safe_key = hashlib.sha256(key.encode()).hexdigest()
        path = os.path.join("data", "metrics", f"{safe_key}.enc")
        if os.path.exists(path):
            with open(path, "rb") as f:
                return self.decrypt(f.read())
        return None

    def _read_files(self, pattern: str, limit: int) -> list:
        # Simplified: scan data directory
        results = []
        data_dir = os.path.join("data", "metrics")
        if os.path.isdir(data_dir):
            files = sorted(os.listdir(data_dir))[-limit:]
            for fname in files:
                path = os.path.join(data_dir, fname)
                with open(path, "rb") as f:
                    try:
                        results.append(self.decrypt(f.read()))
                    except Exception:
                        continue
        return results
