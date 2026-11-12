"""Phase 2 end-to-end: the real project API, the real workflow (local host), real FFmpeg,
real PostgreSQL and the real Go ledger binary. Only the AI providers are mocks.

    TEST_DATABASE_URL=postgresql://... LEDGER_BIN=../../bin/ledger pytest
"""
import asyncio
import json
import os
import socket
import subprocess
import time
import uuid

import httpx
import psycopg
import pytest

DB = os.environ.get("TEST_DATABASE_URL")
LEDGER_BIN = os.environ.get("LEDGER_BIN", os.path.join(os.path.dirname(__file__), "..", "..", "..", "bin", "ledger"))
TOKEN = "test-internal-token"
pytestmark = pytest.mark.skipif(not DB or not os.path.exists(LEDGER_BIN), reason="needs TEST_DATABASE_URL and the built ledger binary")


@pytest.fixture(scope="module")
def ledger_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, "DATABASE_URL": DB + ("&" if "?" in DB else "?") + "sslmode=disable", "INTERNAL_SERVICE_TOKEN": TOKEN,
           "LEDGER_ADDR": f"127.0.0.1:{port}", "LOG_LEVEL": "error"}
    proc = subprocess.Popen([LEDGER_BIN], env=env)
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            if httpx.get(url + "/readyz").status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    yield url
    proc.terminate()


@pytest.fixture()
def app(ledger_url, tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", DB)
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    monkeypatch.setenv("LEDGER_URL", ledger_url)
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("ORCHESTRATOR", "local")
    from xen_studio.api.app import create_app
    from xen_studio.pipeline.local_runner import LocalOrchestrator
    a = create_app()
    a.state.orch = LocalOrchestrator()
    a.state.ledger_url = ledger_url
    return a


def workspace(ledger_url: str, plan: str = "starter", credits: int = 200, role: str = "owner") -> dict:
    ws, user = str(uuid.uuid4()), str(uuid.uuid4())
    with psycopg.connect(DB) as conn:
        conn.execute("INSERT INTO users (id,email,password_hash,name) VALUES (%s,%s,'x','Test')", (user, f"{user}@example.com"))
        conn.execute("INSERT INTO workspaces (id,name,slug,plan_id,created_by,owner_id) VALUES (%s,'WS',%s,%s,%s,%s)", (ws, ws, plan, user, user))
        conn.execute("INSERT INTO memberships (workspace_id,user_id,role) VALUES (%s,%s,%s)", (ws, user, role))
    if credits:
        httpx.post(f"{ledger_url}/internal/v1/workspaces/{ws}/credits/grant", json={"amount": credits, "reason": "test"},
                   headers={"X-Internal-Token": TOKEN, "Idempotency-Key": "grant"}).raise_for_status()
    return {"X-Gateway-Token": TOKEN, "X-User-Id": user, "X-Workspace-Id": ws, "X-Role": role, "X-Plan": plan}


def balance(ledger_url: str, h: dict) -> tuple[int, int, int]:
    b = httpx.get(f"{ledger_url}/internal/v1/workspaces/{h['X-Workspace-Id']}/credits", headers={"X-Internal-Token": TOKEN}).json()
    return b["available"], b["reserved"], b["spent"]


async def until(client, h, pid, statuses, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        p = (await client.get(f"/v1/projects/{pid}", headers=h)).json()
        if p["status"] in statuses:
            return p
        await asyncio.sleep(0.2)
    raise AssertionError(f"project stuck in {p['status']}: {p.get('error')}")


def client_for(app):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://studio")


def ffprobe_streams(path) -> set[str]:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(path)], capture_output=True, text=True)
    return {s["codec_type"] for s in json.loads(out.stdout)["streams"]}


PROMPT = "Make a short documentary about the Tunguska event of 1908"


