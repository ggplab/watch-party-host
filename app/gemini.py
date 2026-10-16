import asyncio
import json
import os
import subprocess
import time

import httpx

BASE = "https://generativelanguage.googleapis.com/v1beta/models"
# On Cloud Run set VERTEX_PROJECT: calls go through Vertex AI with the service account, no API key.
VERTEX_PROJECT = os.environ.get("VERTEX_PROJECT")
VERTEX_LOCATION = os.environ.get("VERTEX_LOCATION", "global")
_token = {"value": None, "exp": 0.0}
# per-model call counts and latency, shown on /score as presentation numbers
STATS: dict = {}


async def _vertex_token() -> str:
    if _token["value"] and time.time() < _token["exp"]:
        return _token["value"]
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                            headers={"Metadata-Flavor": "Google"})
            r.raise_for_status()
            tok, ttl = r.json()["access_token"], r.json().get("expires_in", 3000)
    except Exception:  # local development: use the gcloud login
        tok = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True).stdout.strip()
        ttl = 3000
    _token.update(value=tok, exp=time.time() + ttl - 120)
    return tok


def video_part(video_id: str, start: int, end: int) -> dict:
    return {
        "fileData": {"fileUri": f"https://www.youtube.com/watch?v={video_id}"},
        "videoMetadata": {"startOffset": f"{int(start)}s", "endOffset": f"{int(end)}s"},
    }


def _parse(text: str):
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t[3:]
        t = t.rsplit("```", 1)[0]
    return json.loads(t)


async def generate(model: str, parts: list, json_mode: bool = True, timeout: float = 300):
    body = {"contents": [{"role": "user", "parts": parts}]}
    if json_mode:
        body["generationConfig"] = {"responseMimeType": "application/json"}
    if VERTEX_PROJECT:
        headers = {"Authorization": f"Bearer {await _vertex_token()}", "Content-Type": "application/json"}
        url = (f"https://aiplatform.googleapis.com/v1/projects/{VERTEX_PROJECT}/locations/{VERTEX_LOCATION}"
               f"/publishers/google/models/{model}:generateContent")
    else:
        headers = {"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"}
        url = f"{BASE}/{model}:generateContent"
    t0 = time.time()
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(2):
            r = await client.post(url, headers=headers, json=body)
            if r.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                await asyncio.sleep(3)
                continue
            r.raise_for_status()
            break
    st = STATS.setdefault(model, {"calls": 0, "total_ms": 0})
    st["calls"] += 1
    st["total_ms"] += int((time.time() - t0) * 1000)
    data = r.json()
    parts_out = data["candidates"][0]["content"]["parts"]
    text = "".join(p.get("text", "") for p in parts_out if not p.get("thought"))
    return _parse(text) if json_mode else text
