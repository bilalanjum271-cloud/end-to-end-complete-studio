"""Pipeline activities. Each is a plain synchronous function that is safe to retry:
writes are keyed (job ids derive from project/scene/generation; ledger calls carry idempotency
keys; files are written atomically), so Temporal can re-run any of them after a crash.

Every SQL statement is scoped by workspace_id.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

import httpx
import psycopg
from psycopg.rows import dict_row

from ..config import Config
from ..router import ModelRouter, Used
from . import media


class Deps:
    """Shared, stateless-per-request dependencies for activities."""

    def __init__(self, cfg: Config, router: ModelRouter):
        self.cfg = cfg
        self.router = router
        self.storage = media.Storage(cfg.media_root)

    @contextmanager
    def db(self):
        with psycopg.connect(self.cfg.database_url, row_factory=dict_row) as conn:
            yield conn


_deps: Deps | None = None


def configure(deps: Deps) -> None:
    global _deps
    _deps = deps


def deps() -> Deps:
    assert _deps is not None, "activities.configure() was not called"
    return _deps


def estimate_credits(target_seconds: int, credits_per_minute: int) -> int:
    return max(1, math.ceil(target_seconds / 60 * credits_per_minute))


def _project(conn, ws: str, pid: str) -> dict:
    row = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND id=%s", (ws, pid)).fetchone()
    if not row:
        raise LookupError("project not found")
    return row


def _set_status(conn, ws: str, pid: str, status: str, error: str | None = None) -> None:
    conn.execute("UPDATE projects SET status=%s, error=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (status, error, ws, pid))
    _emit(conn, ws, "project.events", "project.status_changed", {"project_id": pid, "status": status, "error": error})


def _emit(conn, ws: str, topic: str, event_type: str, payload: dict) -> None:
    conn.execute("INSERT INTO outbox (workspace_id, id, topic, event_type, payload) VALUES (%s,%s,%s,%s,%s)",
                 (ws, str(uuid.uuid4()), topic, event_type, json.dumps(payload)))


def _job(conn, ws: str, pid: str, jtype: str, used: Used | None, *, scene: int | None = None, key: str, error: str | None = None) -> None:
    """Records one generation step. The id is derived from `key`, so a retried activity overwrites its own row."""
    jid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"xen-job:{pid}:{key}"))
    conn.execute(
        """INSERT INTO jobs (workspace_id,id,project_id,scene_position,type,provider,model,status,cost_microusd,attempts,duration_ms,error)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (workspace_id,id) DO UPDATE SET provider=excluded.provider, model=excluded.model, status=excluded.status,
             cost_microusd=excluded.cost_microusd, attempts=excluded.attempts, duration_ms=excluded.duration_ms, error=excluded.error, updated_at=now()""",
        (ws, jid, pid, scene, jtype, used.provider if used else "none", used.model if used else "none",
         "failed" if error else "succeeded", used.cost_microusd if used else 0, used.attempts if used else 1, used.duration_ms if used else 0, error))
    _emit(conn, ws, "job.failed" if error else "job.completed", f"job.{jtype}", {"project_id": pid, "job_id": jid, "type": jtype, "scene": scene})


# ── 2. prompt moderation ───────────────────────────────────────────────────────
def moderate_prompt(ws: str, pid: str) -> dict:
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        result, used = d.router.call("moderation", "check", text=p["prompt"])
        conn.execute("INSERT INTO moderation_events (workspace_id,id,subject_type,subject_id,decision,reason,provider) VALUES (%s,%s,'prompt',%s,%s,%s,%s)",
                     (ws, str(uuid.uuid5(uuid.NAMESPACE_URL, f"xen-mod:{pid}:prompt")), pid, result["decision"], result["reason"], used.provider))
        _job(conn, ws, pid, "moderation", used, key="moderate-prompt")
        _emit(conn, ws, "moderation.decisions", "moderation.prompt", {"project_id": pid, **result})
        if result["decision"] == "blocked":
            _set_status(conn, ws, pid, "blocked", result["reason"])
    return result


# ── 3. credits: reserve before generation, debit on success, refund on failure ──
def _ledger(method: str, path: str, key: str, body: dict | None = None) -> httpx.Response:
    d = deps()
    return httpx.request(method, d.cfg.ledger_url + path, json=body or {}, timeout=10,
                         headers={"X-Internal-Token": d.cfg.internal_token, "Idempotency-Key": key})


def reserve_credits(ws: str, pid: str) -> dict:
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        res = _ledger("POST", f"/internal/v1/workspaces/{ws}/credits/reserve", f"project:{pid}:reserve",
                      {"amount": p["estimate_credits"], "job_id": f"project:{pid}"})
        if res.status_code == 402:
            _set_status(conn, ws, pid, "insufficient_credits", "not enough credits for this video")
            return {"ok": False}
        res.raise_for_status()
        conn.execute("UPDATE projects SET reservation_id=%s, updated_at=now() WHERE workspace_id=%s AND id=%s",
                     (res.json()["reservation_id"], ws, pid))
    return {"ok": True}


def settle_credits(ws: str, pid: str, outcome: str, reason: str = "") -> None:
    """outcome = 'commit' (video delivered) or 'release' (failed/cancelled: full refund)."""
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
    if not p["reservation_id"]:
        return
    path = f"/internal/v1/workspaces/{ws}/reservations/{p['reservation_id']}/{outcome}"
    res = _ledger("POST", path, f"project:{pid}:{outcome}", {"reason": reason} if outcome == "release" else {})
    if res.status_code not in (200, 201, 409):  # 409 = already settled, which is the goal
        res.raise_for_status()


# ── 4. research + script ───────────────────────────────────────────────────────
def write_script(ws: str, pid: str, feedback: str = "") -> int:
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        version = p["script_version"] + 1
        _set_status(conn, ws, pid, "writing_script")
        conn.commit()
        notes, r_used = d.router.call("llm", "research", language=p["language"], prompt=p["prompt"])
        script, s_used = d.router.call("llm", "write_script", language=p["language"], prompt=p["prompt"],
                                       target_seconds=p["target_seconds"], notes=notes, feedback=feedback, version=version)
        mod, _ = d.router.call("moderation", "check", text=" ".join(s["narration"] for s in script["scenes"]))
        if mod["decision"] == "blocked":
            _set_status(conn, ws, pid, "blocked", mod["reason"])
            return 0
        conn.execute("UPDATE scripts SET status='rejected', updated_at=now() WHERE workspace_id=%s AND project_id=%s AND status='draft'", (ws, pid))
        conn.execute("INSERT INTO scripts (workspace_id,project_id,version,title,research,status,provider) VALUES (%s,%s,%s,%s,%s,'draft',%s) ON CONFLICT DO NOTHING",
                     (ws, pid, version, script["title"], json.dumps(notes), s_used.provider))
        for i, sc in enumerate(script["scenes"], 1):
            conn.execute("""INSERT INTO scenes (workspace_id,project_id,script_version,position,narration,visual_prompt,seed)
                            VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                         (ws, pid, version, i, sc["narration"], sc["visual"], uuid.uuid5(uuid.NAMESPACE_URL, f"xen-seed:{pid}:{i}").int & 0x7FFFFFFF))
        conn.execute("UPDATE projects SET script_version=%s, title=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (version, script["title"], ws, pid))
        _job(conn, ws, pid, "research", r_used, key=f"research-v{version}")
        _job(conn, ws, pid, "script", s_used, key=f"script-v{version}")
        _emit(conn, ws, "script.generated", "script.generated", {"project_id": pid, "version": version})
        _set_status(conn, ws, pid, "awaiting_approval")
    return version


# ── 5. approval (human step) ───────────────────────────────────────────────────
def approve_script(ws: str, pid: str, user_id: str, edits: list[dict]) -> list[int]:
    """Applies the user's line edits, marks the script approved and returns the scene positions to generate."""
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        v = p["script_version"]
        for e in edits or []:
            text = str(e.get("narration", "")).strip()
            if text:
                mod, _ = d.router.call("moderation", "check", text=text)
                if mod["decision"] == "blocked":
                    raise ValueError(f"edited narration violates the content policy ({mod['reason']})")
                conn.execute("UPDATE scenes SET narration=%s, updated_at=now() WHERE workspace_id=%s AND project_id=%s AND script_version=%s AND position=%s",
                             (text[:2000], ws, pid, v, int(e["position"])))
        conn.execute("UPDATE scripts SET status='approved', approved_by=%s, updated_at=now() WHERE workspace_id=%s AND project_id=%s AND version=%s",
                     (user_id, ws, pid, v))
        rows = conn.execute("SELECT position FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s ORDER BY position", (ws, pid, v)).fetchall()
        _emit(conn, ws, "script.approved", "script.approved", {"project_id": pid, "version": v, "approved_by": user_id})
        _set_status(conn, ws, pid, "generating")
    return [r["position"] for r in rows]


# ── 8. parallel generation: voice + visuals per scene ──────────────────────────
def _scene(conn, ws: str, pid: str, pos: int) -> tuple[dict, dict]:
    p = _project(conn, ws, pid)
    s = conn.execute("SELECT * FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s AND position=%s",
                     (ws, pid, p["script_version"], pos)).fetchone()
    if not s:
        raise LookupError("scene not found")
    return p, s


def _scene_update(conn, ws, pid, version, pos, **cols) -> None:
    sets = ", ".join(f"{k}=%s" for k in cols)
    conn.execute(f"UPDATE scenes SET {sets}, updated_at=now() WHERE workspace_id=%s AND project_id=%s AND script_version=%s AND position=%s",
                 (*cols.values(), ws, pid, version, pos))


def prepare_regeneration(ws: str, pid: str, user_id: str, positions: list[int], feedback: str) -> dict:
    """Review step: records the revision round (enforcing the plan limit) and resets the chosen scenes."""
    d = deps()
    with d.db() as conn:
        p = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND id=%s FOR UPDATE", (ws, pid)).fetchone()
        if p["revision_round"] >= p["max_revisions"]:
            return {"ok": False, "reason": "revision_limit"}
        rnd = p["revision_round"] + 1
        v = p["script_version"]
        valid = [r["position"] for r in conn.execute(
            "SELECT position FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s AND position = ANY(%s) ORDER BY position",
            (ws, pid, v, positions)).fetchall()]
        if not valid:
            return {"ok": False, "reason": "no_scenes"}
        conn.execute("INSERT INTO revisions (workspace_id,project_id,round_number,feedback,scene_ids,requested_by) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                     (ws, pid, rnd, feedback[:2000], json.dumps(valid), user_id))
        for pos in valid:
            s = conn.execute("SELECT narration FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s AND position=%s", (ws, pid, v, pos)).fetchone()
            narration = s["narration"]
            if feedback.strip():
                out, used = d.router.call("llm", "rewrite_scene", language=p["language"], narration=narration, feedback=feedback)
                narration = out["narration"]
                _job(conn, ws, pid, "script", used, scene=pos, key=f"rewrite-r{rnd}-s{pos}")
            conn.execute("""UPDATE scenes SET narration=%s, voice_status='queued', visual_status='queued', generation=generation+1, seed=seed+1, updated_at=now()
                            WHERE workspace_id=%s AND project_id=%s AND script_version=%s AND position=%s""", (narration, ws, pid, v, pos))
        conn.execute("UPDATE projects SET revision_round=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (rnd, ws, pid))
        _emit(conn, ws, "review.submitted", "review.revise", {"project_id": pid, "round": rnd, "scenes": valid})
        _set_status(conn, ws, pid, "generating")
    return {"ok": True, "round": rnd, "positions": valid}


def generate_voice(ws: str, pid: str, pos: int) -> None:
    d = deps()
    with d.db() as conn:
        p, s = _scene(conn, ws, pid, pos)
        v, gen = p["script_version"], s["generation"]
        _scene_update(conn, ws, pid, v, pos, voice_status="running")
        conn.commit()
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "voice.wav")
            try:
                _, used = d.router.call("tts", "speak", language=p["language"], text=s["narration"], voice="slt", out_path=out)
            except Exception as err:
                _scene_update(conn, ws, pid, v, pos, voice_status="failed")
                _job(conn, ws, pid, "voice", None, scene=pos, key=f"voice-s{pos}-g{gen}", error=str(err)[:300])
                conn.commit()
                raise
            dur = media.probe(out)["duration_ms"]
            key = d.storage.put_file(f"{ws}/{pid}/scenes/v{v}/s{pos}-g{gen}.wav", out)
        _scene_update(conn, ws, pid, v, pos, voice_status="succeeded", voice_key=key, duration_ms=dur)
        _job(conn, ws, pid, "voice", used, scene=pos, key=f"voice-s{pos}-g{gen}")


def generate_visual(ws: str, pid: str, pos: int) -> None:
    """Runs after the scene's voice so the clip is cut to the narration length."""
    d = deps()
    with d.db() as conn:
        p, s = _scene(conn, ws, pid, pos)
        v, gen = p["script_version"], s["generation"]
        _scene_update(conn, ws, pid, v, pos, visual_status="running")
        conn.commit()
        seconds = max(1.0, s["duration_ms"] / 1000)
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "visual.mp4")
            try:
                _, used = d.router.call("visual", "render", visual_prompt=s["visual_prompt"], seed=s["seed"], seconds=seconds,
                                        width=1280, height=720, out_path=out)
                qc, qc_used = d.router.call("qc", "score", path=out, expected_ms=int(seconds * 1000))
                if qc["score"] < 0.3:  # automated quality check: one retry on a different seed before the user sees it
                    _, used = d.router.call("visual", "render", visual_prompt=s["visual_prompt"], seed=s["seed"] + 7, seconds=seconds,
                                            width=1280, height=720, out_path=out)
                    qc, qc_used = d.router.call("qc", "score", path=out, expected_ms=int(seconds * 1000))
            except Exception as err:
                _scene_update(conn, ws, pid, v, pos, visual_status="failed")
                _job(conn, ws, pid, "visual", None, scene=pos, key=f"visual-s{pos}-g{gen}", error=str(err)[:300])
                conn.commit()
                raise
            key = d.storage.put_file(f"{ws}/{pid}/scenes/v{v}/s{pos}-g{gen}.mp4", out)
        _scene_update(conn, ws, pid, v, pos, visual_status="succeeded", visual_key=key, qc_score=qc["score"])
        _job(conn, ws, pid, "visual", used, scene=pos, key=f"visual-s{pos}-g{gen}")
        _job(conn, ws, pid, "qc", qc_used, scene=pos, key=f"qc-s{pos}-g{gen}")
        _emit(conn, ws, "qc.scored", "qc.scored", {"project_id": pid, "scene": pos, "score": qc["score"]})


# ── 9-11. assembly, QC, output moderation, provenance ──────────────────────────
def assemble_render(ws: str, pid: str) -> int:
    d = deps()
    started = time.monotonic()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        v, rv = p["script_version"], p["render_version"] + 1
        scenes = conn.execute("SELECT * FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s ORDER BY position", (ws, pid, v)).fetchall()
        if any(s["voice_status"] != "succeeded" or s["visual_status"] != "succeeded" for s in scenes):
            raise RuntimeError("cannot assemble: not every scene finished generating")
        # output moderation before delivery
        mod, mod_used = d.router.call("moderation", "check", text=" ".join(s["narration"] for s in scenes))
        conn.execute("INSERT INTO moderation_events (workspace_id,id,subject_type,subject_id,decision,reason,provider) VALUES (%s,%s,'render',%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                     (ws, str(uuid.uuid5(uuid.NAMESPACE_URL, f"xen-mod:{pid}:render:{rv}")), f"{pid}:v{rv}", mod["decision"], mod["reason"], mod_used.provider))
        if mod["decision"] == "blocked":
            _set_status(conn, ws, pid, "blocked", mod["reason"])
            return 0
        cues, t = [], 0
        for s in scenes:
            cues.append((t, t + s["duration_ms"], s["narration"]))
            t += s["duration_ms"]
        srt, vtt = media.subtitles(cues)
        base = f"{ws}/{pid}/renders/v{rv}"
        srt_key = d.storage.put_text(f"{base}/subtitles.srt", srt)
        d.storage.put_text(f"{base}/subtitles.vtt", vtt)
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "render.mp4")
            media.assemble([(str(d.storage.path(s["visual_key"])), str(d.storage.path(s["voice_key"]))) for s in scenes],
                           str(d.storage.path(srt_key)), out, "Xen Studio" if p["watermark"] else None)
            qc, qc_used = d.router.call("qc", "score", path=out, expected_ms=t)
            digest = media.sha256(out)
            video_key = d.storage.put_file(f"{base}/video.mp4", out)
        models = conn.execute("SELECT DISTINCT type, provider, model FROM jobs WHERE workspace_id=%s AND project_id=%s AND status='succeeded' ORDER BY type", (ws, pid)).fetchall()
        # Provenance manifest (C2PA-shaped assertions). Cryptographic C2PA signing needs a signing
        # certificate and is applied by the provenance signer in deployment; see PROGRESS.md.
        prov_key = d.storage.put_text(f"{base}/provenance.json", json.dumps({
            "claim_generator": "Xen Studio", "title": p["title"], "created": datetime.now(timezone.utc).isoformat(),
            "assertions": [{"label": "c2pa.actions", "data": {"actions": [{"action": "c2pa.created", "digitalSourceType": "trainedAlgorithmicMedia"}]}},
                           {"label": "xen.models", "data": models}],
            "asset": {"sha256": digest, "format": "video/mp4"}, "ai_generated": True, "watermarked": bool(p["watermark"]), "signed": False}, indent=2))
        conn.execute("""INSERT INTO renders (workspace_id,project_id,version,storage_key,subtitles_key,provenance_key,duration_ms,qc_score)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""", (ws, pid, rv, video_key, srt_key, prov_key, qc["duration_ms"], qc["score"]))
        conn.execute("UPDATE projects SET render_version=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (rv, ws, pid))
        _job(conn, ws, pid, "assembly", Used("ffmpeg", "libx264", 0, 1, int((time.monotonic() - started) * 1000)), key=f"assembly-v{rv}")
        _job(conn, ws, pid, "qc", qc_used, key=f"qc-render-v{rv}")
        _emit(conn, ws, "render.completed", "render.completed", {"project_id": pid, "version": rv, "qc_score": qc["score"]})
        _set_status(conn, ws, pid, "in_review")
    return rv


def finish(ws: str, pid: str, status: str, error: str | None = None) -> None:
    d = deps()
    with d.db() as conn:
        _set_status(conn, ws, pid, status, error)


ALL = [moderate_prompt, reserve_credits, settle_credits, write_script, approve_script, prepare_regeneration,
       generate_voice, generate_visual, assemble_render, finish]