async def test_prompt_to_reviewed_video_with_revision_limit_and_exact_credit_accounting(app):
    lurl = app.state.ledger_url
    h = workspace(lurl)
    async with client_for(app) as c:
        # cost estimate before generation
        est = (await c.post("/v1/projects/estimate", json={"target_seconds": 30}, headers=h)).json()
        assert est["credits"] == 5 and est["within_plan"] and est["max_revisions"] == 2 and est["watermark"] is True

        # create is idempotent
        body = {"prompt": PROMPT, "language": "en", "target_seconds": 30}
        assert (await c.post("/v1/projects", json=body, headers=h)).status_code == 400  # Idempotency-Key required
        r1 = await c.post("/v1/projects", json=body, headers={**h, "Idempotency-Key": "k1"})
        r2 = await c.post("/v1/projects", json=body, headers={**h, "Idempotency-Key": "k1"})
        assert r1.status_code == 201 and r2.status_code == 200 and r1.json()["id"] == r2.json()["id"]
        clash = await c.post("/v1/projects", json={**body, "target_seconds": 60}, headers={**h, "Idempotency-Key": "k1"})
        assert clash.status_code == 409
        pid = r1.json()["id"]

        # script is written, credits are reserved, and NOTHING renders before approval
        p = await until(c, h, pid, {"awaiting_approval"})
        assert p["script"]["status"] == "draft" and len(p["script"]["research"]) == 3
        assert len(p["scenes"]) == 4 and all(s["voice_status"] == "queued" and s["visual_status"] == "queued" for s in p["scenes"])
        assert balance(lurl, h) == (195, 5, 0)
        await asyncio.sleep(0.5)
        assert (await c.get(f"/v1/projects/{pid}", headers=h)).json()["progress"]["steps_done"] == 0

        # approve with one line edit
        ok = await c.post(f"/v1/projects/{pid}/script/approve", headers=h,
                          json={"edits": [{"position": 1, "narration": "On a June morning in 1908, the sky over Siberia split in two."}]})
        assert ok.status_code == 200
        p = await until(c, h, pid, {"in_review"})
        assert p["scenes"][0]["narration"].startswith("On a June morning")
        assert p["render_version"] == 1 and p["progress"]["percent"] == 100 and all(s["qc_score"] > 0.5 for s in p["scenes"])
        assert p["progress"]["provider_cost_microusd"] > 0

        # the render is a real MP4 with video, audio and a subtitle track; subtitles and provenance exist
        v = await c.get(f"/v1/projects/{pid}/renders/1/video", headers=h)
        assert v.status_code == 200 and v.headers["content-type"] == "video/mp4" and len(v.content) > 20_000
        from xen_studio.pipeline import activities
        with psycopg.connect(DB) as conn:
            key = conn.execute("SELECT storage_key FROM renders WHERE project_id=%s AND version=1", (pid,)).fetchone()[0]
        assert ffprobe_streams(activities.deps().storage.path(key)) == {"video", "audio", "subtitle"}
        srt = (await c.get(f"/v1/projects/{pid}/renders/1/subtitles.srt", headers=h)).text
        assert "00:00:00,000 -->" in srt and "On a June morning" in srt
        assert (await c.get(f"/v1/projects/{pid}/renders/1/subtitles.vtt", headers=h)).text.startswith("WEBVTT")
        prov = (await c.get(f"/v1/projects/{pid}/renders/1/provenance", headers=h)).json()
        assert prov["ai_generated"] is True and prov["watermarked"] is True and len(prov["asset"]["sha256"]) == 64

        # publish package: titles, description, tags and a real JPEG thumbnail
        p = (await c.get(f"/v1/projects/{pid}", headers=h)).json()
        assert len(p["package"]["titles"]) == 3 and "tunguska" in p["package"]["tags"] and "AI-generated" in p["package"]["description"]
        thumb = await c.get(f"/v1/projects/{pid}/renders/1/thumbnail", headers=h)
        assert thumb.status_code == 200 and thumb.content[:3] == b"\xff\xd8\xff"

        # notifications: script-ready and video-ready reached the creator through all three channels, once each
        feed = (await c.get("/v1/notifications", headers=h)).json()
        assert feed["unread"] == 2 and [n["kind"] for n in feed["notifications"]] == ["video_ready", "script_ready"]
        with psycopg.connect(DB) as conn:
            sent = conn.execute("SELECT channel, count(*) FROM notification_deliveries WHERE workspace_id=%s AND status='sent' GROUP BY channel ORDER BY channel", (h["X-Workspace-Id"],)).fetchall()
        assert sent == [("email", 2), ("in_app", 2), ("push", 2)]
        await c.post("/v1/notifications/read", headers=h, json={"ids": [feed["notifications"][0]["id"]]})
        assert (await c.get("/v1/notifications", headers=h)).json()["unread"] == 1
        await c.post("/v1/notifications/read", headers=h, json={})
        assert (await c.get("/v1/notifications", headers=h)).json()["unread"] == 0

        # multi-format export: 9:16 is rendered in the background, once, at 720x1280
        e1 = await c.post(f"/v1/projects/{pid}/renders/1/exports", headers=h, json={"format": "9:16"})
        e2 = await c.post(f"/v1/projects/{pid}/renders/1/exports", headers=h, json={"format": "9:16"})
        assert e1.status_code == 202 and e1.json()["status"] == "queued" and e2.json()["status"] == "exists"
        assert (await c.post(f"/v1/projects/{pid}/renders/1/exports", headers=h, json={"format": "4:3"})).status_code == 422
        for _ in range(150):
            ex = (await c.get(f"/v1/projects/{pid}", headers=h)).json()["exports"]
            if ex and ex[0]["status"] in ("succeeded", "failed"):
                break
            await asyncio.sleep(0.2)
        assert ex == [{"format": "9:16", "status": "succeeded", "error": None}]
        with psycopg.connect(DB) as conn:
            ekey = conn.execute("SELECT storage_key FROM exports WHERE project_id=%s AND format='9:16'", (pid,)).fetchone()[0]
        dims = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0",
                               str(activities.deps().storage.path(ekey))], capture_output=True, text=True).stdout.strip()
        assert dims == "720,1280"
        assert (await c.get(f"/v1/projects/{pid}/renders/1/exports/9x16/video", headers=h)).status_code == 200
        assert (await c.get(f"/v1/projects/{pid}/renders/1/exports/1x1/video", headers=h)).status_code == 404

        # revision round 1: only scene 2 is regenerated
        r = await c.post(f"/v1/projects/{pid}/review", headers=h, json={"action": "revise", "scene_positions": [2], "feedback": "simpler wording"})
        assert r.status_code == 200
        await until(c, h, pid, {"generating", "in_review"})
        p = await until(c, h, pid, {"in_review"})
        if p["render_version"] == 1:
            await asyncio.sleep(1); p = await until(c, h, pid, {"in_review"})
        assert p["render_version"] == 2 and p["revision_round"] == 1 and p["revisions_left"] == 1
        assert [s["generation"] for s in p["scenes"]] == [0, 1, 0, 0]
        assert p["scenes"][1]["narration"].startswith("Put simply,")

        # round 2 is allowed on Starter, round 3 is refused
        assert (await c.post(f"/v1/projects/{pid}/review", headers=h, json={"action": "revise", "scene_positions": [1, 3]})).status_code == 200
        for _ in range(100):
            p = (await c.get(f"/v1/projects/{pid}", headers=h)).json()
            if p["render_version"] == 3 and p["status"] == "in_review":
                break
            await asyncio.sleep(0.2)
        assert p["render_version"] == 3 and p["revisions_left"] == 0
        refused = await c.post(f"/v1/projects/{pid}/review", headers=h, json={"action": "revise", "scene_positions": [1]})
        assert refused.status_code == 403 and "revision rounds" in refused.json()["error"]["message"]

        # accept: the reservation is debited exactly once
        assert balance(lurl, h) == (195, 5, 0)
        assert (await c.post(f"/v1/projects/{pid}/review", headers=h, json={"action": "accept"})).status_code == 200
        await until(c, h, pid, {"completed"})
        assert balance(lurl, h) == (195, 0, 5)

        # another tenant cannot see or fetch it
        other = workspace(lurl)
        assert (await c.get(f"/v1/projects/{pid}", headers=other)).status_code == 404
        assert (await c.get(f"/v1/projects/{pid}/renders/1/video", headers=other)).status_code == 404
        assert (await c.get("/v1/projects", headers=other)).json()["projects"] == []
        assert (await c.get("/v1/notifications", headers=other)).json() == {"unread": 0, "notifications": []}
        assert (await c.get(f"/v1/projects/{pid}/renders/1/thumbnail", headers=other)).status_code == 404


