# Watch Party Host

The AI manager for watch-party streams. Watch together, even when you are not watching at the same time.
Built at Google DeepMind AI Hackathon, Seoul, 2026-10-16.

A viewer who joins late is at their own video time `t`. Everything the host does is cut at that `t`:

- **Catch me up / Ask**: answers come only from scenes that ended before `t`, with time chips that jump back to the scene.
- **Spoiler shield**: a chat line is locked by the scene it talks about, not by when it was posted. It opens when your `t` reaches that scene.
- **Friend position chips**: `민지 ▶ 27:40` jumps your player to where a friend is. Video plays only through the official YouTube embed; we share positions, not video.

## How it works

```
YouTube URL ──▶ Gemini 4 Argon (5-min segments) ──▶ scene log JSON
                                                     │
               Flash re-checks 3 random clips ◀──────┘
               └─ disagreement ──▶ Argon looks again and decides (max 2 per segment)

viewer t ──▶ scenes with t_end ≤ t ──▶ /ask (Flash)        ──▶ answer + time chips
chat line ──▶ /shield (Flash-Lite) ──▶ scene time it refers to ──▶ locked if > t (fails closed)
```

(Architecture diagram placeholder)

| Path | What |
|---|---|
| `GET /` | landing page |
| `GET /app` | watch room |
| `POST /ingest` | `{video_id, segment}` → background job writing `DATA_DIR/<video>/seg<n>.json` |
| `POST /ask` | `{video_id, t_sec, question}` → `{answerable, answer_ko, answer_en, cites}` |
| `POST /shield` | `{video_id, t_sec, messages}` → per line `{refers_to, hidden, opens_at}` |
| `GET /score` | verification-loop counts |
| `GET /health` | `{ok: true}` |

If an answer takes longer than 15 s, the server replays a cached answer only when the key matches exactly (video, question, t, scene-log version).

## Run locally

```bash
uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt
export GEMINI_API_KEY=...        # never commit it
uvicorn app.main:app --port 8080
curl -X POST localhost:8080/ingest -H 'Content-Type: application/json' -d '{"video_id":"mE8yrHFjatQ","segment":"all"}'
```

Open http://localhost:8080/app.

## Deploy (Cloud Run)

```bash
gcloud run deploy watch-party-host --source . --region asia-northeast3 --allow-unauthenticated \
  --no-cpu-throttling --timeout 900 --set-env-vars GEMINI_API_KEY=...
```

Scene logs live in `local/data/` (git-ignored, not published). They ship only inside the private container image.

## Principles

- Video plays only through the official YouTube embed. We don't download or re-host it.
- Scene logs are short summaries, not transcripts, and are not published in this repo.
- The demo chat log is scripted.

© 2026 BuildnWrite. All rights reserved.
