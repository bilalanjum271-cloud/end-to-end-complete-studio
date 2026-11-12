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
import textwrap
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


# ── 2b. link ingestion with rights screen (Animation Studio) ────────────────────
def ingest_source(ws: str, pid: str) -> str:
    """Returns 'clear', 'review' (held for a human) or 'rejected'. Text is stored on the project, never re-fetched."""
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        if p["source_type"] != "link":
            return "clear"
        _set_status(conn, ws, pid, "ingesting")
        conn.commit()
        try:
            page, used = d.router.call("ingest", "fetch", url=p["source_url"])
        except Exception as err:  # noqa: BLE001
            _set_status(conn, ws, pid, "failed", f"could not read the link: {str(err)[:200]}")
            return "rejected"
        verdict, r_used = d.router.call("rights", "check", url=p["source_url"], text=page["text"])
        conn.execute("UPDATE projects SET source_text=%s, title=COALESCE(NULLIF(%s,''), title), updated_at=now() WHERE workspace_id=%s AND id=%s",
                     (page["text"][:20000], page.get("title", ""), ws, pid))
        conn.execute("UPDATE rights_records SET check_result=%s, check_reason=%s, updated_at=now() WHERE workspace_id=%s AND id=%s",
                     (verdict["result"], verdict["reason"], ws, p["rights_record_id"]))
        _job(conn, ws, pid, "ingest", used, key="ingest")
        _job(conn, ws, pid, "rights", r_used, key="rights")
        if verdict["result"] == "needs_review":
            conn.execute("INSERT INTO moderation_events (workspace_id,id,subject_type,subject_id,decision,reason,provider) VALUES (%s,%s,'rights',%s,'flagged',%s,%s) ON CONFLICT DO NOTHING",
                         (ws, str(uuid.uuid5(uuid.NAMESPACE_URL, f"xen-mod:{pid}:rights")), pid, verdict["reason"][:300], r_used.provider))
            _set_status(conn, ws, pid, "rights_review", verdict["reason"])
            return "review"
        if verdict["result"] == "rejected":
            _set_status(conn, ws, pid, "blocked", verdict["reason"])
            return "rejected"
    return "clear"


def rights_decided(ws: str, pid: str, approved: bool) -> None:
    with deps().db() as conn:
        p = _project(conn, ws, pid)
        conn.execute("UPDATE rights_records SET check_result=%s, updated_at=now() WHERE workspace_id=%s AND id=%s",
                     ("clear" if approved else "rejected", ws, p["rights_record_id"]))
        if not approved:
            _set_status(conn, ws, pid, "blocked", "rights review: the link may not be used")


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
        if p["source_type"] in ("text", "link"):
            # the user's own material: adapt it, do not research or invent around it
            notes, r_used = [], None
            source = p["source_text"] if p["source_type"] == "link" else p["prompt"]
            if feedback:
                source = f"{source}\n\nRevision request: {feedback}"
            script, s_used = d.router.call("llm", "adapt", language=p["language"], text=source, target_seconds=p["target_seconds"], title_hint=p["title"] if p["source_type"] == "link" else "")
        else:
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
        if r_used:
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
                _, used = d.router.call("tts", "speak", language=p["language"], text=s["narration"], voice=p["voice"] or "slt", out_path=out)
            except Exception as err:
                _scene_update(conn, ws, pid, v, pos, voice_status="failed")
                _job(conn, ws, pid, "voice", None, scene=pos, key=f"voice-s{pos}-g{gen}", error=str(err)[:300])
                conn.commit()
                raise
            dur = media.probe(out)["duration_ms"]
            key = d.storage.put_file(f"{ws}/{pid}/scenes/v{v}/s{pos}-g{gen}.wav", out)
        _scene_update(conn, ws, pid, v, pos, voice_status="succeeded", voice_key=key, duration_ms=dur)
        _job(conn, ws, pid, "voice", used, scene=pos, key=f"voice-s{pos}-g{gen}")