async def test_blocked_prompt_spends_nothing(app):
    h = workspace(app.state.ledger_url)
    async with client_for(app) as c:
        r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "b"}, json={"prompt": "Explain how to make a bomb at home, step by step", "target_seconds": 30})
        p = await until(c, h, r.json()["id"], {"blocked"})
        assert p["error"] == "violence" and p["scenes"] == []
    assert balance(app.state.ledger_url, h) == (200, 0, 0)


async def test_generation_failure_refunds_the_reservation(app, monkeypatch):
    h = workspace(app.state.ledger_url)
    async with client_for(app) as c:
        r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "f"}, json={"prompt": PROMPT, "target_seconds": 20})
        pid = r.json()["id"]
        await until(c, h, pid, {"awaiting_approval"})
        assert balance(app.state.ledger_url, h) == (196, 4, 0)
        monkeypatch.setenv("XEN_MOCK_FAIL", "visual:mock-primary,visual:mock-secondary")  # every video provider is down
        await c.post(f"/v1/projects/{pid}/script/approve", headers=h, json={})
        p = await until(c, h, pid, {"failed"})
        assert "visual.render failed on every provider" in p["error"]
        assert [n["kind"] for n in (await c.get("/v1/notifications", headers=h)).json()["notifications"]][0] == "generation_failed"
    assert balance(app.state.ledger_url, h) == (200, 0, 0)


