"""XR studios API: shared 3D assets, scenes for AR / VR / MR-XR, and device export."""
from __future__ import annotations

import json
import os
import tempfile
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..xr.scene import Scene, export_scene


class NewAsset(BaseModel):
    prompt: str = Field(min_length=3, max_length=600)


class NewScene(BaseModel):
    kind: Literal["ar", "vr", "xr"]
    name: str = Field(min_length=1, max_length=80)


class SaveScene(BaseModel):
    scene: Scene
    version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=80)


def build(deps, actor, editor, plan_of) -> APIRouter:
    r = APIRouter(prefix="/v1/xr")

    def gate(conn, ws: str) -> str:
        access = plan_of(conn, ws)["xr_access"]
        if access == "none":
            raise HTTPException(403, "your plan does not include the XR studios")
        return access

    def asset_row(x: dict) -> dict:
        return {k: (str(v) if k in ("id", "created_at", "updated_at") else v) for k, v in x.items()
                if k in ("id", "prompt", "status", "provider", "triangles", "bounds", "credits", "error", "created_at", "updated_at")}

    @r.post("/assets", status_code=202)
    async def create_asset(body: NewAsset, request: Request, a=Depends(editor), idempotency_key: str = Header(default="")):
        if not idempotency_key or len(idempotency_key) > 200:
            raise HTTPException(400, "Idempotency-Key header is required")
        aid = str(uuid.uuid4())
        with deps.db() as conn:
            gate(conn, a.workspace_id)
            row = conn.execute("""INSERT INTO xr_assets (workspace_id,id,prompt,status,created_by,idempotency_key) VALUES (%s,%s,%s,'queued',%s,%s)
                                  ON CONFLICT (workspace_id, idempotency_key) DO NOTHING RETURNING *""", (a.workspace_id, aid, body.prompt.strip(), a.user_id, idempotency_key)).fetchone()
            replayed = row is None
            if replayed:
                row = conn.execute("SELECT * FROM xr_assets WHERE workspace_id=%s AND idempotency_key=%s", (a.workspace_id, idempotency_key)).fetchone()
        if not replayed:  # GPU work is queued, never synchronous
            await request.app.state.orch.run_task("generate_xr_asset", a.workspace_id, aid)
        return asset_row(row)

    @r.get("/assets")
    def list_assets(a=Depends(actor), limit: int = 100):
        with deps.db() as conn:
            rows = conn.execute("SELECT * FROM xr_assets WHERE workspace_id=%s ORDER BY created_at DESC LIMIT %s", (a.workspace_id, max(1, min(limit, 200)))).fetchall()
        return {"assets": [asset_row(x) for x in rows]}

    @r.get("/assets/{aid}/model.glb")
    def asset_file(aid: str, a=Depends(actor)):
        with deps.db() as conn:
            row = conn.execute("SELECT storage_key FROM xr_assets WHERE workspace_id=%s AND id::text=%s AND status='ready'", (a.workspace_id, aid)).fetchone()
        if not row:
            raise HTTPException(404, "asset not ready")
        return FileResponse(deps.storage.path(row["storage_key"]), media_type="model/gltf-binary", headers={"Cache-Control": "private, max-age=86400, immutable"})

    def scene_row(x: dict) -> dict:
        return {**{k: x[k] for k in ("kind", "name", "scene", "version")}, "id": str(x["id"]), "updated_at": str(x["updated_at"])}

    @r.post("/scenes", status_code=201)
    def create_scene(body: NewScene, a=Depends(editor)):
        sid = str(uuid.uuid4())
        with deps.db() as conn:
            gate(conn, a.workspace_id)
            row = conn.execute("INSERT INTO xr_scenes (workspace_id,id,kind,name,created_by) VALUES (%s,%s,%s,%s,%s) RETURNING *", (a.workspace_id, sid, body.kind, body.name, a.user_id)).fetchone()
        return scene_row(row)

    @r.get("/scenes")
    def list_scenes(a=Depends(actor), kind: Literal["ar", "vr", "xr"] | None = None):
        with deps.db() as conn:
            rows = conn.execute("SELECT * FROM xr_scenes WHERE workspace_id=%s AND (%s::text IS NULL OR kind=%s) ORDER BY updated_at DESC", (a.workspace_id, kind, kind)).fetchall()
        return {"scenes": [scene_row(x) for x in rows]}

    def load_scene(conn, ws: str, sid: str) -> dict:
        try:
            uuid.UUID(sid)
        except ValueError:
            raise HTTPException(404, "scene not found") from None
        row = conn.execute("SELECT * FROM xr_scenes WHERE workspace_id=%s AND id=%s", (ws, sid)).fetchone()
        if not row:
            raise HTTPException(404, "scene not found")
        return row

    @r.get("/scenes/{sid}")
    def get_scene(sid: str, a=Depends(actor)):
        with deps.db() as conn:
            return scene_row(load_scene(conn, a.workspace_id, sid))

    @r.put("/scenes/{sid}")
    def save_scene(sid: str, body: SaveScene, a=Depends(editor)):
        """Autosave target. `version` must match the stored version (optimistic concurrency): a stale tab gets 409, not a silent overwrite."""
        ids = {n.asset_id for n in body.scene.nodes}
        with deps.db() as conn:
            load_scene(conn, a.workspace_id, sid)
            if ids:
                ready = {str(x["id"]) for x in conn.execute("SELECT id FROM xr_assets WHERE workspace_id=%s AND status='ready' AND id::text = ANY(%s)", (a.workspace_id, list(ids))).fetchall()}
                if ready != ids:
                    raise HTTPException(400, "the scene references assets that are not ready or not in this workspace")
            row = conn.execute("""UPDATE xr_scenes SET scene=%s, name=COALESCE(%s, name), version=version+1, updated_at=now()
                                  WHERE workspace_id=%s AND id=%s AND version=%s RETURNING *""",
                               (json.dumps(body.scene.model_dump()), body.name, a.workspace_id, sid, body.version)).fetchone()
        if not row:
            raise HTTPException(409, "this scene was changed elsewhere; reload to get the latest version")
        return scene_row(row)

    @r.get("/scenes/{sid}/export.glb")
    def export(sid: str, a=Depends(actor)):
        with deps.db() as conn:
            if gate(conn, a.workspace_id) != "full":
                raise HTTPException(403, "device export is part of the Studio plan")
            row = load_scene(conn, a.workspace_id, sid)
            scene = Scene.model_validate(row["scene"])
            ids = list({n.asset_id for n in scene.nodes})
            paths = {str(x["id"]): str(deps.storage.path(x["storage_key"])) for x in conn.execute(
                "SELECT id, storage_key FROM xr_assets WHERE workspace_id=%s AND status='ready' AND id::text = ANY(%s)", (a.workspace_id, ids)).fetchall()}
        if len(paths) != len(ids):
            raise HTTPException(409, "some assets in this scene are no longer available")
        out = os.path.join(tempfile.mkdtemp(prefix="xen-export-"), "scene.glb")
        export_scene(scene, paths, out)
        return FileResponse(out, media_type="model/gltf-binary", filename=f"{row['name'][:40] or 'scene'}.glb")

    return r
