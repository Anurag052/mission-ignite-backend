"""
Face Analyzer — Eye tracking, micro-expression detection, gaze analysis.

Uses MediaPipe Face Mesh (478 3D landmarks) for:
  - Eye movement tracking (gaze direction, saccades, fixation)
  - Blink rate & blink duration
  - Micro-expression detection (AU-based: surprise, fear, disgust, contempt)
  - Facial tension mapping
  - Lip compression / mouth dryness indicators
"""

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

import cv2
import mediapipe as mp
import numpy as np

# ─── MediaPipe landmark indices ──────────────────────────────────────────────────

# Eye landmarks (Face Mesh 478 model)
LEFT_EYE_UPPER  = [159, 145, 160, 161, 158, 157, 173]
LEFT_EYE_LOWER  = [144, 153, 154, 155, 133, 163, 7]
RIGHT_EYE_UPPER = [386, 374, 387, 388, 385, 384, 398]
RIGHT_EYE_LOWER = [373, 380, 381, 382, 362, 390, 249]
LEFT_IRIS       = [468, 469, 470, 471, 472]
RIGHT_IRIS      = [473, 474, 475, 476, 477]

# Eyebrow landmarks
LEFT_EYEBROW    = [70, 63, 105, 66, 107]
RIGHT_EYEBROW   = [300, 293, 334, 296, 336]

# Mouth landmarks
UPPER_LIP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]
LOWER_LIP = [146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 61]
MOUTH_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
               409, 270, 269, 267, 0, 37, 39, 40, 185]

# Nose tip
NOSE_TIP = 1


@dataclass
class EyeMetrics:
    """Per-frame eye analysis result."""
    gaze_direction: tuple  # (horizontal -1..1, vertical -1..1)
    gaze_stability: float  # 0-100 (100 = perfectly stable)
    blink_detected: bool
    blink_rate_per_min: float
    eye_openness_left: float   # 0-1
    eye_openness_right: float  # 0-1
    pupil_dilation_change: float  # relative change from baseline
    saccade_detected: bool     # rapid eye movement
    fixation_duration_ms: float  # how long gaze stayed in one spot


@dataclass
class MicroExpressionMetrics:
    """Facial muscle movement analysis (Action Unit approximation)."""
    surprise_score: float      # 0-100 (eyebrow raise + eye widen)
    fear_score: float          # 0-100 (eyebrow raise + lip stretch)
    disgust_score: float       # 0-100 (nose wrinkle + upper lip raise)
    contempt_score: float      # 0-100 (asymmetric lip corner)
    anger_score: float         # 0-100 (brow lower + lip press)
    lip_compression: float     # 0-100 (stress indicator)
    jaw_clench: float          # 0-100
    neutral_score: float       # 0-100 (no expression)


@dataclass
class FaceSnapshot:
    """Complete face analysis for a single frame."""
    timestamp: float
    face_detected: bool
    eye: Optional[EyeMetrics] = None
    expression: Optional[MicroExpressionMetrics] = None
    head_pitch: float = 0.0    # degrees (nod)
    head_yaw: float = 0.0      # degrees (shake)
    head_roll: float = 0.0     # degrees (tilt)
    facial_tension: float = 0.0  # 0-100 overall tension score