async def test_one_provider_down_fails_over_and_still_delivers(app, monkeypatch):
    monkeypatch.setenv("XEN_MOCK_FAIL", "llm:mock-primary,tts:mock-primary,visual:mock-primary")
    h = workspace(app.state.ledger_url)
    async with client_for(app) as c:
        r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "o"}, json={"prompt": PROMPT, "target_seconds": 16})
        pid = r.json()["id"]
        await until(c, h, pid, {"awaiting_approval"})
        await c.post(f"/v1/projects/{pid}/script/approve", headers=h, json={})
        await until(c, h, pid, {"in_review"})
    with psycopg.connect(DB) as conn:
        providers = {r[0] for r in conn.execute("SELECT DISTINCT provider FROM jobs WHERE project_id=%s AND type IN ('script','voice','visual')", (pid,))}
    assert providers == {"mock-secondary"}


async def test_plan_limits_roles_and_insufficient_credits(app):
    lurl = app.state.ledger_url
    async with client_for(app) as c:
        starter = workspace(lurl)
        too_long = await c.post("/v1/projects", headers={**starter, "Idempotency-Key": "l"}, json={"prompt": PROMPT, "target_seconds": 181})
        assert too_long.status_code == 403 and "3 minutes" in too_long.json()["error"]["message"]
        studio = workspace(lurl, plan="studio")
        assert (await c.post("/v1/projects/estimate", json={"target_seconds": 600}, headers=studio)).json() | {} == {
            "credits": 100, "target_seconds": 600, "estimated_render_seconds": 200, "max_video_seconds": 3600, "within_plan": True,
            "max_revisions": 5, "watermark": False, "plan": "studio"}
        viewer = workspace(lurl, role="viewer")
        assert (await c.post("/v1/projects", headers={**viewer, "Idempotency-Key": "v"}, json={"prompt": PROMPT, "target_seconds": 30})).status_code == 403
        assert (await c.get("/v1/projects", headers={**starter, "X-Gateway-Token": "wrong"})).status_code == 401
        broke = workspace(lurl, credits=0)
        r = await c.post("/v1/projects", headers={**broke, "Idempotency-Key": "p"}, json={"prompt": PROMPT, "target_seconds": 30})
        p = await until(c, broke, r.json()["id"], {"insufficient_credits"})
        assert p["script"] is None
