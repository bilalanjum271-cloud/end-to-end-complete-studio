"""Animation Studio end to end: own text -> styled animation with consistent characters and a ducked
music bed; link ingestion with a rights record; catalog links held for human rights review and
resumed or stopped by staff; cloned voices require consent."""
import asyncio
import subprocess

import psycopg
from test_admin import make_staff
from test_pipeline import DB, app, client_for, ledger_url, until, workspace  # noqa: F401  # noqa: F401

STORY = ("Mira was a lighthouse keeper on a quiet island. Every night she lit the lamp and watched the sea. "
         "One stormy night a small whale lost its way near the rocks. Mira swung the beam towards open water. "
         "The whale followed the light and found its mother at dawn. Mira smiled and wrote it in her log.")


def loudness_profile(path) -> list[float]:
    out = subprocess.run(["ffmpeg", "-i", str(path), "-map", "0:a", "-af", "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    return [float(x.split("=")[1]) for x in out.splitlines() if "RMS_level=" in x and "inf" not in x]


async def test_text_to_styled_animation_with_characters_and_music(app):  # noqa: F811
    h = workspace(app.state.ledger_url, plan="pro", credits=1000)
    async with client_for(app) as c:
        styles = (await c.get("/v1/style-profiles", headers=h)).json()["profiles"]
        assert {"flat", "paper", "watercolor", "noir"} <= {p["id"] for p in styles}
        assert (await c.post("/v1/projects", headers={**h, "Idempotency-Key": "x"}, json={"dashboard_type": "animation", "source_type": "prompt", "prompt": STORY, "target_seconds": 30})).status_code == 400
        assert (await c.post("/v1/projects", headers={**h, "Idempotency-Key": "y"}, json={"dashboard_type": "animation", "source_type": "text", "prompt": STORY, "target_seconds": 30, "style_profile": "nope"})).status_code == 400

        r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "anim"}, json={
            "dashboard_type": "animation", "source_type": "text", "prompt": STORY, "target_seconds": 30, "style_profile": "paper", "music": "calm",
            "characters": [{"name": "Mira", "description": "a keeper in a yellow raincoat"}]})
        assert r.status_code == 201
        pid = r.json()["id"]
        p = await until(c, h, pid, {"awaiting_approval"})
        # the script is the user's own text, segmented; nothing is invented and there is no research step
        assert p["script"]["research"] == [] and " ".join(s["narration"] for s in p["scenes"]).startswith("Mira was a lighthouse keeper")
        assert all(x in STORY for s in p["scenes"] for x in s["narration"].split(". ")[:1])
        await c.post(f"/v1/projects/{pid}/script/approve", headers=h, json={})
        p = await until(c, h, pid, {"in_review"}, timeout=120)
        assert p["dashboard_type"] == "animation" and p["style_profile"] == "paper"
        assert (await c.get("/v1/projects?dashboard=animation", headers=h)).json()["projects"][0]["id"] == pid
        assert all(x["id"] != pid for x in (await c.get("/v1/projects", headers=h)).json()["projects"])

    with psycopg.connect(DB) as conn:
        key = conn.execute("SELECT storage_key FROM renders WHERE project_id=%s AND version=1", (pid,)).fetchone()[0]
        jobs = {r[0] for r in conn.execute("SELECT type FROM jobs WHERE project_id=%s", (pid,))}
        seeds = conn.execute("SELECT position, narration, seed FROM scenes WHERE project_id=%s ORDER BY position", (pid,)).fetchall()
    assert "music" in jobs and "research" not in jobs
    from xen_studio.pipeline import activities
    rms = loudness_profile(activities.deps().storage.path(key))
    rms = rms[100:]  # skip the 1.5 s fade-in (about 65 audio frames)
    assert rms and min(rms) > -60, "the music bed keeps audio under the narration (no dead silence)"
    # the paper style's background colour is in the frames
    frame = subprocess.run(["ffmpeg", "-v", "error", "-ss", "0.5", "-i", str(activities.deps().storage.path(key)), "-frames:v", "1", "-vf", "crop=8:8:4:4,scale=1:1",
                            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    assert abs(frame[0] - 0x3d) < 24 and abs(frame[1] - 0x2c) < 24, f"background {frame.hex()} is not the paper palette"
    assert seeds and any("Mira" in s[1] for s in seeds)


async def test_link_ingestion_rights_record_and_human_rights_review(app):  # noqa: F811
    lurl = app.state.ledger_url
    h = workspace(lurl, plan="pro", credits=1000)
    staff = workspace(lurl)
    make_staff(staff)
    async with client_for(app) as c:
        base = {"dashboard_type": "animation", "source_type": "link", "target_seconds": 20, "style_profile": "flat"}
        no_attest = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "l0"}, json={**base, "source_url": "https://example.com/my-blog/how-we-built-a-boat"})
        assert no_attest.status_code == 400 and "rights" in no_attest.json()["error"]["message"]
        assert (await c.post("/v1/projects", headers={**h, "Idempotency-Key": "l1"}, json={**base, "source_url": "ftp://x", "rights_attested": True})).status_code == 400

        # an ordinary page is ingested, cleared, adapted and rendered
        r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "l2"}, json={**base, "source_url": "https://example.com/my-blog/how-we-built-a-boat", "rights_attested": True})
        own = r.json()["id"]
        p = await until(c, h, own, {"awaiting_approval"})
        assert p["title"] == "My Blog How We Built A Boat" and "how we built a boat" in p["scenes"][0]["narration"]
        with psycopg.connect(DB) as conn:
            rec = conn.execute("SELECT r.source_url, r.attestation, r.check_result FROM rights_records r JOIN projects p ON p.rights_record_id = r.id WHERE p.id=%s", (own,)).fetchone()
        assert rec[0].endswith("how-we-built-a-boat") and "I own this content" in rec[1] and rec[2] == "clear"

        # a commercial catalog link is held: no credits reserved, staff see it, and their decision resumes or stops it
        held = []
        for k in ("l3", "l4"):
            r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": k}, json={**base, "source_url": f"https://www.netflix.com/title/{k}", "rights_attested": True})
            held.append(r.json()["id"])
            p = await until(c, h, held[-1], {"rights_review"})
            assert "commercially licensed" in p["error"]
        items = [i for i in (await c.get("/v1/admin/moderation", headers=staff)).json()["items"] if i["workspace_id"] == h["X-Workspace-Id"] and i["subject_type"] == "rights"]
        assert len(items) == 2
        by_project = {i["subject_id"]: i for i in items}
        await c.post(f"/v1/admin/moderation/{h['X-Workspace-Id']}/{by_project[held[0]]['id']}", headers=staff, json={"status": "overturned", "note": "licensed to customer"})
        await c.post(f"/v1/admin/moderation/{h['X-Workspace-Id']}/{by_project[held[1]]['id']}", headers=staff, json={"status": "upheld", "note": "no licence"})
        await until(c, h, held[0], {"awaiting_approval"})
        p = await until(c, h, held[1], {"blocked"})
        assert "rights review" in p["error"]


async def test_cloned_voice_requires_consent(app):  # noqa: F811
    h = workspace(app.state.ledger_url, plan="pro", credits=1000)
    async with client_for(app) as c:
        body = {"dashboard_type": "animation", "source_type": "text", "prompt": STORY, "target_seconds": 20, "voice": "clone:mira"}
        assert (await c.post("/v1/projects", headers={**h, "Idempotency-Key": "v1"}, json=body)).status_code == 403
        cid = (await c.post("/v1/consents", headers=h, json={"kind": "voice_clone", "subject_name": "Mira Khan",
                                                             "statement": "I, Mira Khan, consent to my voice being cloned for this workspace's videos."})).json()["id"]
        assert (await c.post("/v1/projects", headers={**h, "Idempotency-Key": "v2"}, json={**body, "consent_record_id": cid})).status_code == 201
        assert (await c.delete(f"/v1/consents/{cid}", headers=h)).status_code == 204
        assert (await c.post("/v1/projects", headers={**h, "Idempotency-Key": "v3"}, json={**body, "consent_record_id": cid})).status_code == 403
        other = workspace(app.state.ledger_url, plan="pro")
        assert (await c.get("/v1/consents", headers=other)).json()["consents"] == []
    await asyncio.sleep(0)
