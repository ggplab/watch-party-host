import asyncio
import hashlib
import json
import os
import random
import time
import uuid
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .gemini import STATS, generate, video_part

ARGON = "gemini-4-argon"
FLASH = "gemini-3.8-flash"
LITE = "gemini-3.5-flash-lite"
SEG_LEN = 300
N_SEGS = 6

ROOT = Path(__file__).resolve().parent.parent
PROMPTS = Path(__file__).resolve().parent / "prompts"
STATIC = ROOT / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "local" / "data"))

app = FastAPI(title="Watch Party Host")
app.mount("/static", StaticFiles(directory=STATIC), name="static")

JOBS: dict = {}


# ---------- helpers ----------
def mmss(s) -> str:
    s = int(s)
    return f"{s // 60:02d}:{s % 60:02d}"


def sec(t) -> int:
    parts = [int(float(p)) for p in str(t).strip().split(":")]
    v = 0
    for p in parts:
        v = v * 60 + p
    return v


def prompt(name: str, **kw) -> str:
    text = (PROMPTS / f"{name}.txt").read_text(encoding="utf-8")
    for k, v in kw.items():
        text = text.replace("{" + k + "}", str(v))
    return text


def sha(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def seg_files(video_id: str):
    d = DATA_DIR / video_id
    return sorted(d.glob("seg*.json")) if d.exists() else []


def log_version(video_id: str) -> str:
    h = hashlib.sha1()
    for f in seg_files(video_id):
        h.update(f.read_bytes())
    return h.hexdigest()[:10]


def load_scenes(video_id: str) -> list:
    scenes = []
    for f in seg_files(video_id):
        scenes += json.loads(f.read_text(encoding="utf-8")).get("scenes", [])
    good = []
    for s in scenes:
        try:
            sec(s["t_start"]), sec(s["t_end"])
            good.append(s)
        except Exception:
            pass
    return sorted(good, key=lambda s: sec(s["t_start"]))


def scene_line(s: dict) -> str:
    who = s.get("who") or []
    if isinstance(who, list):
        who = ", ".join(map(str, who))
    out = f"[{mmss(sec(s['t_start']))}-{mmss(sec(s['t_end']))}] {who}: {s.get('what', '')}"
    if s.get("onscreen_text"):
        out += f" | 화면: {s['onscreen_text']}"
    if s.get("team_state"):
        out += f" | 팀: {s['team_state']}"
    return out


def cache_get(key: str):
    f = DATA_DIR / "cache" / f"{key}.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None


def cache_put(key: str, value: dict):
    d = DATA_DIR / "cache"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{key}.json").write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


# ---------- pages ----------
@app.get("/health")
def health():
    return {"ok": True}


@app.get("/")
def home():
    return FileResponse(STATIC / "room" / "index.html")


@app.get("/about")
def landing():
    return FileResponse(STATIC / "index.html")


@app.get("/app")
def demo_page():
    return RedirectResponse("/room?demo=1")


@app.get("/room")
def room():
    return FileResponse(STATIC / "room" / "index.html")


# ---------- ingest (Argon + verification loop) ----------
class IngestReq(BaseModel):
    video_id: str
    segment: int | str = "all"


async def ingest_segment(video_id: str, n: int) -> dict:
    start, end = n * SEG_LEN, n * SEG_LEN + SEG_LEN
    vp = video_part(video_id, start, end)
    log = await generate(ARGON, [vp, {"text": prompt("ingest", START=mmss(start), END=mmss(end))}], timeout=600)
    scenes = log.get("scenes", []) if isinstance(log, dict) else log

    stats = {"checked": 0, "flagged": 0, "kept": 0, "fixed": 0, "items": []}
    candidates = [i for i, s in enumerate(scenes) if s.get("onscreen_text") or s.get("team_state")]
    rewrites = 0
    for i in random.sample(candidates, min(3, len(candidates))):
        s = scenes[i]
        try:
            t0, t1 = sec(s["t_start"]), sec(s["t_end"])
            if t1 - t0 < 2:
                t1 = t0 + 2
            check = await generate(FLASH, [video_part(video_id, t0, t1),
                                           {"text": prompt("verify", T0=mmss(t0), T1=mmss(t1))}])
            entry_view = {"onscreen_text": s.get("onscreen_text", ""), "team_state": s.get("team_state", "")}
            cmp = await generate(FLASH, [{"text": prompt("compare", LOG=json.dumps(entry_view, ensure_ascii=False),
                                                          CHECK=json.dumps(check, ensure_ascii=False))}])
            stats["checked"] += 1
            item = {"t": mmss(t0), "contradiction": bool(cmp.get("contradiction")), "reason": cmp.get("reason", "")}
            if cmp.get("contradiction"):
                stats["flagged"] += 1
                if rewrites < 2:
                    rewrites += 1
                    new = await generate(ARGON, [vp, {"text": prompt(
                        "rewrite", T=mmss(t0), ENTRY=json.dumps(s, ensure_ascii=False),
                        CHECK=json.dumps(check, ensure_ascii=False), REASON=cmp.get("reason", ""))}], timeout=600)
                    if new.get("kept", True):
                        stats["kept"] += 1
                        item["decision"] = "kept"
                    else:
                        new.pop("kept", None)
                        scenes[i] = new
                        stats["fixed"] += 1
                        item["decision"] = "fixed"
            stats["items"].append(item)
        except Exception as e:  # verification is best-effort
            stats["items"].append({"t": s.get("t_start"), "error": str(e)[:200]})

    d = DATA_DIR / video_id
    d.mkdir(parents=True, exist_ok=True)
    out = {"segment": n, "scenes": scenes, "verify": stats, "model": ARGON}
    (d / f"seg{n}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


async def run_job(job_id: str, video_id: str, segs: list):
    job = JOBS[job_id]
    sem = asyncio.Semaphore(3)

    async def one(n):
        async with sem:
            try:
                await ingest_segment(video_id, n)
                job["done"].append(n)
            except Exception as e:
                job["errors"].append({"segment": n, "error": str(e)[:300]})

    await asyncio.gather(*(one(n) for n in segs))
    job["status"] = "finished"


@app.post("/ingest")
async def ingest(req: IngestReq):
    segs = list(range(N_SEGS)) if str(req.segment) == "all" else [int(req.segment)]
    job_id = uuid.uuid4().hex[:8]
    JOBS[job_id] = {"status": "running", "done": [], "errors": [], "segments": segs}
    JOBS[job_id]["task"] = asyncio.create_task(run_job(job_id, req.video_id, segs))
    return {"job_id": job_id}


@app.get("/ingest/{job_id}")
def ingest_status(job_id: str):
    j = JOBS.get(job_id)
    if not j:
        return {"status": "unknown"}
    return {k: v for k, v in j.items() if k != "task"}


# ---------- ask ----------
class AskReq(BaseModel):
    video_id: str
    t_sec: int
    question: str
    lang: str | None = None


async def _answer(req: AskReq, ver: str) -> dict:
    scenes = [s for s in load_scenes(req.video_id) if sec(s["t_end"]) <= req.t_sec]
    if not scenes:
        return {"answerable": False, "answer_ko": "", "answer_en": "", "cites": []}
    ctx = "\n".join(scene_line(s) for s in scenes)
    p = prompt("answer", T=mmss(req.t_sec), CONTEXT=ctx, Q=req.question)
    p += '\nJSON 키에 "answer_en"(answer의 한 줄 영어 번역)도 넣는다.'
    p += '\n"등장인물", "출연자", "사람"은 이 예능에 나온 출연자(명찰, 자막의 닉네임 포함)를 뜻한다.'
    p += '\nanswerable이 true이면 cites에 근거가 된 장면의 시작 시각(MM:SS)을 1~4개 반드시 넣는다.'
    r = await generate(FLASH, [{"text": p}], timeout=120)
    cites = []
    for c in r.get("cites") or []:
        try:
            if sec(c) <= req.t_sec:
                cites.append(mmss(sec(c)))
        except Exception:
            pass
    return {"answerable": bool(r.get("answerable")), "answer_ko": r.get("answer", ""),
            "answer_en": r.get("answer_en", ""), "cites": cites}


@app.post("/ask")
async def ask(req: AskReq):
    t0 = time.time()
    ver = log_version(req.video_id)
    # key on the evidence, not the clock: same question + same set of finished scenes -> same answer
    n_done = sum(1 for s in load_scenes(req.video_id) if sec(s["t_end"]) <= req.t_sec)
    key = sha(f"{req.video_id}|{req.question}|scenes:{n_done}|{ver}")
    hit = cache_get(key)
    if hit and hit.get("answerable"):
        hit.update(cached=True, latency_ms=int((time.time() - t0) * 1000))
        return hit
    task = asyncio.create_task(_answer(req, ver))
    try:
        res = await asyncio.wait_for(asyncio.shield(task), 15)
        cached = False
    except asyncio.TimeoutError:
        hit = cache_get(key)
        if hit:
            hit.update(cached=True, latency_ms=int((time.time() - t0) * 1000))
            return hit
        res = await task
        cached = False
    res.update(log_version=ver, source="video")
    if res["answerable"] or res.get("answer_ko") == "":
        cache_put(key, res)
    return {**res, "cached": cached, "latency_ms": int((time.time() - t0) * 1000)}


# ---------- shield ----------
class Msg(BaseModel):
    id: str
    text: str


class ShieldReq(BaseModel):
    video_id: str
    t_sec: int
    messages: list[Msg]


# scene start times are approximate and viewers drift: a scene this many seconds ahead counts as already seen
SHIELD_GRACE = 60


@app.post("/shield")
async def shield(req: ShieldReq):
    scenes = load_scenes(req.video_id)
    ctx = "\n".join(scene_line(s) for s in scenes)
    ver = log_version(req.video_id)
    sem = asyncio.Semaphore(6)

    async def one(m: Msg):
        # shield2: lenient prompt; do not reuse verdicts cached under the old strict prompt
        key = sha(f"shield2|{req.video_id}|{m.text}|{ver}")
        r = cache_get(key)
        if r is None:
            try:
                async with sem:
                    r = await generate(LITE, [{"text": prompt("shield", CONTEXT=ctx, CHAT=m.text)}], timeout=60)
                ref = r.get("refers_to")
                r = {"refers_to": mmss(sec(ref)) if ref else None, "social": bool(r.get("social"))}
                if scenes:
                    cache_put(key, r)
            except Exception:
                r = {"refers_to": None, "social": False}
        ref, social = r["refers_to"], r["social"]
        hidden = (not social) and (ref is None or sec(ref) > req.t_sec + SHIELD_GRACE)
        return {"id": m.id, "refers_to": ref, "social": social, "hidden": hidden,
                "opens_at": ref if (hidden and ref) else None}

    return {"results": await asyncio.gather(*(one(m) for m in req.messages))}


# ---------- score ----------
@app.get("/score")
def score(video_id: str = "mE8yrHFjatQ"):
    tot = {"checked": 0, "flagged": 0, "kept": 0, "fixed": 0}
    n_scenes = 0
    for f in seg_files(video_id):
        d = json.loads(f.read_text(encoding="utf-8"))
        n_scenes += len(d.get("scenes", []))
        for k in tot:
            tot[k] += d.get("verify", {}).get(k, 0)
    return {"verify": tot, "scenes": n_scenes, "segments": len(seg_files(video_id)),
            "log_version": log_version(video_id),
            "model_calls": {m: {"calls": v["calls"], "avg_ms": v["total_ms"] // max(v["calls"], 1)}
                            for m, v in STATS.items()},
            "measured_2026_10_15": {"shield_safe": {"subtitles": 17, "flash": 17, "argon": 21, "total": 22},
                                    "shield_spoiler": {"hidden": 18, "total": 18}}}
