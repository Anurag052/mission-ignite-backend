"""
Behavior Analysis Microservice — FastAPI + WebSocket Server.

Accepts WebRTC video/audio streams via WebSocket, runs real-time
CV analysis (OpenCV + MediaPipe), and streams behavior metrics back.

Endpoints:
  WS  /ws/analyze    — Real-time analysis (video frames + audio chunks)
  GET /health        — Health check
  GET /sessions      — Active sessions
  POST /sessions/{id}/summary — Get session summary
  DELETE /sessions/{id}       — End session + cleanup

Protocol (WebSocket):
  Client → Server:
    { "type": "start", "session_id": "...", "user_id": "...", "gto_session_id": "..." }
    { "type": "video_frame", "data": "<base64 JPEG>" }
    { "type": "audio_chunk", "data": "<base64 PCM16>" }
    { "type": "combined", "video": "<base64>", "audio": "<base64>" }
    { "type": "stop" }

  Server → Client:
    { "type": "metrics", "data": { ... BehaviorSnapshot ... } }
    { "type": "alert", "data": { ... BehaviorAlert ... } }
    { "type": "heatmap", "data": { grid, peak_zones, overall_stress } }
    { "type": "session_summary", "data": { ... } }
    { "type": "error", "message": "..." }
"""

import asyncio
import base64
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Optional

import numpy as np
import orjson
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from config import settings
from session_orchestrator import SessionOrchestrator
from storage import EncryptedMetricsStore

# ── Logging ──────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("behavior-analysis")

# ── Global instances ─────────────────────────────────────────────────────────────

