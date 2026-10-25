# SPDX-License-Identifier: GPL-3.0-or-later
"""Sprachdienst für Mission Control: Sprache → Text und Text → Sprache mit den Werkzeugen von Hermes.

Läuft als Agent-Benutzer in der Laufzeitumgebung von Hermes (gestartet von ``sprachdienst-start.sh``) und nutzt
dessen Einstellungen ``stt:`` und ``tts:`` – lokal (faster-whisper, Piper) oder Cloud, wie in Hermes gewählt.
Nur zwei Aufgaben, sonst nichts:

    GET  /health                       ohne Schlüssel – {"ok": true}
    GET  /status                       Anbieter und ob die Hermes-Werkzeuge da sind
    POST /transcribe   (Audio-Body)    {"transcript": "…", "provider": "local"}
    POST /speak        {"text": "…"}   audio/mpeg

Umgebung: ``SPRACHDIENST_HOST``, ``SPRACHDIENST_PORT``, ``SPRACHDIENST_KEY`` (Pflicht, Bearer-Schlüssel).
"""

from __future__ import annotations

import hmac
import json
import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_AUDIO = 15 * 1024 * 1024        # etwa 15 Minuten Sprache (Opus)
MAX_TEXT = 4000
ENDUNGEN = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/mpeg": ".mp3",
            "audio/wav": ".wav", "audio/x-wav": ".wav", "video/webm": ".webm"}
KEY = os.environ.get("SPRACHDIENST_KEY", "")
LADEN = threading.Lock()


def hermes_werkzeuge():
    """Die Sprachwerkzeuge von Hermes – erst beim ersten Gebrauch laden (sie ziehen viel nach)."""
    from tools.tts_tool import check_tts_requirements, text_to_speech_tool
    from tools.voice_mode import transcribe_recording
    return transcribe_recording, text_to_speech_tool, check_tts_requirements


def einstellungen() -> dict:
    try:
        from hermes_cli.config import load_config
        cfg = load_config()
    except Exception:  # noqa: BLE001 – ohne Hermes (Test) einfach leer
        return {}
    stt, tts = cfg.get("stt") or {}, cfg.get("tts") or {}
    return {"stt": stt.get("provider") or "auto", "tts": tts.get("provider") or "edge",
            "language": stt.get("language") or ""}


def vorwaermen() -> None:
    """Whisper-Modell beim Start laden, damit die erste Eingabe nicht ~30 s wartet."""
    try:
        with LADEN:
            from tools.transcription_local import _load_local_whisper_model
            from hermes_cli.config import load_config
            local = ((load_config().get("stt") or {}).get("local") or {})
            _load_local_whisper_model(local.get("model") or "base")
    except Exception as exc:  # noqa: BLE001
        print(f"Vorwärmen übersprungen: {exc}", file=sys.stderr, flush=True)


class Dienst(BaseHTTPRequestHandler):
    server_version = "bonys-sprachdienst"

    def log_message(self, format, *args):  # noqa: A002 – keine Inhalte ins Protokoll, nur Pfad und Status
        print(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}", flush=True)

    def antwort(self, status: int, daten: dict) -> None:
        body = json.dumps(daten, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def erlaubt(self) -> bool:
        geliefert = self.headers.get("Authorization", "")
        ok = bool(KEY) and hmac.compare_digest(geliefert.encode(), f"Bearer {KEY}".encode())
        if not ok:
            self.antwort(401, {"error": "unauthorized"})
        return ok

    def koerper(self, grenze: int) -> bytes | None:
        try:
            laenge = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            laenge = -1
        if laenge <= 0:
            self.antwort(400, {"error": "empty"})
            return None
        if laenge > grenze:
            self.antwort(413, {"error": "too_large"})
            return None
        return self.rfile.read(laenge)

    def do_GET(self):
        if self.path == "/health":
            return self.antwort(200, {"ok": True})
        if self.path == "/status":
            if not self.erlaubt():
                return None
            try:
                _, _, tts_ok = hermes_werkzeuge()
                werkzeuge, tts_bereit = True, bool(tts_ok())
            except Exception:  # noqa: BLE001
                werkzeuge, tts_bereit = False, False
            return self.antwort(200, {"ok": werkzeuge, "tts_ready": tts_bereit, **einstellungen()})
        return self.antwort(404, {"error": "not_found"})

    def do_POST(self):
        if self.path not in ("/transcribe", "/speak"):
            return self.antwort(404, {"error": "not_found"})
        if not self.erlaubt():
            return None
        try:
            transcribe, speak, _ = hermes_werkzeuge()
        except Exception:  # noqa: BLE001
            return self.antwort(503, {"error": "hermes_voice_missing"})
        ordner = Path(tempfile.mkdtemp(prefix="bonys-sprache-"))
        try:
            if self.path == "/transcribe":
                return self.umwandeln(transcribe, ordner)
            return self.sprechen(speak, ordner)
        finally:
            shutil.rmtree(ordner, ignore_errors=True)

    def umwandeln(self, transcribe, ordner: Path) -> None:
        art = (self.headers.get("Content-Type") or "audio/webm").split(";", 1)[0].strip().lower()
        if not (art.startswith("audio/") or art == "video/webm"):
            return self.antwort(415, {"error": "not_audio"})
        daten = self.koerper(MAX_AUDIO)
        if daten is None:
            return None
        datei = ordner / f"aufnahme{ENDUNGEN.get(art, '.webm')}"
        datei.write_bytes(daten)
        with LADEN:
            ergebnis = transcribe(str(datei))
        if not ergebnis.get("success"):
            if "empty transcript" in str(ergebnis.get("error", "")).lower():
                return self.antwort(200, {"transcript": "", "provider": ergebnis.get("provider")})
            return self.antwort(502, {"error": "transcription_failed"})
        return self.antwort(200, {"transcript": str(ergebnis.get("transcript") or "").strip(),
                                  "provider": ergebnis.get("provider")})

    def sprechen(self, speak, ordner: Path) -> None:
        daten = self.koerper(64 * 1024)
        if daten is None:
            return None
        try:
            text = str(json.loads(daten).get("text") or "").strip()
        except (ValueError, AttributeError):
            text = ""
        if not text or len(text) > MAX_TEXT:
            return self.antwort(400, {"error": "invalid_text"})
        ergebnis = json.loads(speak(text, output_path=str(ordner / "antwort.mp3")))
        pfad = ergebnis.get("file_path") if ergebnis.get("success") else None
        if not pfad or not Path(pfad).is_file():
            return self.antwort(502, {"error": "speech_failed"})
        audio = Path(pfad).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def main() -> int:
    if not KEY:
        print("SPRACHDIENST_KEY fehlt – Dienst startet nicht.", file=sys.stderr)
        return 1
    host = os.environ.get("SPRACHDIENST_HOST", "127.0.0.1")
    port = int(os.environ.get("SPRACHDIENST_PORT", "8640"))
    server = ThreadingHTTPServer((host, port), Dienst)
    threading.Thread(target=vorwaermen, daemon=True).start()
    print(f"Sprachdienst lauscht auf {host}:{port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
