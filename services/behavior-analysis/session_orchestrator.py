"""
Session Orchestrator — Manages per-session analyzer pipelines.

Each WebSocket client gets an isolated session with its own:
  - FaceAnalyzer
  - HandGestureAnalyzer
  - AudioAnalyzer
  - StressHeatmapGenerator
  - ConfidenceStressEngine

Orchestrates the analysis pipeline per-frame.
"""

import asyncio
import base64
import time
from dataclasses import dataclass, field
from typing import Optional, Dict

import cv2
import numpy as np

from analyzers import (
    FaceAnalyzer,
    HandGestureAnalyzer,
    AudioAnalyzer,
    StressHeatmapGenerator,
    ConfidenceStressEngine,
    BehaviorSnapshot,
)
from config import settings


@dataclass
class SessionState:
    """Per-session state."""
    session_id: str
    user_id: str
    gto_session_id: Optional[str]   # linked GTO simulation session
    started_at: float
    frame_count: int = 0
    audio_chunk_count: int = 0

    # Analyzers (created per session)
    face_analyzer: FaceAnalyzer = field(default_factory=lambda: FaceAnalyzer(
        max_faces=settings.FACE_MESH_MAX_FACES,
        min_detection=settings.FACE_MESH_MIN_DETECTION_CONFIDENCE,
        min_tracking=settings.FACE_MESH_MIN_TRACKING_CONFIDENCE,
    ))
    hand_analyzer: HandGestureAnalyzer = field(default_factory=lambda: HandGestureAnalyzer(
        max_hands=settings.HAND_MAX_HANDS,
        min_detection=settings.HAND_MIN_DETECTION_CONFIDENCE,
        min_tracking=settings.HAND_MIN_TRACKING_CONFIDENCE,
    ))
    audio_analyzer: AudioAnalyzer = field(default_factory=lambda: AudioAnalyzer(sample_rate=16000))
    heatmap_gen: StressHeatmapGenerator = field(default_factory=lambda: StressHeatmapGenerator(
        resolution=settings.HEATMAP_RESOLUTION,
    ))
    confidence_engine: ConfidenceStressEngine = field(default_factory=ConfidenceStressEngine)

    # Accumulated data
    snapshots: list = field(default_factory=list)
    all_alerts: list = field(default_factory=list)