class FaceAnalyzer:
    """Real-time face analysis using MediaPipe Face Mesh."""

    def __init__(self, max_faces: int = 1, min_detection: float = 0.5, min_tracking: float = 0.5):
        self.mp_face_mesh = mp.solutions.face_mesh
        self.face_mesh = self.mp_face_mesh.FaceMesh(
            max_num_faces=max_faces,
            refine_landmarks=True,  # Enables iris landmarks
            min_detection_confidence=min_detection,
            min_tracking_confidence=min_tracking,
        )

        # State tracking
        self._blink_history: deque = deque(maxlen=300)  # ~10s at 30fps
        self._gaze_history: deque = deque(maxlen=30)    # ~1s
        self._last_blink_time: float = 0
        self._fixation_start: float = 0
        self._last_gaze: tuple = (0.0, 0.0)
        self._baseline_landmarks: Optional[np.ndarray] = None
        self._frame_count: int = 0

    def process_frame(self, frame: np.ndarray) -> FaceSnapshot:
        """
        Process a single BGR video frame.
        Returns a FaceSnapshot with all metrics.
        """
        now = time.time()
        self._frame_count += 1
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.face_mesh.process(rgb)

        if not results.multi_face_landmarks:
            return FaceSnapshot(timestamp=now, face_detected=False)

        landmarks = results.multi_face_landmarks[0]
        h, w = frame.shape[:2]
        pts = np.array([(lm.x * w, lm.y * h, lm.z * w) for lm in landmarks.landmark])

        # Calibrate baseline from first 30 frames
        if self._frame_count <= 30:
            if self._baseline_landmarks is None:
                self._baseline_landmarks = pts.copy()
            else:
                self._baseline_landmarks = 0.9 * self._baseline_landmarks + 0.1 * pts

        eye = self._analyze_eyes(pts, now)
        expression = self._analyze_expression(pts)
        pitch, yaw, roll = self._estimate_head_pose(pts, w, h)
        tension = self._compute_facial_tension(expression)

        return FaceSnapshot(
            timestamp=now,
            face_detected=True,
            eye=eye,
            expression=expression,
            head_pitch=pitch,
            head_yaw=yaw,
            head_roll=roll,
            facial_tension=tension,
        )

    # ── Eye Analysis ─────────────────────────────────────────────────────────────

    def _analyze_eyes(self, pts: np.ndarray, now: float) -> EyeMetrics:
        # Eye openness (Eye Aspect Ratio)
        left_ear = self._eye_aspect_ratio(pts, LEFT_EYE_UPPER, LEFT_EYE_LOWER)
        right_ear = self._eye_aspect_ratio(pts, RIGHT_EYE_UPPER, RIGHT_EYE_LOWER)

        # Blink detection
        avg_ear = (left_ear + right_ear) / 2
        blink = avg_ear < 0.21
        self._blink_history.append((now, blink))

        if blink and (now - self._last_blink_time) > 0.15:
            self._last_blink_time = now

        # Blink rate (per minute)
        recent_blinks = [(t, b) for t, b in self._blink_history if now - t < 10]
        blink_count = sum(1 for i in range(1, len(recent_blinks))
                         if recent_blinks[i][1] and not recent_blinks[i - 1][1])
        blink_rate = blink_count * 6  # extrapolate 10s to 60s

        # Gaze direction from iris center relative to eye bounds
        gaze_h, gaze_v = self._compute_gaze(pts)
        self._gaze_history.append((gaze_h, gaze_v))

        # Gaze stability (low variance = stable)
        if len(self._gaze_history) > 5:
            gaze_arr = np.array(list(self._gaze_history))
            stability = max(0, 100 - np.std(gaze_arr) * 500)
        else:
            stability = 80.0

        # Saccade detection (sudden gaze shift > threshold)
        saccade = False
        if len(self._gaze_history) > 2:
            prev = self._gaze_history[-2]
            diff = math.sqrt((gaze_h - prev[0]) ** 2 + (gaze_v - prev[1]) ** 2)
            saccade = diff > 0.15

        # Fixation duration
        if saccade:
            fixation_dur = (now - self._fixation_start) * 1000
            self._fixation_start = now
        else:
            fixation_dur = (now - self._fixation_start) * 1000 if self._fixation_start > 0 else 0

        # Pupil dilation change (approximated by iris size relative to eye)
        pupil_change = 0.0
        if self._baseline_landmarks is not None:
            curr_iris_size = np.linalg.norm(pts[LEFT_IRIS[0]] - pts[LEFT_IRIS[2]])
            base_iris_size = np.linalg.norm(
                self._baseline_landmarks[LEFT_IRIS[0]] - self._baseline_landmarks[LEFT_IRIS[2]]
            )
            if base_iris_size > 0:
                pupil_change = (curr_iris_size - base_iris_size) / base_iris_size

        return EyeMetrics(
            gaze_direction=(round(gaze_h, 3), round(gaze_v, 3)),
            gaze_stability=round(stability, 1),
            blink_detected=blink,
            blink_rate_per_min=round(blink_rate, 1),
            eye_openness_left=round(left_ear, 3),
            eye_openness_right=round(right_ear, 3),
            pupil_dilation_change=round(pupil_change, 4),
            saccade_detected=saccade,
            fixation_duration_ms=round(fixation_dur, 1),
        )

    def _eye_aspect_ratio(self, pts: np.ndarray, upper: list, lower: list) -> float:
        """Compute Eye Aspect Ratio (EAR) for blink detection."""
        upper_pts = pts[upper]
        lower_pts = pts[lower]
        vertical = np.mean(np.linalg.norm(upper_pts - lower_pts, axis=1))
        horizontal = np.linalg.norm(pts[upper[0]] - pts[upper[-1]])
        return vertical / (horizontal + 1e-6)

    def _compute_gaze(self, pts: np.ndarray) -> tuple:
        """Compute horizontal/vertical gaze direction from iris position."""
        # Left eye: iris center relative to eye corners
        left_iris_center = pts[LEFT_IRIS[0]][:2]
        left_inner = pts[133][:2]
        left_outer = pts[33][:2]
        left_top = pts[159][:2]
        left_bottom = pts[145][:2]

        eye_width = np.linalg.norm(left_outer - left_inner) + 1e-6
        eye_height = np.linalg.norm(left_top - left_bottom) + 1e-6

        h_ratio = (np.linalg.norm(left_iris_center - left_inner) / eye_width) * 2 - 1
        v_ratio = (np.linalg.norm(left_iris_center - left_top) / eye_height) * 2 - 1

        return float(np.clip(h_ratio, -1, 1)), float(np.clip(v_ratio, -1, 1))

    # ── Micro-Expression Analysis ────────────────────────────────────────────────

    def _analyze_expression(self, pts: np.ndarray) -> MicroExpressionMetrics:
        """Approximate Action Units from landmark distances."""
        baseline = self._baseline_landmarks if self._baseline_landmarks is not None else pts

        # AU2: Eyebrow raise → surprise/fear
        brow_raise = self._landmark_distance_change(pts, baseline, LEFT_EYEBROW[2], 33) * 100
        brow_raise = max(0, min(100, brow_raise * 3))

        # Eye widening → surprise
        eye_open = (self._eye_aspect_ratio(pts, LEFT_EYE_UPPER, LEFT_EYE_LOWER) - 0.3) * 200
        surprise = min(100, max(0, (brow_raise * 0.6 + max(0, eye_open) * 0.4)))

        # Fear = brow raise + mouth stretch
        mouth_open = self._mouth_openness(pts) * 100
        fear = min(100, max(0, brow_raise * 0.5 + mouth_open * 0.5))

        # Disgust = nose wrinkle (approximated by nose-lip distance change)
        nose_lip_change = self._landmark_distance_change(pts, baseline, NOSE_TIP, 17) * 100
        disgust = min(100, max(0, -nose_lip_change * 5))

        # Contempt = asymmetric lip corner
        left_corner = pts[61][:2]
        right_corner = pts[291][:2]
        lip_asymmetry = abs(left_corner[1] - right_corner[1]) / (abs(left_corner[0] - right_corner[0]) + 1e-6)
        contempt = min(100, max(0, lip_asymmetry * 300))

        # Anger = brow lower + lip press
        brow_lower = max(0, -brow_raise)
        lip_press = self._lip_compression(pts) * 100
        anger = min(100, max(0, brow_lower * 0.4 + lip_press * 0.6))

        # Jaw clench (distance between upper/lower jaw landmarks)
        jaw_clench = max(0, 100 - mouth_open * 2)

        # Neutral = inverse of all expressions
        max_expr = max(surprise, fear, disgust, contempt, anger)
        neutral = max(0, 100 - max_expr)

        return MicroExpressionMetrics(
            surprise_score=round(surprise, 1),
            fear_score=round(fear, 1),
            disgust_score=round(disgust, 1),
            contempt_score=round(contempt, 1),
            anger_score=round(anger, 1),
            lip_compression=round(lip_press, 1),
            jaw_clench=round(jaw_clench, 1),
            neutral_score=round(neutral, 1),
        )

    def _mouth_openness(self, pts: np.ndarray) -> float:
        """Mouth openness (0 = closed, 1 = wide open)."""
        upper = pts[13][:2]  # upper lip center
        lower = pts[14][:2]  # lower lip center
        left = pts[61][:2]
        right = pts[291][:2]
        vertical = np.linalg.norm(upper - lower)
        horizontal = np.linalg.norm(left - right)
        return float(vertical / (horizontal + 1e-6))

    def _lip_compression(self, pts: np.ndarray) -> float:
        """Lip compression ratio (high = lips pressed together)."""
        upper = pts[13][:2]
        lower = pts[14][:2]
        dist = np.linalg.norm(upper - lower)
        # Normalized — tighter lips = higher score
        return max(0, 1 - dist * 8)

    def _landmark_distance_change(self, pts: np.ndarray, baseline: np.ndarray, idx_a: int, idx_b: int) -> float:
        """Relative distance change between two landmarks vs baseline."""
        curr = np.linalg.norm(pts[idx_a][:2] - pts[idx_b][:2])
        base = np.linalg.norm(baseline[idx_a][:2] - baseline[idx_b][:2])
        return float((curr - base) / (base + 1e-6))

    # ── Head Pose Estimation ─────────────────────────────────────────────────────

    def _estimate_head_pose(self, pts: np.ndarray, w: int, h: int) -> tuple:
        """Estimate head pitch/yaw/roll using solvePnP."""
        # 6-point model for PnP
        model_points = np.array([
            (0.0, 0.0, 0.0),        # Nose tip
            (0.0, -330.0, -65.0),    # Chin
            (-225.0, 170.0, -135.0), # Left eye corner
            (225.0, 170.0, -135.0),  # Right eye corner
            (-150.0, -150.0, -125.0),# Left mouth corner
            (150.0, -150.0, -125.0), # Right mouth corner
        ], dtype=np.float64)

        image_points = np.array([
            pts[NOSE_TIP][:2],  # Nose tip
            pts[152][:2],       # Chin
            pts[33][:2],        # Left eye corner
            pts[263][:2],       # Right eye corner
            pts[61][:2],        # Left mouth
            pts[291][:2],       # Right mouth
        ], dtype=np.float64)

        focal = w
        camera_matrix = np.array([
            [focal, 0, w / 2],
            [0, focal, h / 2],
            [0, 0, 1],
        ], dtype=np.float64)

        dist_coeffs = np.zeros((4, 1))
        success, rvec, tvec = cv2.solvePnP(model_points, image_points, camera_matrix, dist_coeffs)

        if not success:
            return 0.0, 0.0, 0.0

        rmat, _ = cv2.Rodrigues(rvec)
        angles, _, _, _, _, _ = cv2.RQDecomp3x3(rmat)

        return round(float(angles[0]), 2), round(float(angles[1]), 2), round(float(angles[2]), 2)

    # ── Facial Tension Score ─────────────────────────────────────────────────────

    def _compute_facial_tension(self, expr: MicroExpressionMetrics) -> float:
        """Composite tension from expression data — higher = more tense."""
        tension = (
            expr.anger_score * 0.25 +
            expr.fear_score * 0.20 +
            expr.lip_compression * 0.20 +
            expr.jaw_clench * 0.20 +
            expr.disgust_score * 0.15
        )
        return round(min(100, max(0, tension)), 1)

    def release(self):
        """Release MediaPipe resources."""
        self.face_mesh.close()
