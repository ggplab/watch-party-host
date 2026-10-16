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

## Where Gemini is used

| Step | Model | What it does |
|---|---|---|
| Scene log | `gemini-4-argon` | Watches each 5-minute YouTube segment directly (URL + offsets) and logs who, what, on-screen text, team state |
| Verification loop | `gemini-3.8-flash` → `gemini-4-argon` | Flash re-checks 3 random clips per segment; on disagreement Argon looks again and keeps or fixes the entry (episode 1, 0 to 30 min: 16 checked, 6 flagged, 5 kept, 1 fixed) |
| Catch-up and Q&A | `gemini-3.8-flash` | Answers only from scenes that ended before the viewer's time, with time chips |
| Spoiler shield | `gemini-3.5-flash-lite` | Finds the scene time a chat line talks about |
| Code | Argon via Antigravity (agy), Claude | App code |
| Hosting | Cloud Run (asia-northeast3), Vertex AI | No API key in the service; it calls Gemini with its service account |

`GET /score` shows live call counts and average latency per model.

## What was built when

The sync and chat UI is adapted from our earlier private prototype (watch-party-sync, built 2026-10-14~15). Everything built with Gemini during the hackathon: Argon scene log with verification loop, time-bounded catch-up and Q&A, scene-aware spoiler shield.

- `/room`: the real-time room (Supabase Realtime sync and chat from the prototype) with the AI manager added. `/room?demo=1` fixes the viewer at 20:00 with a scripted chat.
- `/app`: a standalone single-viewer demo of the AI features.

## Run locally

```bash
uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt
export GEMINI_API_KEY=...        # never commit it
uvicorn app.main:app --port 8080
curl -X POST localhost:8080/ingest -H 'Content-Type: application/json' -d '{"video_id":"mE8yrHFjatQ","segment":"all"}'
```

Open http://localhost:8080/app.

## Deploy (Cloud Run)

On Cloud Run the app calls Gemini through Vertex AI with the service account, so no API key is stored (`VERTEX_PROJECT`). Without it, it falls back to `GEMINI_API_KEY`.

```bash
IMG=asia-northeast3-docker.pkg.dev/<project>/cloud-run-source-deploy/watch-party-host:v1
docker buildx build --platform linux/amd64 -t $IMG --push .
gcloud run deploy watch-party-host --image $IMG --region asia-northeast3 --allow-unauthenticated \
  --no-cpu-throttling --timeout 900 --memory 1Gi --set-env-vars VERTEX_PROJECT=<project>,VERTEX_LOCATION=global
```

Scene logs live in `local/data/` (git-ignored, not published). They ship only inside the private container image.

## Principles

- Video plays only through the official YouTube embed. We don't download or re-host it.
- Scene logs are short summaries, not transcripts, and are not published in this repo.
- The demo chat log is scripted.

© 2026 BuildnWrite. All rights reserved.
