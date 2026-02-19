"""
Behavior Analysis Microservice — Configuration
"""
from pydantic import BaseModel
from dotenv import load_dotenv
import os

load_dotenv()


class Settings(BaseModel):
    """Application settings loaded from environment."""
    HOST: str = os.getenv("BA_HOST", "0.0.0.0")
    PORT: int = int(os.getenv("BA_PORT", "8100"))
    DEBUG: bool = os.getenv("BA_DEBUG", "false").lower() == "true"

    # Redis (Upstash TLS compatible)
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379")

    # Encryption key for metrics storage (32 bytes, base64)
    ENCRYPTION_KEY: str = os.getenv("BA_ENCRYPTION_KEY", "")

    # Backend NestJS URL for pushing consolidated results
    BACKEND_URL: str = os.getenv("BACKEND_URL", "http://localhost:4000")
    BACKEND_API_KEY: str = os.getenv("BA_API_KEY", "")

    # MediaPipe configs
    FACE_MESH_MAX_FACES: int = 1
    FACE_MESH_MIN_DETECTION_CONFIDENCE: float = 0.5
    FACE_MESH_MIN_TRACKING_CONFIDENCE: float = 0.5
    HAND_MAX_HANDS: int = 2
    HAND_MIN_DETECTION_CONFIDENCE: float = 0.5
    HAND_MIN_TRACKING_CONFIDENCE: float = 0.5
    POSE_MIN_DETECTION_CONFIDENCE: float = 0.5
    POSE_MIN_TRACKING_CONFIDENCE: float = 0.5

    # Analysis config
    FRAME_BUFFER_SIZE: int = 120        # ~4 seconds at 30fps
    METRICS_EMIT_INTERVAL_MS: int = 500  # Emit metrics every 500ms
    HEATMAP_RESOLUTION: tuple = (64, 48) # Stress heatmap grid


settings = Settings()