class SessionOrchestrator:
    """Manages analysis sessions."""

    def __init__(self):
        self._sessions: Dict[str, SessionState] = {}

    def create_session(self, session_id: str, user_id: str, gto_session_id: Optional[str] = None) -> SessionState:
        """Create a new analysis session."""
        state = SessionState(
            session_id=session_id,
            user_id=user_id,
            gto_session_id=gto_session_id,
            started_at=time.time(),
        )
        self._sessions[session_id] = state
        return state

    def get_session(self, session_id: str) -> Optional[SessionState]:
        return self._sessions.get(session_id)

    def end_session(self, session_id: str) -> Optional[SessionState]:
        """End session and release resources."""
        state = self._sessions.pop(session_id, None)
        if state:
            state.face_analyzer.release()
            state.hand_analyzer.release()
        return state

    def process_video_frame(self, session_id: str, frame_bytes: bytes) -> Optional[BehaviorSnapshot]:
        """
        Process a single video frame (JPEG or raw BGR).
        Returns a BehaviorSnapshot or None if session not found.
        """
        state = self._sessions.get(session_id)
        if not state:
            return None

        # Decode frame
        nparr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return None

        state.frame_count += 1

        # ── Run face analysis ────────────────────────────────────────────
        face_snap = state.face_analyzer.process_frame(frame)

        # Get raw face landmarks for hand-to-face touch detection
        face_lm = None
        # We pass the frame to the face mesh separately for hand analysis
        # to avoid double processing — the face_snap already has the data

        # ── Run hand analysis ────────────────────────────────────────────
        hand_metrics = state.hand_analyzer.process_frame(frame, face_lm)

        # ── Generate stress heatmap ──────────────────────────────────────
        heatmap = state.heatmap_gen.generate(face_snap, hand_metrics, None)

        # ── Compute confidence/stress ────────────────────────────────────
        snapshot = state.confidence_engine.compute(face_snap, hand_metrics, None, heatmap)

        # Store
        state.snapshots.append(snapshot)
        if snapshot.alerts:
            state.all_alerts.extend(snapshot.alerts)

        return snapshot

    def process_audio_chunk(self, session_id: str, audio_bytes: bytes, sample_rate: int = 16000) -> Optional[BehaviorSnapshot]:
        """
        Process an audio chunk (raw PCM int16 or float32).
        Usually called at ~1Hz.
        """
        state = self._sessions.get(session_id)
        if not state:
            return None

        state.audio_chunk_count += 1

        # Decode audio
        audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        # ── Run audio analysis ───────────────────────────────────────────
        audio_metrics = state.audio_analyzer.process_chunk(audio)

        # ── Generate heatmap with audio data ─────────────────────────────
        heatmap = state.heatmap_gen.generate(None, None, audio_metrics)

        # ── Compute confidence/stress with audio ─────────────────────────
        snapshot = state.confidence_engine.compute(None, None, audio_metrics, heatmap)

        state.snapshots.append(snapshot)
        if snapshot.alerts:
            state.all_alerts.extend(snapshot.alerts)

        return snapshot

    def process_combined(
        self,
        session_id: str,
        frame_bytes: Optional[bytes],
        audio_bytes: Optional[bytes],
    ) -> Optional[BehaviorSnapshot]:
        """
        Process video + audio together for synchronized analysis.
        Preferred over separate calls when both streams arrive together.
        """
        state = self._sessions.get(session_id)
        if not state:
            return None

        face_snap = None
        hand_metrics = None
        audio_metrics = None

        # ── Video ────────────────────────────────────────────────────────
        if frame_bytes:
            nparr = np.frombuffer(frame_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if frame is not None:
                state.frame_count += 1
                face_snap = state.face_analyzer.process_frame(frame)
                hand_metrics = state.hand_analyzer.process_frame(frame, None)

        # ── Audio ────────────────────────────────────────────────────────
        if audio_bytes:
            state.audio_chunk_count += 1
            audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            audio_metrics = state.audio_analyzer.process_chunk(audio)

        # ── Heatmap & confidence ─────────────────────────────────────────
        heatmap = state.heatmap_gen.generate(face_snap, hand_metrics, audio_metrics)
        snapshot = state.confidence_engine.compute(face_snap, hand_metrics, audio_metrics, heatmap)

        state.snapshots.append(snapshot)
        if snapshot.alerts:
            state.all_alerts.extend(snapshot.alerts)

        return snapshot

    def get_session_summary(self, session_id: str) -> Optional[dict]:
        """Get aggregated session metrics for post-analysis."""
        state = self._sessions.get(session_id)
        if not state or not state.snapshots:
            return None

        confidences = [s.confidence.overall_confidence for s in state.snapshots]
        stresses = [s.confidence.stress_index for s in state.snapshots]

        return {
            'session_id': session_id,
            'user_id': state.user_id,
            'gto_session_id': state.gto_session_id,
            'duration_sec': round(time.time() - state.started_at, 1),
            'total_frames': state.frame_count,
            'total_audio_chunks': state.audio_chunk_count,
            'total_snapshots': len(state.snapshots),
            'total_alerts': len(state.all_alerts),
            'confidence_avg': round(float(np.mean(confidences)), 1),
            'confidence_min': round(float(np.min(confidences)), 1),
            'confidence_max': round(float(np.max(confidences)), 1),
            'stress_avg': round(float(np.mean(stresses)), 1),
            'stress_max': round(float(np.max(stresses)), 1),
            'stress_trend': state.snapshots[-1].confidence.stress_trend if state.snapshots else 'STABLE',
            'alert_breakdown': self._count_alerts(state.all_alerts),
        }

    def _count_alerts(self, alerts: list) -> dict:
        counts = {}
        for a in alerts:
            key = a.alert_type
            counts[key] = counts.get(key, 0) + 1
        return counts

    @property
    def active_sessions(self) -> int:
        return len(self._sessions)
