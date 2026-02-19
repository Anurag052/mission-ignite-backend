"""
Hand & Gesture Analyzer — Nervous gesture detection, hand movement instability.

Uses MediaPipe Hands (21 landmarks per hand) for:
  - Hand movement speed & jitter (instability)
  - Nervous gestures (fidgeting, self-touching, tapping)
  - Hand-to-face touches (stress indicator)
  - Finger tremor detection
  - Gesture confidence scoring
"""

import time
from collections import deque
from dataclasses import dataclass
from typing import Optional, List

import mediapipe as mp
import numpy as np


@dataclass
class HandGestureMetrics:
    """Per-frame hand/gesture analysis result."""
    timestamp: float
    hands_detected: int                   # 0, 1, or 2
    left_hand_visible: bool
    right_hand_visible: bool

    # Movement instability
    movement_speed_left: float            # pixels/frame
    movement_speed_right: float
    jitter_score: float                   # 0-100 (100 = extreme jitter)
    tremor_score: float                   # 0-100 (high-freq oscillation)

    # Nervous gestures
    fidgeting_score: float                # 0-100 (rapid small movements)
    self_touch_detected: bool             # hand touching face/body
    tapping_detected: bool                # repetitive finger/hand tapping
    hand_wringing_detected: bool          # hands rubbing together

    # Spatial
    hand_position_zone: str               # 'NEUTRAL' | 'FACE' | 'HAIR' | 'BODY' | 'TABLE'
    hand_elevation: str                   # 'HIGH' | 'MID' | 'LOW'
    hands_clasped: bool
    gesturing_actively: bool              # purposeful gestures while speaking

    # Confidence
    gesture_confidence: float             # 0-100 overall hand composure


