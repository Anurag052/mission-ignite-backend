"""
Audio Analyzer — Speech rate, voice tremor, silence gaps, prosody analysis.

Processes raw PCM/WAV audio chunks for:
  - Speech rate (words per minute estimation via energy segmentation)
  - Voice tremor (pitch jitter / shimmer)
  - Silence gap detection (duration & frequency)
  - Volume stability
  - Pitch contour analysis
  - Stress vocal indicators (pressed voice, vocal fry)
"""

import time
from collections import deque
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

try:
    import librosa
    HAS_LIBROSA = True
except ImportError:
    HAS_LIBROSA = False


@dataclass
class AudioMetrics:
    """Per-chunk audio analysis result."""
    timestamp: float

    # Speech rate
    speech_rate_wpm: float                # estimated words per minute
    speech_rate_stability: float          # 0-100 (100 = very consistent)
    syllable_rate: float                  # syllables per second estimate

    # Voice tremor
    pitch_mean_hz: float
    pitch_std_hz: float                   # high std = unstable
    pitch_jitter_percent: float           # cycle-to-cycle F0 variation
    shimmer_percent: float                # cycle-to-cycle amplitude variation
    voice_tremor_score: float             # 0-100 composite

    # Silence gaps
    silence_duration_ms: float            # current silence streak
    silence_count_last_30s: int           # number of silence gaps in last 30s
    silence_ratio: float                  # % time silent in recent window
    longest_silence_ms: float             # longest gap in recent window

    # Volume
    volume_rms: float                     # current RMS energy (dB)
    volume_stability: float               # 0-100
    volume_drop_detected: bool            # sudden volume decrease

    # Prosody
    pitch_contour: str                    # 'RISING' | 'FALLING' | 'FLAT' | 'ERRATIC'
    vocal_fry_detected: bool              # very low pitch + irregular
    pressed_voice_detected: bool          # tight, strained voice

    # Composite
    vocal_confidence: float               # 0-100