def _style_for(conn, ws: str, p: dict, s: dict) -> tuple[dict | None, str, int]:
    """Style profile look + character sheet. A character keeps one seed across every scene it appears in,
    which is how image models keep a character consistent; their description is repeated in each prompt."""
    prompt, seed, style = s["visual_prompt"], s["seed"], None
    if p["style_profile"]:
        row = conn.execute("SELECT look, palette FROM style_profiles WHERE id=%s AND workspace_id IN (%s, '00000000-0000-0000-0000-000000000000') "
                           "ORDER BY workspace_id DESC LIMIT 1", (p["style_profile"], ws)).fetchone()
        if row:
            style = {"look": row["look"], "palette": row["palette"]}
    present = [c for c in (p["characters"] or []) if c.get("name") and c["name"].lower() in (s["narration"] + " " + prompt).lower()]
    if present:
        prompt = f"{prompt}. Characters: " + "; ".join(f"{c['name']}: {c.get('description', '')}" for c in present)
        seed = uuid.uuid5(uuid.NAMESPACE_URL, f"xen-char:{p['id']}:{present[0]['name'].lower()}").int & 0x7FFFFFFF
    return style, prompt, seed


def generate_visual(ws: str, pid: str, pos: int) -> None:
    """Runs after the scene's voice so the clip is cut to the narration length."""
    d = deps()
    with d.db() as conn:
        p, s = _scene(conn, ws, pid, pos)
        v, gen = p["script_version"], s["generation"]
        _scene_update(conn, ws, pid, v, pos, visual_status="running")
        conn.commit()
        seconds = max(1.0, s["duration_ms"] / 1000)
        style, prompt, seed = _style_for(conn, ws, p, s)
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "visual.mp4")
            try:
                _, used = d.router.call("visual", "render", visual_prompt=prompt, seed=seed, seconds=seconds,
                                        width=1280, height=720, out_path=out, style=style)
                qc, qc_used = d.router.call("qc", "score", path=out, expected_ms=int(seconds * 1000))
                if qc["score"] < 0.3:  # automated quality check: one retry on a different seed before the user sees it
                    _, used = d.router.call("visual", "render", visual_prompt=prompt, seed=seed + 7, seconds=seconds,
                                            width=1280, height=720, out_path=out, style=style)
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
            if p["music"] != "none":
                bed = os.path.join(tmp, "music.wav")
                _, m_used = d.router.call("music", "compose", seconds=t / 1000 + 1, mood=p["music"], out_path=bed)
                mixed = os.path.join(tmp, "mixed.mp4")
                media.add_music(out, bed, mixed)
                out = mixed
                _job(conn, ws, pid, "music", m_used, key=f"music-v{rv}")
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
    return rv  # the flow moves the project to in_review after packaging, so review opens complete


# ── 13. packaging: titles, description, tags, thumbnail ────────────────────────
def package_render(ws: str, pid: str) -> bool:
    """Publish-ready packaging for the newest render. Best effort: a packaging failure never fails the video."""
    d = deps()
    try:
        with d.db() as conn:
            p = _project(conn, ws, pid)
            rv = p["render_version"]
            render = conn.execute("SELECT storage_key FROM renders WHERE workspace_id=%s AND project_id=%s AND version=%s", (ws, pid, rv)).fetchone()
            first = conn.execute("SELECT narration FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s ORDER BY position LIMIT 1",
                                 (ws, pid, p["script_version"])).fetchone()
            pkg, used = d.router.call("llm", "package", language=p["language"], title=p["title"], narration=first["narration"])
            thumb_key = None
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "thumb.jpg")
                titlefile = os.path.join(tmp, "title.txt")
                with open(titlefile, "w") as f:
                    f.write("\n".join(textwrap.wrap(pkg["titles"][0], 22)[:3]))
                media.run(["ffmpeg", "-y", "-ss", "1", "-i", str(d.storage.path(render["storage_key"])), "-frames:v", "1",
                           "-vf", f"drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill,drawtext=textfile={titlefile}:fontcolor=white:fontsize=h/8:line_spacing=18:x=64:y=(h-text_h)/2",
                           "-q:v", "3", out])
                thumb_key = d.storage.put_file(f"{ws}/{pid}/renders/v{rv}/thumbnail.jpg", out)
            conn.execute("""INSERT INTO publish_packages (workspace_id,project_id,render_version,titles,description,tags,thumbnail_key,provider)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                            ON CONFLICT (workspace_id,project_id,render_version) DO UPDATE SET titles=excluded.titles, description=excluded.description,
                              tags=excluded.tags, thumbnail_key=excluded.thumbnail_key, provider=excluded.provider, updated_at=now()""",
                         (ws, pid, rv, json.dumps(pkg["titles"]), pkg["description"], json.dumps(pkg["tags"]), thumb_key, used.provider))
            _job(conn, ws, pid, "packaging", used, key=f"package-v{rv}")
        return True
    except Exception:  # noqa: BLE001
        return False