orchestrator = SessionOrchestrator()
store = EncryptedMetricsStore()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup/shutdown."""
    logger.info("Behavior Analysis Microservice starting...")
    await store.connect()
    logger.info(f"Listening on {settings.HOST}:{settings.PORT}")
    yield
    logger.info("Shutting down...")


# ── FastAPI App ──────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Behavior Analysis Engine",
    description="Real-time behavioral analysis — OpenCV, MediaPipe, audio processing",
    version="1.0.0",
    default_response_class=ORJSONResponse,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── REST endpoints ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "behavior-analysis",
        "active_sessions": orchestrator.active_sessions,
        "timestamp": time.time(),
    }


@app.get("/sessions")
async def list_sessions():
    sessions = []
    for sid, state in orchestrator._sessions.items():
        sessions.append({
            "session_id": sid,
            "user_id": state.user_id,
            "gto_session_id": state.gto_session_id,
            "frame_count": state.frame_count,
            "audio_chunks": state.audio_chunk_count,
            "alerts": len(state.all_alerts),
            "duration_sec": round(time.time() - state.started_at, 1),
        })
    return {"sessions": sessions, "count": len(sessions)}


@app.post("/sessions/{session_id}/summary")
async def get_summary(session_id: str):
    summary = orchestrator.get_session_summary(session_id)
    if not summary:
        # Try stored summary
        stored = await store.get_session_summary(session_id)
        if stored:
            return stored
        raise HTTPException(404, "Session not found")
    return summary


@app.delete("/sessions/{session_id}")
async def end_session(session_id: str):
    state = orchestrator.end_session(session_id)
    if not state:
        raise HTTPException(404, "Session not found")

    # Store summary encrypted
    summary = orchestrator.get_session_summary(session_id)
    if summary:
        await store.store_session_summary(session_id, summary)

    return {"message": "Session ended", "session_id": session_id}


# ── WebSocket — Real-time analysis ───────────────────────────────────────────────

@app.websocket("/ws/analyze")
async def websocket_analyze(ws: WebSocket):
    await ws.accept()
    session_id: Optional[str] = None
    metrics_buffer: list = []
    last_emit = time.time()

    logger.info(f"WebSocket connected: {ws.client}")

    try:
        while True:
            raw = await ws.receive_bytes()

            # Try to parse as JSON first (text messages)
            try:
                msg = orjson.loads(raw)
            except (orjson.JSONDecodeError, Exception):
                # Binary data — treat as video frame if session active
                if session_id:
                    snapshot = orchestrator.process_video_frame(session_id, raw)
                    if snapshot:
                        await _emit_metrics(ws, snapshot, session_id, store)
                continue

            msg_type = msg.get("type", "")

            # ── Start session ────────────────────────────────────────────
            if msg_type == "start":
                session_id = msg.get("session_id", str(uuid.uuid4()))
                user_id = msg.get("user_id", "anonymous")
                gto_id = msg.get("gto_session_id")

                orchestrator.create_session(session_id, user_id, gto_id)
                logger.info(f"Session started: {session_id} (user: {user_id}, gto: {gto_id})")

                await ws.send_bytes(orjson.dumps({
                    "type": "session_started",
                    "session_id": session_id,
                    "message": "Behavior analysis active",
                }))

            # ── Video frame ──────────────────────────────────────────────
            elif msg_type == "video_frame" and session_id:
                frame_data = base64.b64decode(msg["data"])
                snapshot = orchestrator.process_video_frame(session_id, frame_data)
                if snapshot:
                    await _emit_metrics(ws, snapshot, session_id, store)

            # ── Audio chunk ──────────────────────────────────────────────
            elif msg_type == "audio_chunk" and session_id:
                audio_data = base64.b64decode(msg["data"])
                snapshot = orchestrator.process_audio_chunk(session_id, audio_data)
                if snapshot:
                    await _emit_metrics(ws, snapshot, session_id, store)

            # ── Combined (video + audio) ─────────────────────────────────
            elif msg_type == "combined" and session_id:
                video = base64.b64decode(msg["video"]) if msg.get("video") else None
                audio = base64.b64decode(msg["audio"]) if msg.get("audio") else None
                snapshot = orchestrator.process_combined(session_id, video, audio)
                if snapshot:
                    await _emit_metrics(ws, snapshot, session_id, store)

            # ── Stop session ─────────────────────────────────────────────
            elif msg_type == "stop" and session_id:
                summary = orchestrator.get_session_summary(session_id)
                state = orchestrator.end_session(session_id)

                if summary:
                    await store.store_session_summary(session_id, summary)
                    await ws.send_bytes(orjson.dumps({
                        "type": "session_summary",
                        "data": summary,
                    }))

                logger.info(f"Session ended: {session_id}")
                session_id = None

            # ── Unknown ──────────────────────────────────────────────────
            else:
                await ws.send_bytes(orjson.dumps({
                    "type": "error",
                    "message": f"Unknown message type: {msg_type}",
                }))

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {ws.client}")
        if session_id:
            summary = orchestrator.get_session_summary(session_id)
            if summary:
                await store.store_session_summary(session_id, summary)
            orchestrator.end_session(session_id)

    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
        if session_id:
            orchestrator.end_session(session_id)
        try:
            await ws.send_bytes(orjson.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass


# ── Helpers ──────────────────────────────────────────────────────────────────────

async def _emit_metrics(ws: WebSocket, snapshot, session_id: str, store: EncryptedMetricsStore):
    """Serialize and emit behavior snapshot to the WebSocket client."""
    confidence = snapshot.confidence

    # Main metrics payload
    metrics = {
        "type": "metrics",
        "data": {
            "timestamp": confidence.timestamp,
            "confidence": {
                "visual": confidence.visual_confidence,
                "vocal": confidence.vocal_confidence,
                "gestural": confidence.gestural_confidence,
                "emotional": confidence.emotional_confidence,
                "overall": confidence.overall_confidence,
            },
            "stress": {
                "index": confidence.stress_index,
                "trend": confidence.stress_trend,
                "components": confidence.stress_components,
            },
            "face": snapshot.face_metrics,
            "hands": snapshot.hand_metrics,
            "audio": snapshot.audio_metrics,
        },
    }
    await ws.send_bytes(orjson.dumps(metrics))

    # Heatmap (sent separately to allow frontend to throttle rendering)
    if snapshot.heatmap:
        heatmap_msg = {
            "type": "heatmap",
            "data": {
                "grid": snapshot.heatmap.grid,
                "resolution": snapshot.heatmap.resolution,
                "peak_zones": snapshot.heatmap.peak_zones,
                "overall_stress": snapshot.heatmap.overall_stress_level,
                "dominant_indicator": snapshot.heatmap.dominant_indicator,
            },
        }
        await ws.send_bytes(orjson.dumps(heatmap_msg))

    # Alerts
    for alert in snapshot.alerts:
        alert_msg = {
            "type": "alert",
            "data": {
                "alert_type": alert.alert_type,
                "severity": alert.severity,
                "indicator": alert.indicator,
                "value": alert.value,
                "threshold": alert.threshold,
                "description": alert.description,
                "recommendation": alert.recommendation,
            },
        }
        await ws.send_bytes(orjson.dumps(alert_msg))

    # Store encrypted (async, non-blocking)
    try:
        await store.store_snapshot(session_id, metrics["data"], confidence.timestamp)
    except Exception:
        pass  # Don't fail analysis if storage fails


# ── Entry point ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        log_level="debug" if settings.DEBUG else "info",
        ws="websockets",
    )
