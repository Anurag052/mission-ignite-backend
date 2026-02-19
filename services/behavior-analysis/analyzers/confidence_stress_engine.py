"""
Confidence & Stress Index Engine — Composite scoring from all analyzers.

Computes a real-time multi-dimensional confidence index and stress score
by fusing face, hand, audio, and heatmap outputs.
"""

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional, List

import numpy as np

from .face_analyzer import FaceSnapshot
from .hand_gesture_analyzer import HandGestureMetrics
from .audio_analyzer import AudioMetrics
from .stress_heatmap import HeatmapFrame


@dataclass
class ConfidenceIndex:
    """Multi-dimensional confidence scoring."""
    timestamp: float

    # Individual axes (0-100, higher = more confident)
    visual_confidence: float        # eye contact, stable gaze, open posture
    vocal_confidence: float         # steady voice, good pace, no tremor
    gestural_confidence: float      # purposeful gestures, no fidgeting
    emotional_confidence: float     # neutral/positive expression, no fear
    overall_confidence: float       # weighted composite

    # Stress index (0-100, higher = more stressed)
    stress_index: float
    stress_trend: str               # 'INCREASING' | 'DECREASING' | 'STABLE' | 'VOLATILE'
    stress_components: dict         # breakdown by source


@dataclass
class BehaviorAlert:
    """Triggered when metrics cross critical thresholds."""
    timestamp: float
    alert_type: str                 # 'CONFIDENCE_DROP' | 'STRESS_SPIKE' | 'ANOMALY' | 'PATTERN'
    severity: str                   # 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
    indicator: str                  # which metric triggered it
    value: float                    # the metric value
    threshold: float                # what threshold was crossed
    description: str
    recommendation: str


@dataclass
class BehaviorSnapshot:
    """Complete behavior analysis for a single time point."""
    timestamp: float
    confidence: ConfidenceIndex
    heatmap: Optional[HeatmapFrame]
    alerts: List[BehaviorAlert]

    # Raw metrics (for detailed drill-down)
    face_metrics: Optional[dict] = None
    hand_metrics: Optional[dict] = None
    audio_metrics: Optional[dict] = None


