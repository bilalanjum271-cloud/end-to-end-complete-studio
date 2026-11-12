"""Project API for the Script-to-Video Studio. Sits behind the gateway, which has already
verified the access token and injected X-Workspace-Id / X-User-Id / X-Role / X-Plan.

Every query is scoped by workspace_id. Every write requires an Idempotency-Key.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import uuid
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .. import config
from ..pipeline import activities
from ..pipeline.local_runner import LocalOrchestrator
from ..router import default_router

RANK = {"viewer": 1, "editor": 2, "admin": 3, "owner": 4}
LANGUAGES = ["en", "ur", "ar", "es", "fr", "de", "hi", "pt", "id", "tr"]  # Starter tier's 10; more arrive with Phase 3


class Actor(BaseModel):
    user_id: str
    workspace_id: str
    role: str
    plan: str
    platform_role: str = "user"  # filled from the database by admin endpoints, never from headers


class Character(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    description: str = Field(default="", max_length=300)


class CreateProject(BaseModel):
    """Script-to-Video: dashboard_type=video, source_type=prompt.
    Animation: dashboard_type=animation, source_type=text (prompt holds the user's text) or link (source_url + rights attestation)."""
    dashboard_type: Literal["video", "animation"] = "video"
    source_type: Literal["prompt", "text", "link"] = "prompt"
    prompt: str = Field(default="", max_length=20000)
    source_url: str | None = Field(default=None, max_length=2000)
    rights_attested: bool = False
    language: str = Field(default="en", pattern="^[a-z]{2}$")
    target_seconds: int = Field(ge=10, le=3600)
    style_profile: str | None = Field(default=None, max_length=40)
    characters: list[Character] = Field(default_factory=list, max_length=8)
    music: Literal["none", "calm", "uplifting", "tense"] = "none"
    voice: str = Field(default="", max_length=80)
    consent_record_id: str | None = None


class Consent(BaseModel):
    kind: Literal["voice_clone", "face_clone"]
    subject_name: str = Field(min_length=2, max_length=120)
    statement: str = Field(min_length=20, max_length=2000)


RIGHTS_STATEMENT = ("I own this content or hold the rights needed to adapt it, and I accept responsibility for its use. "
                    "I understand Xen Studio may hold or remove projects that infringe others' rights.")


class Estimate(BaseModel):
    target_seconds: int = Field(ge=10, le=3600)


class SceneEdit(BaseModel):
    position: int = Field(ge=1)
    narration: str = Field(min_length=1, max_length=2000)


class Approve(BaseModel):
    edits: list[SceneEdit] = Field(default_factory=list, max_length=100)


class Regenerate(BaseModel):
    feedback: str = Field(default="", max_length=2000)


class ExportRequest(BaseModel):
    format: Literal["9:16", "1:1"]


class MarkRead(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=200)  # empty = mark everything read


class GlossaryTerm(BaseModel):
    language: str = Field(pattern="^[a-z]{2}$")
    source: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=120)


class LocalizeRequest(BaseModel):
    language: str = Field(pattern="^[a-z]{2}$")


class ApproveLocalization(BaseModel):
    lines: list[str] = Field(min_length=1, max_length=100)


class Review(BaseModel):
    action: Literal["accept", "revise"]
    scene_positions: list[int] = Field(default_factory=list, max_length=100)
    feedback: str = Field(default="", max_length=2000)


