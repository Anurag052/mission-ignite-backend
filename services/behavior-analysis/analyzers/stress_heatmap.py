"""
Stress Heatmap Generator — Spatial and temporal stress visualization.

Generates a 2D stress heatmap overlaying the candidate's face/body,
showing areas of highest behavioral stress indicators.

Output: 64x48 grid of stress intensity values (0-255) for frontend rendering.
"""

import time
from collections import deque
from dataclasses import dataclass
from typing import Optional

import numpy as np

from .face_analyzer import FaceSnapshot
from .hand_gesture_analyzer import HandGestureMetrics
from .audio_analyzer import AudioMetrics


@dataclass
class HeatmapFrame:
    """Single frame of the stress heatmap."""
    timestamp: float
    grid: list                    # 2D list [rows][cols] of 0-255 values
    resolution: tuple             # (width, height)
    peak_zones: list              # List of { zone, intensity, x, y }
    overall_stress_level: float   # 0-100
    dominant_indicator: str       # Which indicator is causing most stress


class StressHeatmapGenerator:
    """
    Generates spatial stress heatmaps by mapping behavioral indicators
    to facial/body regions.

    Regions:
      - Eyes (upper center)       ← eye movement, blink rate, gaze instability
      - Forehead (top center)     ← eyebrow tension, head pitch
      - Mouth (lower center)      ← lip compression, jaw clench, speech issues
      - Left cheek / Right cheek  ← facial tension asymmetry
      - Hands (lower sides)       ← gesture instability
      - Throat (center-lower)     ← voice tremor
    """

    # Region definitions: (y_start, y_end, x_start, x_end) as fractions of grid
    REGIONS = {
        'FOREHEAD':     (0.00, 0.20, 0.25, 0.75),
        'LEFT_EYE':     (0.15, 0.35, 0.10, 0.45),
        'RIGHT_EYE':    (0.15, 0.35, 0.55, 0.90),
        'NOSE':         (0.30, 0.50, 0.35, 0.65),
        'LEFT_CHEEK':   (0.35, 0.60, 0.05, 0.35),
        'RIGHT_CHEEK':  (0.35, 0.60, 0.65, 0.95),
        'MOUTH':        (0.55, 0.75, 0.25, 0.75),
        'CHIN':         (0.70, 0.85, 0.30, 0.70),
        'THROAT':       (0.80, 0.95, 0.30, 0.70),
        'LEFT_HAND':    (0.60, 1.00, 0.00, 0.20),
        'RIGHT_HAND':   (0.60, 1.00, 0.80, 1.00),
    }

    def __init__(self, resolution: tuple = (64, 48)):
        self.width, self.height = resolution
        self._history: deque = deque(maxlen=60)  # ~2s at 30fps
        self._decay_rate = 0.85  # Temporal smoothing (previous frame retention)
        self._current_grid: Optional[np.ndarray] = None

    def generate(
        self,
        face: Optional[FaceSnapshot],
        hands: Optional[HandGestureMetrics],
        audio: Optional[AudioMetrics],
    ) -> HeatmapFrame:
        """Generate a single heatmap frame from all analyzer outputs."""
        now = time.time()

        # Start with decayed previous grid or zeros
        if self._current_grid is not None:
            grid = self._current_grid * self._decay_rate
        else:
            grid = np.zeros((self.height, self.width), dtype=np.float32)

        indicators = {}

        # ── Map face metrics to regions ──────────────────────────────────
        if face and face.face_detected and face.eye:
            # Eye stress: gaze instability + high blink rate + saccades
            eye_stress = (
                (100 - face.eye.gaze_stability) * 0.4 +
                min(100, face.eye.blink_rate_per_min * 2) * 0.3 +
                (50 if face.eye.saccade_detected else 0) * 0.3
            )
            self._paint_region(grid, 'LEFT_EYE', eye_stress)
            self._paint_region(grid, 'RIGHT_EYE', eye_stress)
            indicators['eye_stress'] = eye_stress

            # Forehead: eyebrow raise (surprise/fear) + head movement
            if face.expression:
                forehead_stress = (
                    face.expression.surprise_score * 0.3 +
                    face.expression.fear_score * 0.4 +
                    min(100, abs(face.head_pitch) * 2) * 0.3
                )
                self._paint_region(grid, 'FOREHEAD', forehead_stress)
                indicators['forehead_stress'] = forehead_stress

                # Mouth: lip compression + jaw clench
                mouth_stress = (
                    face.expression.lip_compression * 0.4 +
                    face.expression.jaw_clench * 0.3 +
                    face.expression.anger_score * 0.15 +
                    face.expression.disgust_score * 0.15
                )
                self._paint_region(grid, 'MOUTH', mouth_stress)
                indicators['mouth_stress'] = mouth_stress

                # Cheeks: facial tension (asymmetry)
                cheek_stress = face.facial_tension * 0.6 + face.expression.contempt_score * 0.4
                self._paint_region(grid, 'LEFT_CHEEK', cheek_stress)
                self._paint_region(grid, 'RIGHT_CHEEK', cheek_stress * (0.7 + face.expression.contempt_score * 0.003))
                indicators['cheek_stress'] = cheek_stress

        # ── Map audio metrics to throat region ───────────────────────────
        if audio:
            throat_stress = (
                audio.voice_tremor_score * 0.35 +
                (100 - audio.volume_stability) * 0.25 +
                min(100, audio.silence_ratio * 200) * 0.2 +
                (30 if audio.vocal_fry_detected else 0) * 0.1 +
                (30 if audio.pressed_voice_detected else 0) * 0.1
            )
            self._paint_region(grid, 'THROAT', throat_stress)
            self._paint_region(grid, 'CHIN', throat_stress * 0.5)
            indicators['vocal_stress'] = throat_stress

        # ── Map hand metrics to hand regions ─────────────────────────────
        if hands and hands.hands_detected > 0:
            hand_stress = (
                hands.jitter_score * 0.25 +
                hands.tremor_score * 0.25 +
                hands.fidgeting_score * 0.2 +
                (30 if hands.self_touch_detected else 0) * 0.15 +
                (25 if hands.tapping_detected else 0) * 0.15
            )
            if hands.left_hand_visible:
                self._paint_region(grid, 'LEFT_HAND', hand_stress)
            if hands.right_hand_visible:
                self._paint_region(grid, 'RIGHT_HAND', hand_stress)
            indicators['hand_stress'] = hand_stress

        # Clip and store
        grid = np.clip(grid, 0, 255)
        self._current_grid = grid

        # Find peak zones
        peak_zones = self._find_peak_zones(grid)

        # Overall stress level
        overall = float(np.mean(grid[grid > 10])) if np.any(grid > 10) else 0

        # Dominant indicator
        dominant = max(indicators, key=indicators.get) if indicators else 'none'

        self._history.append(overall)

        return HeatmapFrame(
            timestamp=now,
            grid=grid.astype(np.uint8).tolist(),
            resolution=(self.width, self.height),
            peak_zones=peak_zones,
            overall_stress_level=round(overall, 1),
            dominant_indicator=dominant,
        )

    # ── Private ──────────────────────────────────────────────────────────────────

    def _paint_region(self, grid: np.ndarray, region_name: str, intensity: float):
        """Paint a region on the grid with given intensity (additive, Gaussian falloff)."""
        if region_name not in self.REGIONS:
            return
        y1f, y2f, x1f, x2f = self.REGIONS[region_name]
        y1, y2 = int(y1f * self.height), int(y2f * self.height)
        x1, x2 = int(x1f * self.width), int(x2f * self.width)

        # Create Gaussian blob
        cy = (y1 + y2) // 2
        cx = (x1 + x2) // 2
        ry = max(1, (y2 - y1) // 2)
        rx = max(1, (x2 - x1) // 2)

        for y in range(max(0, y1), min(self.height, y2)):
            for x in range(max(0, x1), min(self.width, x2)):
                dy = (y - cy) / ry
                dx = (x - cx) / rx
                falloff = np.exp(-0.5 * (dx ** 2 + dy ** 2))
                grid[y, x] += intensity * falloff * 2.55  # scale 0-100 → 0-255

    def _find_peak_zones(self, grid: np.ndarray) -> list:
        """Find the top stress zones on the heatmap."""
        peaks = []
        for name, (y1f, y2f, x1f, x2f) in self.REGIONS.items():
            y1, y2 = int(y1f * self.height), int(y2f * self.height)
            x1, x2 = int(x1f * self.width), int(x2f * self.width)
            region = grid[y1:y2, x1:x2]
            if region.size == 0:
                continue
            intensity = float(np.mean(region))
            if intensity > 15:
                max_pos = np.unravel_index(np.argmax(region), region.shape)
                peaks.append({
                    'zone': name,
                    'intensity': round(intensity, 1),
                    'x': int(x1 + max_pos[1]),
                    'y': int(y1 + max_pos[0]),
                })
        return sorted(peaks, key=lambda p: p['intensity'], reverse=True)[:5]
