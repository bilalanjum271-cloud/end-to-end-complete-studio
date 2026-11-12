"""Project API for the Script-to-Video Studio. Sits behind the gateway, which has already
verified the access token and injected X-Workspace-Id / X-User-Id / X-Role / X-Plan.

Every query is scoped by workspace_id. Every write requires an Idempotency-Key.
"""
from __future__ import annotations

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


class CreateProject(BaseModel):
    prompt: str = Field(min_length=10, max_length=4000)
    language: str = Field(default="en", pattern="^[a-z]{2}$")
    target_seconds: int = Field(ge=10, le=3600)


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
                 "render_version", "revision_round", "max_revisions", "watermark", "created_at", "updated_at")}

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
        with deps.db() as conn:
            q = quote(conn, a.workspace_id, body.target_seconds)
            if not q["within_plan"]:
                raise HTTPException(403, f"your plan allows videos up to {q['max_video_seconds'] // 60} minutes")
            pid = str(uuid.uuid4())
            title = body.prompt.strip()[:80]
            row = conn.execute(
                """INSERT INTO projects (workspace_id,id,dashboard_type,title,prompt,language,target_seconds,status,estimate_credits,max_revisions,watermark,created_by,idempotency_key)
                   VALUES (%s,%s,'video',%s,%s,%s,%s,'moderating',%s,%s,%s,%s,%s)
                   ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *""",
                (a.workspace_id, pid, title, body.prompt.strip(), body.language, body.target_seconds, q["credits"], q["max_revisions"], q["watermark"], a.user_id, idempotency_key)).fetchone()
            replayed = row is None
            if replayed:  # same key: return the project the first request created
                row = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND idempotency_key=%s", (a.workspace_id, idempotency_key)).fetchone()
                fingerprint = hashlib.sha256(json.dumps([row["prompt"], row["language"], row["target_seconds"]]).encode()).hexdigest()
                if fingerprint != hashlib.sha256(json.dumps([body.prompt.strip(), body.language, body.target_seconds]).encode()).hexdigest():
                    raise HTTPException(409, "Idempotency-Key was already used with a different request")
            else:
                conn.execute("INSERT INTO outbox (workspace_id,id,topic,event_type,payload) VALUES (%s,%s,'script.requested','script.requested',%s)",
                             (a.workspace_id, str(uuid.uuid4()), json.dumps({"project_id": pid})))
        if not replayed:
            await request.app.state.orch.start(a.workspace_id, str(row["id"]))
        return JSONResponse(summary(row), status_code=200 if replayed else 201)

    @app.get("/v1/projects")
    def list_projects(a: Actor = Depends(actor), limit: int = 50):
        with deps.db() as conn:
            rows = conn.execute("SELECT * FROM projects WHERE workspace_id=%s AND dashboard_type='video' ORDER BY created_at DESC LIMIT %s",
                                (a.workspace_id, max(1, min(limit, 100)))).fetchall()
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
                "revisions_left": p["max_revisions"] - p["revision_round"], "package": package, "exports": exports}

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

    return app