def create_app() -> FastAPI:
    cfg = config.load()
    deps = activities.Deps(cfg, default_router())
    activities.configure(deps)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if cfg.orchestrator == "temporal":
            from temporalio.client import Client

            from ..pipeline.temporal_workflow import TemporalOrchestrator
            app.state.orch = TemporalOrchestrator(await Client.connect(cfg.temporal_address))
        else:
            app.state.orch = LocalOrchestrator()
        yield

    app = FastAPI(title="Xen Studio · Studio API", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException):
        code = {400: "invalid_argument", 401: "unauthenticated", 402: "insufficient_credits", 403: "forbidden", 404: "not_found", 409: "conflict"}.get(exc.status_code, "error")
        return JSONResponse({"error": {"code": code, "message": exc.detail}}, status_code=exc.status_code)

    def actor(x_gateway_token: str = Header(default=""), x_user_id: str = Header(default=""), x_workspace_id: str = Header(default=""),
              x_role: str = Header(default=""), x_plan: str = Header(default="")) -> Actor:
        if not hmac.compare_digest(x_gateway_token, cfg.internal_token):
            raise HTTPException(401, "requests must come through the gateway")
        try:
            uuid.UUID(x_user_id), uuid.UUID(x_workspace_id)
        except ValueError:
            raise HTTPException(401, "authentication required") from None
        if x_role not in RANK:
            raise HTTPException(403, "no role in this workspace")
        return Actor(user_id=x_user_id, workspace_id=x_workspace_id, role=x_role, plan=x_plan)

    def editor(a: Actor = Depends(actor)) -> Actor:
        if RANK[a.role] < RANK["editor"]:
            raise HTTPException(403, "requires role editor or higher")
        return a

    def plan_of(conn, ws: str) -> dict:
        row = conn.execute("SELECT p.* FROM workspaces w JOIN plans p ON p.id = w.plan_id WHERE w.id=%s", (ws,)).fetchone()
        if not row:
            raise HTTPException(403, "workspace not found")
        return row

    def quote(conn, ws: str, seconds: int) -> dict:
        plan = plan_of(conn, ws)
        credits = activities.estimate_credits(seconds, cfg.credits_per_minute)
        return {"credits": credits, "target_seconds": seconds, "estimated_render_seconds": max(5, seconds // 3),
                "max_video_seconds": plan["max_video_seconds"], "within_plan": seconds <= plan["max_video_seconds"],
                "max_revisions": plan["max_revisions"], "watermark": plan["watermark"], "plan": plan["id"]}

    def load(conn, ws: str, pid: str) -> dict:
        try:
            uuid.UUID(pid)
        except ValueError:
            raise HTTPException(404, "project not found") from None
        row = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND id=%s", (ws, pid)).fetchone()
        if not row:
            raise HTTPException(404, "project not found")  # also the answer for other tenants' projects
        return row

    def summary(p: dict) -> dict:
        return {k: (str(p[k]) if k in ("id", "created_at", "updated_at") else p[k]) for k in
                ("id", "title", "prompt", "language", "target_seconds", "status", "error", "estimate_credits", "script_version",
                 "render_version", "revision_round", "max_revisions", "watermark", "created_at", "updated_at",
                 "dashboard_type", "source_type", "source_url", "style_profile", "characters", "music", "voice")}

    @app.get("/healthz", response_class=PlainTextResponse)
    def healthz():
        return "ok"

    @app.get("/readyz", response_class=PlainTextResponse)
    def readyz():
        with deps.db() as conn:
            conn.execute("SELECT 1")
        return "ready"

    @app.get("/v1/projects/meta")
    def meta(a: Actor = Depends(actor)):
        with deps.db() as conn:
            plan = plan_of(conn, a.workspace_id)
        return {"languages": LANGUAGES, "max_video_seconds": plan["max_video_seconds"], "max_revisions": plan["max_revisions"],
                "credits_per_minute": cfg.credits_per_minute, "providers": deps.router.catalog()}

    @app.post("/v1/projects/estimate")
    def estimate(body: Estimate, a: Actor = Depends(actor)):
        with deps.db() as conn:
            return quote(conn, a.workspace_id, body.target_seconds)

    @app.post("/v1/projects", status_code=201)
    async def create(body: CreateProject, request: Request, a: Actor = Depends(editor), idempotency_key: str = Header(default="")):
        if not idempotency_key or len(idempotency_key) > 200:
            raise HTTPException(400, "Idempotency-Key header is required")
        if body.language not in LANGUAGES:
            raise HTTPException(400, f"language must be one of {', '.join(LANGUAGES)}")
        prompt = body.prompt.strip()
        if body.dashboard_type == "video" and body.source_type != "prompt":
            raise HTTPException(400, "Script-to-Video starts from a prompt")
        if body.dashboard_type == "animation" and body.source_type == "prompt":
            raise HTTPException(400, "Animation starts from your text or a link to content you own")
        if body.source_type in ("prompt", "text") and len(prompt) < 10:
            raise HTTPException(400, "describe the video in at least 10 characters")
        if body.source_type == "link":
            from urllib.parse import urlparse
            u = urlparse(body.source_url or "")
            if u.scheme not in ("http", "https") or not u.hostname:
                raise HTTPException(400, "source_url must be an http(s) link")
            if not body.rights_attested:
                raise HTTPException(400, "confirm that you own this content or hold the rights to adapt it")
            prompt = prompt or body.source_url
        with deps.db() as conn:
            q = quote(conn, a.workspace_id, body.target_seconds)
            plan = plan_of(conn, a.workspace_id)
            if not q["within_plan"]:
                raise HTTPException(403, f"your plan allows videos up to {q['max_video_seconds'] // 60} minutes")
            if body.dashboard_type == "animation" and plan["animation_access"] == "none":
                raise HTTPException(403, "your plan does not include the Animation Studio")
            if body.style_profile and not conn.execute("SELECT 1 FROM style_profiles WHERE id=%s AND workspace_id IN (%s,'00000000-0000-0000-0000-000000000000')",
                                                       (body.style_profile, a.workspace_id)).fetchone():
                raise HTTPException(400, "unknown style profile")
            if body.voice.startswith("clone:"):
                # cloned voices need a stored, unrevoked consent record from the person being cloned
                ok = body.consent_record_id and conn.execute("SELECT 1 FROM consent_records WHERE workspace_id=%s AND id::text=%s AND kind='voice_clone' AND revoked_at IS NULL",
                                                             (a.workspace_id, body.consent_record_id)).fetchone()
                if not ok:
                    raise HTTPException(403, "a cloned voice needs a consent record from the person whose voice it is")
            pid = str(uuid.uuid4())
            rights_id = None
            if body.source_type == "link":
                existing = conn.execute("SELECT rights_record_id FROM projects WHERE workspace_id=%s AND idempotency_key=%s", (a.workspace_id, idempotency_key)).fetchone()
                rights_id = existing["rights_record_id"] if existing else str(uuid.uuid4())
                if not existing:
                    conn.execute("INSERT INTO rights_records (workspace_id,id,source_url,attestation,user_id,ip) VALUES (%s,%s,%s,%s,%s,%s)",
                                 (a.workspace_id, rights_id, body.source_url, RIGHTS_STATEMENT, a.user_id, (request.headers.get("x-forwarded-for") or "").split(",")[-1].strip() or None))
            title = (prompt if body.source_type != "link" else body.source_url or "")[:80]
            row = conn.execute(
                """INSERT INTO projects (workspace_id,id,dashboard_type,title,prompt,language,target_seconds,status,estimate_credits,max_revisions,watermark,created_by,idempotency_key,
                                         source_type,source_url,rights_record_id,style_profile,characters,music,voice,consent_record_id)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,'moderating',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *""",
                (a.workspace_id, pid, body.dashboard_type, title, prompt, body.language, body.target_seconds, q["credits"], q["max_revisions"], q["watermark"], a.user_id, idempotency_key,
                 body.source_type, body.source_url, rights_id, body.style_profile, json.dumps([c.model_dump() for c in body.characters]), body.music, body.voice, body.consent_record_id)).fetchone()
            replayed = row is None
            if replayed:  # same key: return the project the first request created
                row = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND idempotency_key=%s", (a.workspace_id, idempotency_key)).fetchone()
                fingerprint = hashlib.sha256(json.dumps([row["prompt"], row["language"], row["target_seconds"]]).encode()).hexdigest()
                if fingerprint != hashlib.sha256(json.dumps([prompt, body.language, body.target_seconds]).encode()).hexdigest():
                    raise HTTPException(409, "Idempotency-Key was already used with a different request")
            else:
                conn.execute("INSERT INTO outbox (workspace_id,id,topic,event_type,payload) VALUES (%s,%s,'script.requested','script.requested',%s)",
                             (a.workspace_id, str(uuid.uuid4()), json.dumps({"project_id": pid})))
        if not replayed:
            await request.app.state.orch.start(a.workspace_id, str(row["id"]))
        return JSONResponse(summary(row), status_code=200 if replayed else 201)

    @app.get("/v1/projects")
    def list_projects(a: Actor = Depends(actor), limit: int = 50, dashboard: Literal["video", "animation"] = "video"):
        with deps.db() as conn:
            rows = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND dashboard_type=%s ORDER BY created_at DESC LIMIT %s",
                                (a.workspace_id, dashboard, max(1, min(limit, 100)))).fetchall()
        return {"projects": [summary(r) for r in rows]}

    @app.get("/v1/projects/{pid}")
    def get_project(pid: str, a: Actor = Depends(actor)):
        ws = a.workspace_id
        with deps.db() as conn:
            p = load(conn, ws, pid)
            script = conn.execute("SELECT version, title, status, research FROM scripts WHERE workspace_id=%s AND project_id=%s AND version=%s", (ws, pid, p["script_version"])).fetchone()
            scenes = conn.execute("""SELECT position, narration, visual_prompt, voice_status, visual_status, duration_ms, qc_score, generation
                                     FROM scenes WHERE workspace_id=%s AND project_id=%s AND script_version=%s ORDER BY position""", (ws, pid, p["script_version"])).fetchall()
            renders = conn.execute("SELECT version, duration_ms, qc_score, created_at FROM renders WHERE workspace_id=%s AND project_id=%s ORDER BY version DESC", (ws, pid)).fetchall()
            revisions = conn.execute("SELECT round_number, feedback, scene_ids, created_at FROM revisions WHERE workspace_id=%s AND project_id=%s ORDER BY round_number", (ws, pid)).fetchall()
            cost = conn.execute("SELECT COALESCE(sum(cost_microusd),0) AS c FROM jobs WHERE workspace_id=%s AND project_id=%s", (ws, pid)).fetchone()["c"]
            package = conn.execute("SELECT titles, description, tags, thumbnail_key IS NOT NULL AS has_thumbnail FROM publish_packages WHERE workspace_id=%s AND project_id=%s AND render_version=%s",
                                   (ws, pid, p["render_version"])).fetchone()
            localizations = conn.execute("SELECT language, status, error, credits FROM localizations WHERE workspace_id=%s AND project_id=%s ORDER BY language", (ws, pid)).fetchall()
            exports = conn.execute("SELECT format, status, error FROM exports WHERE workspace_id=%s AND project_id=%s AND render_version=%s ORDER BY format",
                                   (ws, pid, p["render_version"])).fetchall()
        steps = len(scenes) * 2
        done = sum((s["voice_status"] == "succeeded") + (s["visual_status"] == "succeeded") for s in scenes)
        remaining = steps - done
        return {**summary(p), "script": script, "scenes": scenes,
                "renders": [{**r, "created_at": str(r["created_at"])} for r in renders],
                "revisions": [{**r, "created_at": str(r["created_at"])} for r in revisions],
                "progress": {"percent": round(done / steps * 100) if steps else 0, "steps_done": done, "steps_total": steps,
                             "estimated_seconds_left": remaining * 2 if p["status"] == "generating" else 0, "provider_cost_microusd": int(cost)},
                "revisions_left": p["max_revisions"] - p["revision_round"], "package": package, "exports": exports, "localizations": localizations}

    async def signal(request: Request, a: Actor, pid: str, expect: str, name: str, data: dict):
        with deps.db() as conn:
            p = load(conn, a.workspace_id, pid)
        if p["status"] != expect:
            raise HTTPException(409, f"project is {p['status']}, expected {expect}")
        if not await request.app.state.orch.signal(a.workspace_id, pid, name, data):
            raise HTTPException(409, "this project's workflow is no longer running")
        return {"ok": True}

    @app.post("/v1/projects/{pid}/script/approve")
    async def approve(pid: str, body: Approve, request: Request, a: Actor = Depends(editor)):
        return await signal(request, a, pid, "awaiting_approval", "approve_script", {"user_id": a.user_id, "edits": [e.model_dump() for e in body.edits]})

    @app.post("/v1/projects/{pid}/script/regenerate")
    async def regenerate(pid: str, body: Regenerate, request: Request, a: Actor = Depends(editor)):
        return await signal(request, a, pid, "awaiting_approval", "regenerate_script", {"feedback": body.feedback})

    @app.post("/v1/projects/{pid}/review")
    async def review(pid: str, body: Review, request: Request, a: Actor = Depends(editor)):
        if body.action == "accept":
            return await signal(request, a, pid, "in_review", "accept", {"user_id": a.user_id})
        with deps.db() as conn:
            p = load(conn, a.workspace_id, pid)
        if not body.scene_positions:
            raise HTTPException(400, "choose at least one scene to regenerate")
        if p["revision_round"] >= p["max_revisions"]:
            raise HTTPException(403, f"all {p['max_revisions']} revision rounds for this video have been used")
        return await signal(request, a, pid, "in_review", "revise", {"user_id": a.user_id, "positions": body.scene_positions, "feedback": body.feedback})

    @app.post("/v1/projects/{pid}/cancel")
    async def cancel(pid: str, request: Request, a: Actor = Depends(editor)):
        return await signal(request, a, pid, "awaiting_approval", "cancel", {})

    def render_row(a: Actor, pid: str, version: int) -> dict:
        with deps.db() as conn:
            load(conn, a.workspace_id, pid)
            r = conn.execute("SELECT * FROM renders WHERE workspace_id=%s AND project_id=%s AND version=%s", (a.workspace_id, pid, version)).fetchone()
        if not r:
            raise HTTPException(404, "render not found")
        return r

    @app.get("/v1/projects/{pid}/renders/{version}/video")
    def video(pid: str, version: int, a: Actor = Depends(actor), download: int = 0):
        r = render_row(a, pid, version)
        return FileResponse(deps.storage.path(r["storage_key"]), media_type="video/mp4",
                            filename=f"xen-studio-{pid[:8]}-v{version}.mp4" if download else None)

    @app.get("/v1/projects/{pid}/renders/{version}/subtitles.{fmt}")
    def subs(pid: str, version: int, fmt: Literal["srt", "vtt"], a: Actor = Depends(actor)):
        r = render_row(a, pid, version)
        key = r["subtitles_key"] if fmt == "srt" else r["subtitles_key"][:-3] + "vtt"
        return FileResponse(deps.storage.path(key), media_type="text/vtt" if fmt == "vtt" else "application/x-subrip")

    @app.get("/v1/projects/{pid}/renders/{version}/provenance")
    def provenance(pid: str, version: int, a: Actor = Depends(actor)):
        return FileResponse(deps.storage.path(render_row(a, pid, version)["provenance_key"]), media_type="application/json")

    @app.get("/v1/projects/{pid}/renders/{version}/thumbnail")
    def thumbnail(pid: str, version: int, a: Actor = Depends(actor)):
        render_row(a, pid, version)
        with deps.db() as conn:
            row = conn.execute("SELECT thumbnail_key FROM publish_packages WHERE workspace_id=%s AND project_id=%s AND render_version=%s", (a.workspace_id, pid, version)).fetchone()
        if not row or not row["thumbnail_key"]:
            raise HTTPException(404, "thumbnail not found")
        return FileResponse(deps.storage.path(row["thumbnail_key"]), media_type="image/jpeg")

    @app.post("/v1/projects/{pid}/renders/{version}/exports", status_code=202)
    async def create_export(pid: str, version: int, body: ExportRequest, request: Request, a: Actor = Depends(editor)):
        render_row(a, pid, version)
        with deps.db() as conn:  # the primary key makes this idempotent: one export per render and format
            created = conn.execute("""INSERT INTO exports (workspace_id,project_id,render_version,format,status,requested_by) VALUES (%s,%s,%s,%s,'queued',%s)
                                      ON CONFLICT (workspace_id,project_id,render_version,format) DO UPDATE SET status='queued', error=NULL, updated_at=now()
                                        WHERE exports.status='failed' RETURNING format""", (a.workspace_id, pid, version, body.format, a.user_id)).fetchone()
        if created:
            await request.app.state.orch.run_task("export_render", a.workspace_id, pid, version, body.format)
        return {"format": body.format, "status": "queued" if created else "exists"}

    @app.get("/v1/projects/{pid}/renders/{version}/exports/{fmt}/video")
    def export_video(pid: str, version: int, fmt: Literal["9x16", "1x1"], a: Actor = Depends(actor)):
        render_row(a, pid, version)
        with deps.db() as conn:
            row = conn.execute("SELECT storage_key FROM exports WHERE workspace_id=%s AND project_id=%s AND render_version=%s AND format=%s AND status='succeeded'",
                               (a.workspace_id, pid, version, fmt.replace("x", ":"))).fetchone()
        if not row:
            raise HTTPException(404, "export not ready")
        return FileResponse(deps.storage.path(row["storage_key"]), media_type="video/mp4", filename=f"xen-studio-{pid[:8]}-v{version}-{fmt}.mp4")

    # ── animation: style profiles, consent records ───────────────────────────────
    @app.get("/v1/style-profiles")
    def style_profiles(a: Actor = Depends(actor)):
        with deps.db() as conn:
            rows = conn.execute("SELECT id, name, look, palette, workspace_id::text = '00000000-0000-0000-0000-000000000000' AS preset FROM style_profiles "
                                "WHERE workspace_id IN (%s, '00000000-0000-0000-0000-000000000000') ORDER BY preset DESC, name", (a.workspace_id,)).fetchall()
        return {"profiles": rows}

    @app.get("/v1/consents")
    def consents(a: Actor = Depends(actor)):
        with deps.db() as conn:
            rows = conn.execute("SELECT id, kind, subject_name, statement, revoked_at, created_at FROM consent_records WHERE workspace_id=%s ORDER BY created_at DESC", (a.workspace_id,)).fetchall()
        return {"consents": [{**r, "id": str(r["id"]), "revoked_at": str(r["revoked_at"]) if r["revoked_at"] else None, "created_at": str(r["created_at"])} for r in rows]}

    @app.post("/v1/consents", status_code=201)
    def add_consent(body: Consent, a: Actor = Depends(editor)):
        cid = str(uuid.uuid4())
        with deps.db() as conn:
            conn.execute("INSERT INTO consent_records (workspace_id,id,kind,subject_name,statement,granted_by) VALUES (%s,%s,%s,%s,%s,%s)",
                         (a.workspace_id, cid, body.kind, body.subject_name, body.statement, a.user_id))
            conn.execute("INSERT INTO audit_logs (workspace_id,id,actor_id,action,target,metadata) VALUES (%s,%s,%s,'consent.recorded',%s,%s)",
                         (a.workspace_id, str(uuid.uuid4()), a.user_id, cid, json.dumps({"kind": body.kind, "subject": body.subject_name})))
        return {"id": cid}

    @app.delete("/v1/consents/{cid}", status_code=204)
    def revoke_consent(cid: str, a: Actor = Depends(editor)):
        try:
            uuid.UUID(cid)
        except ValueError:
            raise HTTPException(404, "consent not found") from None
        with deps.db() as conn:
            conn.execute("UPDATE consent_records SET revoked_at=now(), updated_at=now() WHERE workspace_id=%s AND id=%s AND revoked_at IS NULL", (a.workspace_id, cid))
            conn.execute("INSERT INTO audit_logs (workspace_id,id,actor_id,action,target) VALUES (%s,%s,%s,'consent.revoked',%s)", (a.workspace_id, str(uuid.uuid4()), a.user_id, cid))

    # ── localization ───────────────────────────────────────────────────────────
    @app.get("/v1/glossary")
    def glossary(a: Actor = Depends(actor), language: str | None = None):
        with deps.db() as conn:
            rows = conn.execute("SELECT id, language, source, target, created_at FROM glossary_terms WHERE workspace_id=%s AND (%s::text IS NULL OR language=%s) ORDER BY language, lower(source)",
                                (a.workspace_id, language, language)).fetchall()
        return {"terms": [{**r, "id": str(r["id"]), "created_at": str(r["created_at"])} for r in rows]}

    @app.post("/v1/glossary", status_code=201)
    def add_term(body: GlossaryTerm, a: Actor = Depends(editor)):
        if body.language not in LANGUAGES:
            raise HTTPException(400, f"language must be one of {', '.join(LANGUAGES)}")
        tid = str(uuid.uuid4())
        with deps.db() as conn:
            row = conn.execute("""INSERT INTO glossary_terms (workspace_id,id,language,source,target,created_by) VALUES (%s,%s,%s,%s,%s,%s)
                                  ON CONFLICT (workspace_id, language, lower(source)) DO UPDATE SET target=excluded.target, updated_at=now() RETURNING id""",
                               (a.workspace_id, tid, body.language, body.source.strip(), body.target.strip(), a.user_id)).fetchone()
        return {"id": str(row["id"]), **body.model_dump()}

    @app.delete("/v1/glossary/{tid}", status_code=204)
    def delete_term(tid: str, a: Actor = Depends(editor)):
        try:
            uuid.UUID(tid)
        except ValueError:
            raise HTTPException(404, "term not found") from None
        with deps.db() as conn:
            conn.execute("DELETE FROM glossary_terms WHERE workspace_id=%s AND id=%s", (a.workspace_id, tid))

    @app.post("/v1/projects/{pid}/localizations", status_code=202)
    async def create_localization(pid: str, body: LocalizeRequest, request: Request, a: Actor = Depends(editor)):
        with deps.db() as conn:
            p = load(conn, a.workspace_id, pid)
            if p["status"] not in ("in_review", "completed") or not p["render_version"]:
                raise HTTPException(409, "localize a video after it has rendered")
            if body.language == p["language"] or body.language not in LANGUAGES:
                raise HTTPException(400, "choose a supported language different from the original")
            plan = plan_of(conn, a.workspace_id)
            used = conn.execute("SELECT count(*) AS n FROM localizations WHERE workspace_id=%s AND project_id=%s", (a.workspace_id, pid)).fetchone()["n"]
            if plan["max_languages"] is not None and used + 1 >= plan["max_languages"]:
                raise HTTPException(403, f"your plan allows {plan['max_languages']} languages per video")
            created = conn.execute("""INSERT INTO localizations (workspace_id,project_id,language,render_version,status,requested_by) VALUES (%s,%s,%s,%s,'translating',%s)
                                      ON CONFLICT (workspace_id,project_id,language) DO UPDATE SET status='translating', render_version=excluded.render_version, error=NULL, updated_at=now()
                                        WHERE localizations.status='failed' RETURNING language""", (a.workspace_id, pid, body.language, p["render_version"], a.user_id)).fetchone()
        if created:
            await request.app.state.orch.run_task("localize", a.workspace_id, pid, body.language)
        return {"language": body.language, "status": "translating" if created else "exists"}

    @app.get("/v1/projects/{pid}/localizations/{lang}")
    def get_localization(pid: str, lang: str, a: Actor = Depends(actor)):
        with deps.db() as conn:
            p = load(conn, a.workspace_id, pid)
            loc = conn.execute("SELECT language, status, source_lines, lines, provider, credits, error, render_version, updated_at FROM localizations WHERE workspace_id=%s AND project_id=%s AND language=%s",
                               (a.workspace_id, pid, lang)).fetchone()
            glossary = conn.execute("SELECT source, target FROM glossary_terms WHERE workspace_id=%s AND language=%s ORDER BY lower(source)", (a.workspace_id, lang)).fetchall()
        if not loc:
            raise HTTPException(404, "localization not found")
        estimate = activities.estimate_credits(p["target_seconds"], cfg.credits_per_minute)
        return {**loc, "updated_at": str(loc["updated_at"]), "project_title": p["title"], "source_language": p["language"],
                "glossary": glossary, "estimate_credits": max(1, estimate // 2)}

    @app.post("/v1/projects/{pid}/localizations/{lang}/approve", status_code=202)
    async def approve_localization(pid: str, lang: str, body: ApproveLocalization, request: Request, a: Actor = Depends(editor)):
        ws = a.workspace_id
        with deps.db() as conn:
            p = load(conn, ws, pid)
            loc = conn.execute("SELECT * FROM localizations WHERE workspace_id=%s AND project_id=%s AND language=%s FOR UPDATE", (ws, pid, lang)).fetchone()
            if not loc:
                raise HTTPException(404, "localization not found")
            if loc["status"] != "in_review":
                raise HTTPException(409, f"localization is {loc['status']}, expected in_review")
            if len(body.lines) != len(loc["lines"]):
                raise HTTPException(400, f"expected {len(loc['lines'])} lines")
            lines = [x.strip()[:2000] for x in body.lines]
            if any(not x for x in lines):
                raise HTTPException(400, "every line needs text")
            mod, _ = deps.router.call("moderation", "check", text=" ".join(lines))
            if mod["decision"] == "blocked":
                raise HTTPException(400, f"edited lines violate the content policy ({mod['reason']})")
            conn.execute("UPDATE localizations SET lines=%s, reviewed_by=%s, status='rendering', updated_at=now() WHERE workspace_id=%s AND project_id=%s AND language=%s",
                         (json.dumps(lines), a.user_id, ws, pid, lang))
        amount = max(1, activities.estimate_credits(p["target_seconds"], cfg.credits_per_minute) // 2)
        if not await asyncio.to_thread(activities.reserve_localization, ws, pid, lang, amount):
            with deps.db() as conn:
                conn.execute("UPDATE localizations SET status='in_review', updated_at=now() WHERE workspace_id=%s AND project_id=%s AND language=%s", (ws, pid, lang))
            raise HTTPException(402, f"dubbing needs {amount} credits")
        await request.app.state.orch.run_task("render_localization", ws, pid, lang)
        return {"language": lang, "status": "rendering", "credits": amount}

    @app.get("/v1/review-queue")
    def review_queue(a: Actor = Depends(actor)):
        with deps.db() as conn:
            rows = conn.execute("""SELECT l.project_id, l.language, l.updated_at, p.title FROM localizations l
                                   JOIN projects p ON p.workspace_id = l.workspace_id AND p.id = l.project_id
                                   WHERE l.workspace_id=%s AND l.status='in_review' ORDER BY l.updated_at""", (a.workspace_id,)).fetchall()
        return {"items": [{**r, "project_id": str(r["project_id"]), "updated_at": str(r["updated_at"])} for r in rows]}

    @app.get("/v1/projects/{pid}/localizations/{lang}/{file}")
    def localization_file(pid: str, lang: str, file: Literal["video.mp4", "subtitles.srt", "subtitles.vtt"], a: Actor = Depends(actor)):
        with deps.db() as conn:
            load(conn, a.workspace_id, pid)
            loc = conn.execute("SELECT storage_key, subtitles_key FROM localizations WHERE workspace_id=%s AND project_id=%s AND language=%s AND status='ready'",
                               (a.workspace_id, pid, lang)).fetchone()
        if not loc:
            raise HTTPException(404, "localized version not ready")
        key = loc["storage_key"] if file == "video.mp4" else loc["subtitles_key"] if file == "subtitles.srt" else loc["subtitles_key"][:-3] + "vtt"
        return FileResponse(deps.storage.path(key), media_type={"video.mp4": "video/mp4", "subtitles.srt": "application/x-subrip", "subtitles.vtt": "text/vtt"}[file])

    # ── notifications (in-app feed; scoped to the caller inside the current workspace) ──
    @app.get("/v1/notifications")
    def notifications(a: Actor = Depends(actor), limit: int = 30):
        with deps.db() as conn:
            rows = conn.execute("SELECT id, kind, project_id, title, link, read_at, created_at FROM notifications WHERE workspace_id=%s AND user_id=%s ORDER BY created_at DESC LIMIT %s",
                                (a.workspace_id, a.user_id, max(1, min(limit, 100)))).fetchall()
            unread = conn.execute("SELECT count(*) AS n FROM notifications WHERE workspace_id=%s AND user_id=%s AND read_at IS NULL", (a.workspace_id, a.user_id)).fetchone()["n"]
        return {"unread": unread, "notifications": [{**r, "id": str(r["id"]), "project_id": str(r["project_id"]) if r["project_id"] else None,
                                                      "read": r["read_at"] is not None, "read_at": None, "created_at": str(r["created_at"])} for r in rows]}

    @app.post("/v1/notifications/read")
    def mark_read(body: MarkRead, a: Actor = Depends(actor)):
        with deps.db() as conn:
            if body.ids:
                try:
                    ids = [str(uuid.UUID(i)) for i in body.ids]
                except ValueError:
                    raise HTTPException(400, "ids must be UUIDs") from None
                conn.execute("UPDATE notifications SET read_at=now(), updated_at=now() WHERE workspace_id=%s AND user_id=%s AND read_at IS NULL AND id = ANY(%s::uuid[])", (a.workspace_id, a.user_id, ids))
            else:
                conn.execute("UPDATE notifications SET read_at=now(), updated_at=now() WHERE workspace_id=%s AND user_id=%s AND read_at IS NULL", (a.workspace_id, a.user_id))
        return {"ok": True}

    from . import admin
    app.include_router(admin.build(deps, actor))
    from . import xr
    app.include_router(xr.build(deps, actor, editor, plan_of))

    return app