# ── multi-format export (9:16 for Shorts / Reels / TikTok, 1:1 for feeds) ──────
EXPORT_SIZES = {"9:16": (720, 1280), "1:1": (720, 720)}


def export_render(ws: str, pid: str, version: int, fmt: str) -> None:
    d = deps()
    w, h = EXPORT_SIZES[fmt]
    with d.db() as conn:
        render = conn.execute("SELECT storage_key FROM renders WHERE workspace_id=%s AND project_id=%s AND version=%s", (ws, pid, version)).fetchone()
        conn.execute("UPDATE exports SET status='running', updated_at=now() WHERE workspace_id=%s AND project_id=%s AND render_version=%s AND format=%s", (ws, pid, version, fmt))
        conn.commit()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "export.mp4")
                # Automatic reframing: centre crop to the target aspect, then scale. (Subject-aware reframing arrives with real video models.)
                media.run(["ffmpeg", "-y", "-i", str(d.storage.path(render["storage_key"])), "-map", "0:v:0", "-map", "0:a:0", "-map", "0:s?",
                           "-vf", f"crop=ih*{w}/{h}:ih,scale={w}:{h},setsar=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                           "-c:a", "copy", "-c:s", "copy", "-movflags", "+faststart", out])
                key = d.storage.put_file(f"{ws}/{pid}/renders/v{version}/export-{fmt.replace(':', 'x')}.mp4", out)
        except Exception as err:  # noqa: BLE001
            conn.execute("UPDATE exports SET status='failed', error=%s, updated_at=now() WHERE workspace_id=%s AND project_id=%s AND render_version=%s AND format=%s",
                         (str(err)[:300], ws, pid, version, fmt))
            return
        conn.execute("UPDATE exports SET status='succeeded', storage_key=%s, error=NULL, updated_at=now() WHERE workspace_id=%s AND project_id=%s AND render_version=%s AND format=%s",
                     (key, ws, pid, version, fmt))
        _emit(conn, ws, "project.events", "export.completed", {"project_id": pid, "version": version, "format": fmt})
    notify(ws, pid, "export_ready")


# ── 14. notify: in-app feed, email, push ───────────────────────────────────────
NOTIFY_TITLES = {"script_ready": "Your script is ready to approve", "video_ready": "Your video is ready to review",
                 "generation_failed": "A video could not be generated. Your credits were returned.", "export_ready": "Your export is ready to download",
                 "localization_review": "A {lang} translation is ready for review", "localization_ready": "Your {lang} version is ready"}


def notify(ws: str, pid: str, kind: str) -> None:
    """One notification per (project, kind, version); a retried activity does not notify twice.
    kind may carry a qualifier after a colon, e.g. "localization_ready:ur"."""
    d = deps()
    base_kind, _, qualifier = kind.partition(":")
    with d.db() as conn:
        p = _project(conn, ws, pid)
        user = conn.execute("SELECT email FROM users WHERE id=%s", (p["created_by"],)).fetchone()
        nid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"xen-notify:{pid}:{kind}:{p['script_version']}:{p['render_version']}"))
        title = f"{NOTIFY_TITLES[base_kind].format(lang=qualifier)}: {p['title']}"[:200]
        inserted = conn.execute("""INSERT INTO notifications (workspace_id,id,user_id,kind,project_id,title,link) VALUES (%s,%s,%s,%s,%s,%s,%s)
                                   ON CONFLICT (workspace_id,id) DO NOTHING RETURNING id""", (ws, nid, p["created_by"], base_kind, pid, title,
                                    f"/app/video/{pid}/localize/{qualifier}" if base_kind == "localization_review" else f"/app/video/{pid}")).fetchone()
        if not inserted:
            return
        deliveries = [("in_app", "database", "sent", None)]
        for channel in ("email", "push"):
            try:
                _, used = d.router.call(channel, "send", to=user["email"] if user else "", subject=title, body=title)
                deliveries.append((channel, used.provider, "sent", None))
            except Exception as err:  # noqa: BLE001 - a failed channel is logged, never fatal
                deliveries.append((channel, "none", "failed", str(err)[:300]))
        for channel, provider, status, error in deliveries:
            conn.execute("INSERT INTO notification_deliveries (workspace_id,notification_id,channel,provider,status,error) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                         (ws, nid, channel, provider, status, error))


# ── localization: translate with glossary -> human review -> dubbed render ─────
ISO639_2 = {"en": "eng", "ur": "urd", "ar": "ara", "es": "spa", "fr": "fra", "de": "deu", "hi": "hin", "pt": "por", "id": "ind", "tr": "tur"}


def _loc_update(conn, ws, pid, lang, **cols) -> None:
    sets = ", ".join(f"{k}=%s" for k in cols)
    conn.execute(f"UPDATE localizations SET {sets}, updated_at=now() WHERE workspace_id=%s AND project_id=%s AND language=%s", (*cols.values(), ws, pid, lang))


def localize(ws: str, pid: str, lang: str) -> None:
    d = deps()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        scenes = conn.execute("SELECT narration FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s ORDER BY position",
                              (ws, pid, p["script_version"])).fetchall()
        source = [s["narration"] for s in scenes]
        glossary = conn.execute("SELECT source, target FROM glossary_terms WHERE workspace_id=%s AND language=%s ORDER BY length(source) DESC", (ws, lang)).fetchall()
        try:
            lines, used = d.router.call("llm", "translate", texts=source, source=p["language"], target=lang, glossary=[dict(g) for g in glossary])
            mod, _ = d.router.call("moderation", "check", text=" ".join(lines))
            if mod["decision"] == "blocked":
                raise ValueError(f"translation blocked by content policy ({mod['reason']})")
        except Exception as err:  # noqa: BLE001
            _loc_update(conn, ws, pid, lang, status="failed", error=str(err)[:300])
            return
        _loc_update(conn, ws, pid, lang, status="in_review", source_lines=json.dumps(source), lines=json.dumps(lines), provider=used.provider, error=None)
        _job(conn, ws, pid, "translate", used, key=f"translate-{lang}-v{p['script_version']}")
        _emit(conn, ws, "localization.completed", "localization.translated", {"project_id": pid, "language": lang})
    notify(ws, pid, f"localization_review:{lang}")


def render_localization(ws: str, pid: str, lang: str) -> None:
    """Dubs the approved translation over the source render's scene visuals. Credits were reserved at approval."""
    d = deps()
    started = time.monotonic()
    with d.db() as conn:
        p = _project(conn, ws, pid)
        loc = conn.execute("SELECT * FROM localizations WHERE workspace_id=%s AND project_id=%s AND language=%s", (ws, pid, lang)).fetchone()
        scenes = conn.execute("SELECT visual_key FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s ORDER BY position",
                              (ws, pid, p["script_version"])).fetchall()
        lines = loc["lines"]
        base = f"{ws}/{pid}/localizations/{lang}/v{loc['render_version']}"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                segments, cues, t, cost = [], [], 0, 0
                for i, (scene, text) in enumerate(zip(scenes, lines, strict=True), 1):
                    wav = os.path.join(tmp, f"s{i}.wav")
                    _, used = d.router.call("tts", "speak", language=lang, text=text, voice="", out_path=wav)
                    cost += used.cost_microusd
                    dur = media.probe(wav)["duration_ms"]
                    cues.append((t, t + dur, text))
                    t += dur
                    segments.append((str(d.storage.path(scene["visual_key"])), wav))
                srt, vtt = media.subtitles(cues)
                srt_key = d.storage.put_text(f"{base}/subtitles.srt", srt)
                d.storage.put_text(f"{base}/subtitles.vtt", vtt)
                out = os.path.join(tmp, "dub.mp4")
                media.assemble(segments, str(d.storage.path(srt_key)), out, "Xen Studio" if p["watermark"] else None,
                               fit_video_to_audio=True, language=ISO639_2.get(lang, "und"))
                key = d.storage.put_file(f"{base}/video.mp4", out)
        except Exception as err:  # noqa: BLE001
            _loc_update(conn, ws, pid, lang, status="failed", error=str(err)[:300])
            conn.commit()
            _settle_localization(ws, pid, lang, loc["reservation_id"], "release")
            return
        _loc_update(conn, ws, pid, lang, status="ready", storage_key=key, subtitles_key=srt_key, error=None)
        _job(conn, ws, pid, "dub", Used("ffmpeg+tts", "dub", cost, 1, int((time.monotonic() - started) * 1000)), key=f"dub-{lang}-v{loc['render_version']}")
        _emit(conn, ws, "render.completed", "localization.rendered", {"project_id": pid, "language": lang})
    _settle_localization(ws, pid, lang, loc["reservation_id"], "commit")
    notify(ws, pid, f"localization_ready:{lang}")


def _settle_localization(ws: str, pid: str, lang: str, reservation_id, outcome: str) -> None:
    if not reservation_id:
        return
    res = _ledger("POST", f"/internal/v1/workspaces/{ws}/reservations/{reservation_id}/{outcome}", f"localization:{pid}:{lang}:{outcome}",
                  {"reason": "dubbing failed"} if outcome == "release" else {})
    if res.status_code not in (200, 201, 409):
        res.raise_for_status()


def reserve_localization(ws: str, pid: str, lang: str, amount: int) -> bool:
    res = _ledger("POST", f"/internal/v1/workspaces/{ws}/credits/reserve", f"localization:{pid}:{lang}:reserve", {"amount": amount, "job_id": f"localization:{pid}:{lang}"})
    if res.status_code == 402:
        return False
    res.raise_for_status()
    with deps().db() as conn:
        _loc_update(conn, ws, pid, lang, reservation_id=res.json()["reservation_id"], credits=amount)
    return True


# ── XR: shared 3D asset pipeline ───────────────────────────────────────────────
XR_ASSET_CREDITS = 5


def generate_xr_asset(ws: str, aid: str) -> None:
    """Moderate -> reserve -> text-to-3D -> validate GLB -> store -> debit (or refund on failure)."""
    d = deps()
    with d.db() as conn:
        a = conn.execute("SELECT * FROM xr_assets WHERE workspace_id=%s AND id=%s", (ws, aid)).fetchone()
        if a["status"] in ("ready", "failed", "blocked"):
            return
        mod, _ = d.router.call("moderation", "check", text=a["prompt"])
        if mod["decision"] == "blocked":
            conn.execute("UPDATE xr_assets SET status='blocked', error=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (mod["reason"], ws, aid))
            return
    res = _ledger("POST", f"/internal/v1/workspaces/{ws}/credits/reserve", f"xr-asset:{aid}:reserve", {"amount": XR_ASSET_CREDITS, "job_id": f"xr-asset:{aid}"})
    if res.status_code == 402:
        with d.db() as conn:
            conn.execute("UPDATE xr_assets SET status='failed', error='not enough credits', updated_at=now() WHERE workspace_id=%s AND id=%s", (ws, aid))
        return
    res.raise_for_status()
    rid = res.json()["reservation_id"]
    with d.db() as conn:
        conn.execute("UPDATE xr_assets SET status='generating', reservation_id=%s, credits=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (rid, XR_ASSET_CREDITS, ws, aid))
        conn.commit()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = os.path.join(tmp, "asset.glb")
                info, used = d.router.call("3d", "generate", prompt=a["prompt"], out_path=out)
                from ..xr.glb import read_glb
                read_glb(out)
                key = d.storage.put_file(f"{ws}/xr/assets/{aid}.glb", out)
        except Exception as err:  # noqa: BLE001
            conn.execute("UPDATE xr_assets SET status='failed', error=%s, updated_at=now() WHERE workspace_id=%s AND id=%s", (str(err)[:300], ws, aid))
            conn.commit()
            _ledger("POST", f"/internal/v1/workspaces/{ws}/reservations/{rid}/release", f"xr-asset:{aid}:release", {"reason": "3D generation failed"})
            return
        conn.execute("UPDATE xr_assets SET status='ready', storage_key=%s, provider=%s, triangles=%s, bounds=%s, error=NULL, updated_at=now() WHERE workspace_id=%s AND id=%s",
                     (key, used.provider, info.get("triangles", 0), json.dumps(info.get("bounds")), ws, aid))
        conn.execute("""INSERT INTO jobs (workspace_id,id,project_id,type,provider,model,status,cost_microusd,attempts,duration_ms)
                        VALUES (%s,%s,%s,'3d',%s,%s,'succeeded',%s,%s,%s) ON CONFLICT DO NOTHING""",
                     (ws, str(uuid.uuid5(uuid.NAMESPACE_URL, f"xen-job:{aid}:3d")), aid, used.provider, used.model, used.cost_microusd, used.attempts, used.duration_ms))
        _emit(conn, ws, "xr.asset.generated", "xr.asset.generated", {"asset_id": aid, "provider": used.provider})
    _ledger("POST", f"/internal/v1/workspaces/{ws}/reservations/{rid}/commit", f"xr-asset:{aid}:commit", {})


def finish(ws: str, pid: str, status: str, error: str | None = None) -> None:
    d = deps()
    with d.db() as conn:
        _set_status(conn, ws, pid, status, error)


ALL = [moderate_prompt, reserve_credits, settle_credits, write_script, approve_script, prepare_regeneration,
       generate_voice, generate_visual, assemble_render, package_render, export_render, notify, localize, render_localization, finish,
       ingest_source, rights_decided, generate_xr_asset]