class HandGestureAnalyzer:
    """Real-time hand and gesture analysis using MediaPipe Hands."""

    def __init__(self, max_hands: int = 2, min_detection: float = 0.5, min_tracking: float = 0.5):
        self.mp_hands = mp.solutions.hands
        self.hands = self.mp_hands.Hands(
            max_num_hands=max_hands,
            min_detection_confidence=min_detection,
            min_tracking_confidence=min_tracking,
        )

        # Tracking state per hand (indexed by 0=left, 1=right)
        self._position_history: dict = {0: deque(maxlen=60), 1: deque(maxlen=60)}  # ~2s
        self._speed_history: dict = {0: deque(maxlen=60), 1: deque(maxlen=60)}
        self._finger_tip_history: dict = {0: deque(maxlen=30), 1: deque(maxlen=30)}
        self._tap_history: deque = deque(maxlen=30)
        self._last_positions: dict = {}
        self._baseline_positions: dict = {}
        self._frame_count: int = 0

    def process_frame(self, frame: np.ndarray, face_landmarks: Optional[np.ndarray] = None) -> HandGestureMetrics:
        """
        Process a single BGR video frame.
        face_landmarks: optional 478x3 array from face analyzer for self-touch detection.
        """
        import cv2
        now = time.time()
        self._frame_count += 1
        h, w = frame.shape[:2]

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.hands.process(rgb)

        if not results.multi_hand_landmarks:
            return HandGestureMetrics(
                timestamp=now, hands_detected=0,
                left_hand_visible=False, right_hand_visible=False,
                movement_speed_left=0, movement_speed_right=0,
                jitter_score=0, tremor_score=0,
                fidgeting_score=0, self_touch_detected=False,
                tapping_detected=False, hand_wringing_detected=False,
                hand_position_zone='NEUTRAL', hand_elevation='MID',
                hands_clasped=False, gesturing_actively=False,
                gesture_confidence=80,
            )

        # Parse handedness
        hands_data = {}
        for i, hand_lm in enumerate(results.multi_hand_landmarks):
            handedness = results.multi_handedness[i].classification[0]
            idx = 0 if handedness.label == 'Left' else 1
            pts = np.array([(lm.x * w, lm.y * h, lm.z * w) for lm in hand_lm.landmark])
            hands_data[idx] = pts

        # ── Movement analysis per hand ───────────────────────────────────
        speeds = {0: 0.0, 1: 0.0}
        for idx, pts in hands_data.items():
            wrist = pts[0][:2]
            self._position_history[idx].append(wrist)

            if idx in self._last_positions:
                speed = np.linalg.norm(wrist - self._last_positions[idx])
                speeds[idx] = float(speed)
                self._speed_history[idx].append(speed)

            self._last_positions[idx] = wrist

            # Track fingertip positions for tremor
            tips = pts[[4, 8, 12, 16, 20]][:, :2]  # thumb, index, middle, ring, pinky
            self._finger_tip_history[idx].append(tips)

        # ── Jitter score ─────────────────────────────────────────────────
        jitter = self._compute_jitter(hands_data)

        # ── Tremor score ─────────────────────────────────────────────────
        tremor = self._compute_tremor(hands_data)

        # ── Fidgeting ────────────────────────────────────────────────────
        fidgeting = self._compute_fidgeting(hands_data)

        # ── Self-touch detection ─────────────────────────────────────────
        self_touch, zone = self._detect_self_touch(hands_data, face_landmarks, h)

        # ── Tapping detection ────────────────────────────────────────────
        tapping = self._detect_tapping(hands_data)

        # ── Hand wringing ────────────────────────────────────────────────
        wringing = self._detect_wringing(hands_data)

        # ── Clasped hands ────────────────────────────────────────────────
        clasped = self._detect_clasped(hands_data)

        # ── Active gesturing ─────────────────────────────────────────────
        active = self._detect_active_gesturing(hands_data)

        # ── Elevation ────────────────────────────────────────────────────
        elevation = self._compute_elevation(hands_data, h)

        # ── Confidence ───────────────────────────────────────────────────
        confidence = self._compute_confidence(jitter, tremor, fidgeting, self_touch, tapping, wringing)

        return HandGestureMetrics(
            timestamp=now,
            hands_detected=len(hands_data),
            left_hand_visible=0 in hands_data,
            right_hand_visible=1 in hands_data,
            movement_speed_left=round(speeds.get(0, 0), 2),
            movement_speed_right=round(speeds.get(1, 0), 2),
            jitter_score=round(jitter, 1),
            tremor_score=round(tremor, 1),
            fidgeting_score=round(fidgeting, 1),
            self_touch_detected=self_touch,
            tapping_detected=tapping,
            hand_wringing_detected=wringing,
            hand_position_zone=zone,
            hand_elevation=elevation,
            hands_clasped=clasped,
            gesturing_actively=active,
            gesture_confidence=round(confidence, 1),
        )

    # ── Jitter (high-frequency noise in position) ────────────────────────────────

    def _compute_jitter(self, hands_data: dict) -> float:
        jitters = []
        for idx in hands_data:
            hist = list(self._speed_history[idx])
            if len(hist) < 5:
                continue
            recent = np.array(hist[-15:])
            # Jitter = variance of speed (stable hand has consistent speed)
            jitter = float(np.std(recent)) * 5
            jitters.append(min(100, jitter))
        return np.mean(jitters) if jitters else 0

    # ── Tremor (oscillating small movements) ─────────────────────────────────────

    def _compute_tremor(self, hands_data: dict) -> float:
        tremors = []
        for idx in hands_data:
            tips_hist = list(self._finger_tip_history[idx])
            if len(tips_hist) < 10:
                continue
            # Track index finger tip oscillation
            positions = np.array([t[1] for t in tips_hist[-15:]])  # index fingertip
            if len(positions) < 5:
                continue
            # Compute direction changes (sign changes in velocity)
            velocities = np.diff(positions, axis=0)
            if len(velocities) < 3:
                continue
            signs = np.sign(velocities[:, 0])  # x-direction
            direction_changes = np.sum(np.abs(np.diff(signs)) > 0)
            # More direction changes in short window = more tremor
            tremor = min(100, (direction_changes / len(signs)) * 200)
            tremors.append(tremor)
        return float(np.mean(tremors)) if tremors else 0

    # ── Fidgeting (rapid small-amplitude movements) ──────────────────────────────

    def _compute_fidgeting(self, hands_data: dict) -> float:
        scores = []
        for idx in hands_data:
            hist = list(self._speed_history[idx])
            if len(hist) < 10:
                continue
            recent = np.array(hist[-20:])
            # Fidgeting = many small movements (speed > 2 but < 20)
            small_moves = np.sum((recent > 2) & (recent < 20))
            fidget = min(100, (small_moves / len(recent)) * 150)
            scores.append(fidget)
        return float(np.mean(scores)) if scores else 0

    # ── Self-touch detection ─────────────────────────────────────────────────────

    def _detect_self_touch(self, hands_data: dict, face_lm: Optional[np.ndarray], frame_h: int) -> tuple:
        zone = 'NEUTRAL'
        touching = False

        for idx, pts in hands_data.items():
            fingertips = pts[[4, 8, 12]][:, :2]  # thumb, index, middle

            if face_lm is not None:
                # Check if fingers are near face landmarks
                nose = face_lm[1][:2]
                chin = face_lm[152][:2]
                forehead = face_lm[10][:2]

                for tip in fingertips:
                    if np.linalg.norm(tip - nose) < 60:
                        touching = True
                        zone = 'FACE'
                    elif np.linalg.norm(tip - forehead) < 80:
                        touching = True
                        zone = 'HAIR'
                    elif np.linalg.norm(tip - chin) < 50:
                        touching = True
                        zone = 'FACE'
            else:
                # Heuristic: hand in upper third of frame ≈ near face
                wrist_y = pts[0][1]
                if wrist_y < frame_h * 0.35:
                    zone = 'FACE'
                    touching = True

        return touching, zone

    # ── Tapping detection ────────────────────────────────────────────────────────

    def _detect_tapping(self, hands_data: dict) -> bool:
        for idx in hands_data:
            tips = list(self._finger_tip_history[idx])
            if len(tips) < 10:
                continue
            # Check index finger rapid vertical oscillation
            y_positions = [t[1][1] for t in tips[-10:]]
            if len(y_positions) < 5:
                continue
            velocities = np.diff(y_positions)
            signs = np.sign(velocities)
            changes = np.sum(np.abs(np.diff(signs)) > 0)
            if changes > 5:  # Multiple direction changes = tapping
                return True
        return False

    # ── Hand wringing ────────────────────────────────────────────────────────────

    def _detect_wringing(self, hands_data: dict) -> bool:
        if len(hands_data) < 2:
            return False
        left_wrist = hands_data.get(0, np.zeros((21, 3)))[0][:2]
        right_wrist = hands_data.get(1, np.zeros((21, 3)))[0][:2]
        dist = np.linalg.norm(left_wrist - right_wrist)

        # Hands close together + both moving
        left_speed = list(self._speed_history[0])[-1] if self._speed_history[0] else 0
        right_speed = list(self._speed_history[1])[-1] if self._speed_history[1] else 0

        return dist < 80 and left_speed > 3 and right_speed > 3

    # ── Clasped hands ────────────────────────────────────────────────────────────

    def _detect_clasped(self, hands_data: dict) -> bool:
        if len(hands_data) < 2:
            return False
        left_wrist = hands_data.get(0, np.zeros((21, 3)))[0][:2]
        right_wrist = hands_data.get(1, np.zeros((21, 3)))[0][:2]
        dist = np.linalg.norm(left_wrist - right_wrist)

        left_speed = list(self._speed_history[0])[-1] if self._speed_history[0] else 0
        right_speed = list(self._speed_history[1])[-1] if self._speed_history[1] else 0

        return dist < 50 and left_speed < 3 and right_speed < 3

    # ── Active gesturing ─────────────────────────────────────────────────────────

    def _detect_active_gesturing(self, hands_data: dict) -> bool:
        for idx in hands_data:
            hist = list(self._speed_history[idx])
            if len(hist) < 5:
                continue
            avg_speed = np.mean(hist[-10:])
            if avg_speed > 15:  # Meaningful movement
                return True
        return False

    # ── Elevation ────────────────────────────────────────────────────────────────

    def _compute_elevation(self, hands_data: dict, frame_h: int) -> str:
        if not hands_data:
            return 'MID'
        avg_y = np.mean([pts[0][1] for pts in hands_data.values()])
        if avg_y < frame_h * 0.33:
            return 'HIGH'
        elif avg_y > frame_h * 0.66:
            return 'LOW'
        return 'MID'

    # ── Confidence score ─────────────────────────────────────────────────────────

    def _compute_confidence(self, jitter: float, tremor: float, fidgeting: float,
                            self_touch: bool, tapping: bool, wringing: bool) -> float:
        score = 100
        score -= jitter * 0.2
        score -= tremor * 0.25
        score -= fidgeting * 0.15
        if self_touch:
            score -= 10
        if tapping:
            score -= 8
        if wringing:
            score -= 15
        return max(0, min(100, score))

    def release(self):
        self.hands.close()
