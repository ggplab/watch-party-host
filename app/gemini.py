import asyncio
import json
import os

import httpx

BASE = "https://generativelanguage.googleapis.com/v1beta/models"


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
    headers = {"x-goog-api-key": os.environ["GEMINI_API_KEY"], "Content-Type": "application/json"}
    url = f"{BASE}/{model}:generateContent"
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(2):
            r = await client.post(url, headers=headers, json=body)
            if r.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                await asyncio.sleep(3)
                continue
            r.raise_for_status()
            break
    data = r.json()
    parts_out = data["candidates"][0]["content"]["parts"]
    text = "".join(p.get("text", "") for p in parts_out if not p.get("thought"))
    return _parse(text) if json_mode else text