class ConfidenceStressEngine:
    """
    Fuses all analyzer outputs into composite confidence/stress scores.
    Runs alert detection for threshold breaches.
    """

    # Weights for composite confidence
    WEIGHTS = {
        'visual': 0.30,
        'vocal': 0.30,
        'gestural': 0.20,
        'emotional': 0.20,
    }

    # Alert thresholds
    THRESHOLDS = {
        'confidence_drop': 20,       # >20 point drop triggers alert
        'stress_spike': 70,          # stress > 70 triggers alert
        'blink_rate_high': 30,       # >30 blinks/min
        'gaze_unstable': 40,         # stability < 40
        'voice_tremor_high': 60,     # tremor > 60
        'silence_too_long': 5000,    # >5s silence
        'hand_jitter_high': 60,      # jitter > 60
        'fidgeting_high': 60,        # fidgeting > 60
        'fear_expression': 50,       # fear > 50
    }

    def __init__(self):
        self._confidence_history: deque = deque(maxlen=120)  # ~2 min
        self._stress_history: deque = deque(maxlen=120)
        self._alert_cooldowns: dict = {}  # prevent alert spam
        self._baseline_confidence: Optional[float] = None
        self._frame_count: int = 0

    def compute(
        self,
        face: Optional[FaceSnapshot],
        hands: Optional[HandGestureMetrics],
        audio: Optional[AudioMetrics],
        heatmap: Optional[HeatmapFrame],
    ) -> BehaviorSnapshot:
        """Compute full behavior snapshot from all inputs."""
        now = time.time()
        self._frame_count += 1

        # ── Visual confidence ────────────────────────────────────────────
        visual = 70.0  # default if no face data
        if face and face.face_detected and face.eye:
            visual = (
                face.eye.gaze_stability * 0.35 +
                min(100, max(0, 100 - abs(face.eye.blink_rate_per_min - 15) * 3)) * 0.20 +
                face.eye.fixation_duration_ms / 20 * 0.15 +  # longer fixation = more focused
                (80 if not face.eye.saccade_detected else 40) * 0.15 +
                min(100, max(0, 100 - abs(face.head_yaw) * 2)) * 0.15  # minimal head turning
            )
            visual = max(0, min(100, visual))

        # ── Vocal confidence ─────────────────────────────────────────────
        vocal = 70.0
        if audio:
            vocal = audio.vocal_confidence

        # ── Gestural confidence ──────────────────────────────────────────
        gestural = 75.0
        if hands:
            gestural = hands.gesture_confidence
            if hands.gesturing_actively:
                gestural = min(100, gestural + 10)  # active purposeful gestures = bonus

        # ── Emotional confidence ─────────────────────────────────────────
        emotional = 75.0
        if face and face.face_detected and face.expression:
            expr = face.expression
            # Neutral/calm = high confidence; fear/anger = low
            emotional = (
                expr.neutral_score * 0.4 +
                max(0, 100 - expr.fear_score) * 0.25 +
                max(0, 100 - expr.anger_score) * 0.15 +
                max(0, 100 - expr.lip_compression) * 0.10 +
                max(0, 100 - face.facial_tension) * 0.10
            )
            emotional = max(0, min(100, emotional))

        # ── Overall confidence ───────────────────────────────────────────
        overall = (
            visual * self.WEIGHTS['visual'] +
            vocal * self.WEIGHTS['vocal'] +
            gestural * self.WEIGHTS['gestural'] +
            emotional * self.WEIGHTS['emotional']
        )

        # Calibrate baseline
        if self._frame_count <= 30:
            if self._baseline_confidence is None:
                self._baseline_confidence = overall
            else:
                self._baseline_confidence = 0.9 * self._baseline_confidence + 0.1 * overall

        self._confidence_history.append(overall)

        # ── Stress index ─────────────────────────────────────────────────
        stress_components = {}
        stress_total = 0

        if face and face.face_detected:
            face_stress = face.facial_tension * 0.5
            if face.expression:
                face_stress += face.expression.fear_score * 0.3 + face.expression.anger_score * 0.2
            stress_components['facial'] = min(100, face_stress)
            stress_total += stress_components['facial'] * 0.25

        if audio:
            vocal_stress = (
                audio.voice_tremor_score * 0.4 +
                (100 - audio.volume_stability) * 0.3 +
                min(100, audio.silence_ratio * 300) * 0.3
            )
            stress_components['vocal'] = min(100, vocal_stress)
            stress_total += stress_components['vocal'] * 0.30

        if hands and hands.hands_detected > 0:
            hand_stress = (
                hands.jitter_score * 0.3 +
                hands.tremor_score * 0.3 +
                hands.fidgeting_score * 0.2 +
                (40 if hands.self_touch_detected else 0) * 0.2
            )
            stress_components['gestural'] = min(100, hand_stress)
            stress_total += stress_components['gestural'] * 0.25

        if heatmap:
            stress_components['spatial'] = heatmap.overall_stress_level
            stress_total += heatmap.overall_stress_level * 0.20

        stress_index = min(100, max(0, stress_total))
        self._stress_history.append(stress_index)

        # Stress trend
        stress_trend = self._compute_stress_trend()

        confidence = ConfidenceIndex(
            timestamp=now,
            visual_confidence=round(visual, 1),
            vocal_confidence=round(vocal, 1),
            gestural_confidence=round(gestural, 1),
            emotional_confidence=round(emotional, 1),
            overall_confidence=round(overall, 1),
            stress_index=round(stress_index, 1),
            stress_trend=stress_trend,
            stress_components={k: round(v, 1) for k, v in stress_components.items()},
        )

        # ── Alerts ───────────────────────────────────────────────────────
        alerts = self._check_alerts(face, hands, audio, confidence, now)

        # ── Serialize raw metrics for storage ────────────────────────────
        face_dict = None
        if face and face.face_detected:
            face_dict = {
                'eye': face.eye.__dict__ if face.eye else None,
                'expression': face.expression.__dict__ if face.expression else None,
                'head_pose': {'pitch': face.head_pitch, 'yaw': face.head_yaw, 'roll': face.head_roll},
                'facial_tension': face.facial_tension,
            }

        hand_dict = hands.__dict__ if hands else None
        audio_dict = audio.__dict__ if audio else None

        return BehaviorSnapshot(
            timestamp=now,
            confidence=confidence,
            heatmap=heatmap,
            alerts=alerts,
            face_metrics=face_dict,
            hand_metrics=hand_dict,
            audio_metrics=audio_dict,
        )

    # ── Stress trend ─────────────────────────────────────────────────────────────

    def _compute_stress_trend(self) -> str:
        if len(self._stress_history) < 10:
            return 'STABLE'
        recent = list(self._stress_history)
        first_half = np.mean(recent[-20:-10]) if len(recent) > 20 else np.mean(recent[:len(recent) // 2])
        second_half = np.mean(recent[-10:])
        diff = second_half - first_half
        std = np.std(recent[-20:])

        if std > 15:
            return 'VOLATILE'
        elif diff > 8:
            return 'INCREASING'
        elif diff < -8:
            return 'DECREASING'
        return 'STABLE'

    # ── Alert detection ──────────────────────────────────────────────────────────

    def _check_alerts(
        self,
        face: Optional[FaceSnapshot],
        hands: Optional[HandGestureMetrics],
        audio: Optional[AudioMetrics],
        confidence: ConfidenceIndex,
        now: float,
    ) -> List[BehaviorAlert]:
        alerts = []

        def _add(alert_type: str, severity: str, indicator: str, value: float,
                 threshold: float, description: str, recommendation: str):
            # Cooldown: 10 seconds per alert type
            key = f"{alert_type}:{indicator}"
            if key in self._alert_cooldowns and now - self._alert_cooldowns[key] < 10:
                return
            self._alert_cooldowns[key] = now
            alerts.append(BehaviorAlert(
                timestamp=now, alert_type=alert_type, severity=severity,
                indicator=indicator, value=round(value, 1), threshold=threshold,
                description=description, recommendation=recommendation,
            ))

        # Confidence drop
        if len(self._confidence_history) > 5:
            prev = np.mean(list(self._confidence_history)[-10:-5])
            drop = prev - confidence.overall_confidence
            if drop > self.THRESHOLDS['confidence_drop']:
                severity = 'CRITICAL' if drop > 35 else 'HIGH' if drop > 25 else 'MEDIUM'
                _add('CONFIDENCE_DROP', severity, 'overall_confidence', drop,
                     self.THRESHOLDS['confidence_drop'],
                     f'Confidence dropped by {drop:.0f} points',
                     'Pause, take a breath, and restate your point with conviction')

        # Stress spike
        if confidence.stress_index > self.THRESHOLDS['stress_spike']:
            _add('STRESS_SPIKE', 'HIGH', 'stress_index', confidence.stress_index,
                 self.THRESHOLDS['stress_spike'],
                 f'Stress index at {confidence.stress_index:.0f}/100',
                 'Slow your breathing. Focus on one clear action.')

        # Eye-specific alerts
        if face and face.face_detected and face.eye:
            if face.eye.blink_rate_per_min > self.THRESHOLDS['blink_rate_high']:
                _add('ANOMALY', 'MEDIUM', 'blink_rate', face.eye.blink_rate_per_min,
                     self.THRESHOLDS['blink_rate_high'],
                     f'High blink rate: {face.eye.blink_rate_per_min:.0f} blinks/min',
                     'Elevated blink rate indicates anxiety. Try to maintain steady eye contact.')

            if face.eye.gaze_stability < self.THRESHOLDS['gaze_unstable']:
                _add('ANOMALY', 'MEDIUM', 'gaze_stability', face.eye.gaze_stability,
                     self.THRESHOLDS['gaze_unstable'],
                     f'Gaze instability: {face.eye.gaze_stability:.0f}/100',
                     'Your eyes are darting. Pick one focal point and hold.')

        # Voice alerts
        if audio:
            if audio.voice_tremor_score > self.THRESHOLDS['voice_tremor_high']:
                _add('ANOMALY', 'HIGH', 'voice_tremor', audio.voice_tremor_score,
                     self.THRESHOLDS['voice_tremor_high'],
                     f'Voice tremor detected: {audio.voice_tremor_score:.0f}/100',
                     'Speak from your diaphragm. Lower your pitch slightly.')

            if audio.silence_duration_ms > self.THRESHOLDS['silence_too_long']:
                _add('ANOMALY', 'MEDIUM', 'silence_gap', audio.silence_duration_ms,
                     self.THRESHOLDS['silence_too_long'],
                     f'Extended silence: {audio.silence_duration_ms / 1000:.1f}s',
                     'Even a brief "My plan is..." buys you time without looking frozen.')

        # Hand alerts
        if hands and hands.hands_detected > 0:
            if hands.jitter_score > self.THRESHOLDS['hand_jitter_high']:
                _add('ANOMALY', 'MEDIUM', 'hand_jitter', hands.jitter_score,
                     self.THRESHOLDS['hand_jitter_high'],
                     f'Hand instability: jitter at {hands.jitter_score:.0f}/100',
                     'Place your hands on a surface or clasp them calmly.')

            if hands.fidgeting_score > self.THRESHOLDS['fidgeting_high']:
                _add('ANOMALY', 'LOW', 'fidgeting', hands.fidgeting_score,
                     self.THRESHOLDS['fidgeting_high'],
                     f'Fidgeting detected: {hands.fidgeting_score:.0f}/100',
                     'Keep your hands still or use purposeful gestures only.')

        # Expression alert
        if face and face.face_detected and face.expression:
            if face.expression.fear_score > self.THRESHOLDS['fear_expression']:
                _add('PATTERN', 'HIGH', 'fear_expression', face.expression.fear_score,
                     self.THRESHOLDS['fear_expression'],
                     f'Fear expression detected: {face.expression.fear_score:.0f}/100',
                     'The GTO is testing you. Maintain a neutral, composed expression.')

        return alerts