class AudioAnalyzer:
    """Real-time audio analysis for behavioral indicators."""

    SAMPLE_RATE = 16000          # Expected sample rate
    CHUNK_DURATION_MS = 1000     # Expected chunk size from client
    SILENCE_THRESHOLD_DB = -40   # Below this = silence
    MIN_PITCH_HZ = 50
    MAX_PITCH_HZ = 500

    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate

        # Rolling state
        self._pitch_history: deque = deque(maxlen=300)  # ~5 min at 1 chunk/sec
        self._volume_history: deque = deque(maxlen=300)
        self._speech_rate_history: deque = deque(maxlen=60)
        self._silence_events: deque = deque(maxlen=100)
        self._is_silent: bool = False
        self._silence_start: float = 0
        self._volume_baseline: Optional[float] = None
        self._pitch_baseline: Optional[float] = None
        self._frame_count: int = 0

    def process_chunk(self, audio_data: np.ndarray, timestamp: Optional[float] = None) -> AudioMetrics:
        """
        Process a single audio chunk (1D float32 array, mono, 16kHz).
        """
        now = timestamp or time.time()
        self._frame_count += 1

        # Ensure float32 normalized
        if audio_data.dtype != np.float32:
            audio_data = audio_data.astype(np.float32)
        if np.max(np.abs(audio_data)) > 1.0:
            audio_data = audio_data / 32768.0

        # ── Volume analysis ──────────────────────────────────────────────
        rms = float(np.sqrt(np.mean(audio_data ** 2)) + 1e-10)
        rms_db = 20 * np.log10(rms + 1e-10)
        self._volume_history.append(rms_db)

        if self._frame_count <= 30 and rms_db > self.SILENCE_THRESHOLD_DB:
            if self._volume_baseline is None:
                self._volume_baseline = rms_db
            else:
                self._volume_baseline = 0.9 * self._volume_baseline + 0.1 * rms_db

        volume_stability = self._compute_volume_stability()
        volume_drop = self._detect_volume_drop(rms_db)

        # ── Silence detection ────────────────────────────────────────────
        is_silent = rms_db < self.SILENCE_THRESHOLD_DB
        silence_ms = 0.0

        if is_silent and not self._is_silent:
            self._silence_start = now
            self._is_silent = True
        elif not is_silent and self._is_silent:
            silence_ms = (now - self._silence_start) * 1000
            self._silence_events.append((now, silence_ms))
            self._is_silent = False
        elif is_silent:
            silence_ms = (now - self._silence_start) * 1000

        silence_30s = [(t, d) for t, d in self._silence_events if now - t < 30]
        silence_count = len(silence_30s)
        longest_silence = max([d for _, d in silence_30s], default=0)
        silence_ratio = sum(d for _, d in silence_30s) / 30000 if silence_30s else 0

        # ── Pitch analysis ───────────────────────────────────────────────
        pitch_mean, pitch_std, jitter, shimmer = self._analyze_pitch(audio_data)
        if pitch_mean > 0:
            self._pitch_history.append(pitch_mean)

        if self._frame_count <= 30 and pitch_mean > 0:
            if self._pitch_baseline is None:
                self._pitch_baseline = pitch_mean
            else:
                self._pitch_baseline = 0.9 * self._pitch_baseline + 0.1 * pitch_mean

        tremor_score = self._compute_tremor_score(jitter, shimmer)

        # ── Speech rate estimation ───────────────────────────────────────
        speech_rate, syllable_rate = self._estimate_speech_rate(audio_data)
        self._speech_rate_history.append(speech_rate)
        rate_stability = self._compute_rate_stability()

        # ── Prosody ──────────────────────────────────────────────────────
        contour = self._analyze_pitch_contour()
        vocal_fry = pitch_mean > 0 and pitch_mean < 80 and jitter > 5
        pressed = pitch_std > 0 and pitch_std < 5 and rms_db > -20  # tight consistent pitch

        # ── Composite confidence ─────────────────────────────────────────
        confidence = self._compute_vocal_confidence(
            tremor_score, silence_ratio, volume_stability, rate_stability, vocal_fry, pressed
        )

        return AudioMetrics(
            timestamp=now,
            speech_rate_wpm=round(speech_rate, 1),
            speech_rate_stability=round(rate_stability, 1),
            syllable_rate=round(syllable_rate, 2),
            pitch_mean_hz=round(pitch_mean, 1),
            pitch_std_hz=round(pitch_std, 1),
            pitch_jitter_percent=round(jitter, 2),
            shimmer_percent=round(shimmer, 2),
            voice_tremor_score=round(tremor_score, 1),
            silence_duration_ms=round(silence_ms, 0),
            silence_count_last_30s=silence_count,
            silence_ratio=round(silence_ratio, 3),
            longest_silence_ms=round(longest_silence, 0),
            volume_rms=round(rms_db, 1),
            volume_stability=round(volume_stability, 1),
            volume_drop_detected=volume_drop,
            pitch_contour=contour,
            vocal_fry_detected=vocal_fry,
            pressed_voice_detected=pressed,
            vocal_confidence=round(confidence, 1),
        )

    # ── Pitch analysis (F0 via autocorrelation) ──────────────────────────────────

    def _analyze_pitch(self, audio: np.ndarray) -> tuple:
        """Extract F0, jitter, shimmer from audio chunk."""
        if len(audio) < 512:
            return 0.0, 0.0, 0.0, 0.0

        if HAS_LIBROSA:
            try:
                f0, voiced, _ = librosa.pyin(
                    audio,
                    fmin=self.MIN_PITCH_HZ,
                    fmax=self.MAX_PITCH_HZ,
                    sr=self.sample_rate,
                    frame_length=2048,
                )
                valid_f0 = f0[voiced & ~np.isnan(f0)] if f0 is not None else np.array([])
            except Exception:
                valid_f0 = np.array([])
        else:
            valid_f0 = self._autocorrelation_pitch(audio)

        if len(valid_f0) < 2:
            return 0.0, 0.0, 0.0, 0.0

        pitch_mean = float(np.mean(valid_f0))
        pitch_std = float(np.std(valid_f0))

        # Jitter: average absolute difference between consecutive periods
        periods = 1.0 / (valid_f0 + 1e-6)
        jitter = float(np.mean(np.abs(np.diff(periods))) / (np.mean(periods) + 1e-6) * 100)

        # Shimmer: amplitude variation (approximated)
        frame_size = int(self.sample_rate / (pitch_mean + 1e-6))
        if frame_size > 0 and frame_size < len(audio):
            amplitudes = []
            for start in range(0, len(audio) - frame_size, frame_size):
                amplitudes.append(np.max(np.abs(audio[start:start + frame_size])))
            if len(amplitudes) > 1:
                amps = np.array(amplitudes)
                shimmer = float(np.mean(np.abs(np.diff(amps))) / (np.mean(amps) + 1e-6) * 100)
            else:
                shimmer = 0.0
        else:
            shimmer = 0.0

        return pitch_mean, pitch_std, jitter, shimmer

    def _autocorrelation_pitch(self, audio: np.ndarray) -> np.ndarray:
        """Fallback pitch detection via autocorrelation (no librosa)."""
        # Simple frame-by-frame autocorrelation
        frame_len = 2048
        hop = 512
        pitches = []

        for start in range(0, len(audio) - frame_len, hop):
            frame = audio[start:start + frame_len]
            frame = frame * np.hanning(len(frame))
            corr = np.correlate(frame, frame, mode='full')
            corr = corr[len(corr) // 2:]

            # Find first peak after minimum lag
            min_lag = int(self.sample_rate / self.MAX_PITCH_HZ)
            max_lag = int(self.sample_rate / self.MIN_PITCH_HZ)
            if max_lag >= len(corr):
                continue
            segment = corr[min_lag:max_lag]
            if len(segment) == 0 or np.max(segment) < 0.1 * corr[0]:
                continue
            peak = np.argmax(segment) + min_lag
            if peak > 0:
                f0 = self.sample_rate / peak
                if self.MIN_PITCH_HZ <= f0 <= self.MAX_PITCH_HZ:
                    pitches.append(f0)

        return np.array(pitches) if pitches else np.array([])

    # ── Volume stability ─────────────────────────────────────────────────────────

    def _compute_volume_stability(self) -> float:
        if len(self._volume_history) < 5:
            return 80.0
        recent = np.array(list(self._volume_history)[-20:])
        non_silent = recent[recent > self.SILENCE_THRESHOLD_DB]
        if len(non_silent) < 3:
            return 50.0
        std = np.std(non_silent)
        return float(max(0, min(100, 100 - std * 5)))

    def _detect_volume_drop(self, current_db: float) -> bool:
        if self._volume_baseline is None:
            return False
        return current_db < self._volume_baseline - 12  # >12dB drop = significant

    # ── Speech rate estimation ───────────────────────────────────────────────────

    def _estimate_speech_rate(self, audio: np.ndarray) -> tuple:
        """Estimate WPM from energy envelope peaks (syllable counting)."""
        # Compute envelope
        abs_audio = np.abs(audio)
        # Smooth with moving average
        kernel_size = max(1, int(self.sample_rate * 0.02))  # 20ms window
        if len(abs_audio) > kernel_size:
            kernel = np.ones(kernel_size) / kernel_size
            envelope = np.convolve(abs_audio, kernel, mode='same')
        else:
            envelope = abs_audio

        # Find peaks above threshold (syllable nuclei)
        threshold = np.mean(envelope) * 1.2
        above = envelope > threshold

        # Count transitions (rising edges = syllable onsets)
        transitions = np.diff(above.astype(int))
        syllable_count = np.sum(transitions == 1)

        # Duration in seconds
        duration_s = len(audio) / self.sample_rate
        syllable_rate = syllable_count / (duration_s + 1e-6)

        # Approximate WPM (avg 1.5 syllables per word)
        wpm = syllable_rate * 60 / 1.5

        return float(min(300, wpm)), float(syllable_rate)

    def _compute_rate_stability(self) -> float:
        if len(self._speech_rate_history) < 5:
            return 80.0
        recent = np.array(list(self._speech_rate_history)[-15:])
        nonzero = recent[recent > 0]
        if len(nonzero) < 3:
            return 60.0
        std = np.std(nonzero)
        return float(max(0, min(100, 100 - std * 0.5)))

    # ── Pitch contour ────────────────────────────────────────────────────────────

    def _analyze_pitch_contour(self) -> str:
        if len(self._pitch_history) < 5:
            return 'FLAT'
        recent = list(self._pitch_history)[-10:]
        first_half = np.mean(recent[:len(recent) // 2])
        second_half = np.mean(recent[len(recent) // 2:])
        diff = second_half - first_half
        std = np.std(recent)

        if std > 30:
            return 'ERRATIC'
        elif diff > 10:
            return 'RISING'
        elif diff < -10:
            return 'FALLING'
        return 'FLAT'

    # ── Vocal confidence ─────────────────────────────────────────────────────────

    def _compute_vocal_confidence(self, tremor: float, silence_ratio: float,
                                   vol_stability: float, rate_stability: float,
                                   vocal_fry: bool, pressed: bool) -> float:
        score = 100
        score -= tremor * 0.25
        score -= silence_ratio * 100 * 0.2
        score -= (100 - vol_stability) * 0.2
        score -= (100 - rate_stability) * 0.15
        if vocal_fry:
            score -= 10
        if pressed:
            score -= 8
        return max(0, min(100, score))
