"""Localization end to end: glossary -> translation -> human review queue -> edited approval ->
dubbed render with credits reserved, debited on success, plan language limit."""
import asyncio
import subprocess

import psycopg
from test_pipeline import DB, PROMPT, app, balance, client_for, ffprobe_streams, ledger_url, until, workspace  # noqa: F401  (fixtures re-used)  # noqa: F401


async def rendered_project(c, h):
    r = await c.post("/v1/projects", headers={**h, "Idempotency-Key": "loc"}, json={"prompt": PROMPT, "target_seconds": 20})
    pid = r.json()["id"]
    await until(c, h, pid, {"awaiting_approval"})
    await c.post(f"/v1/projects/{pid}/script/approve", headers=h, json={})
    await until(c, h, pid, {"in_review"})
    return pid


async def wait_loc(c, h, pid, lang, statuses, timeout=90):
    for _ in range(int(timeout / 0.2)):
        loc = (await c.get(f"/v1/projects/{pid}/localizations/{lang}", headers=h)).json()
        if loc.get("status") in statuses:
            return loc
        await asyncio.sleep(0.2)
    raise AssertionError(f"localization stuck: {loc}")


async def test_glossary_translation_review_and_dub(app):  # noqa: F811
    lurl = app.state.ledger_url
    h = workspace(lurl, plan="pro", credits=1000)
    async with client_for(app) as c:
        # glossary: one term, upserted case-insensitively; viewers cannot edit
        assert (await c.post("/v1/glossary", headers=h, json={"language": "ur", "source": "Tunguska", "target": "تنگسکا"})).status_code == 201
        assert (await c.post("/v1/glossary", headers=h, json={"language": "ur", "source": "tunguska", "target": "تُنگُسکا"})).status_code == 201
        terms = (await c.get("/v1/glossary?language=ur", headers=h)).json()["terms"]
        assert [(t["source"], t["target"]) for t in terms] == [("Tunguska", "تُنگُسکا")]
        assert (await c.post("/v1/glossary", headers={**h, "X-Role": "viewer"}, json={"language": "ur", "source": "a", "target": "b"})).status_code == 403

        pid = await rendered_project(c, h)
        before = balance(lurl, h)

        # translation lands in the review queue; the glossary was applied
        r = await c.post(f"/v1/projects/{pid}/localizations", headers=h, json={"language": "ur"})
        assert r.status_code == 202 and r.json()["status"] == "translating"
        assert (await c.post(f"/v1/projects/{pid}/localizations", headers=h, json={"language": "ur"})).json()["status"] == "exists"
        assert (await c.post(f"/v1/projects/{pid}/localizations", headers=h, json={"language": "en"})).status_code == 400
        loc = await wait_loc(c, h, pid, "ur", {"in_review", "failed"})
        assert loc["status"] == "in_review" and len(loc["lines"]) == len(loc["source_lines"]) == 2
        assert all(line.startswith("[ur] ") for line in loc["lines"]) and any("تُنگُسکا" in line for line in loc["lines"])
        assert loc["estimate_credits"] == 2 and loc["glossary"] == [{"source": "Tunguska", "target": "تُنگُسکا"}]
        queue = (await c.get("/v1/review-queue", headers=h)).json()["items"]
        assert [(i["project_id"], i["language"]) for i in queue] == [(pid, "ur")]
        feed = (await c.get("/v1/notifications", headers=h)).json()["notifications"]
        assert feed[0]["kind"] == "localization_review" and feed[0]["link"] == f"/app/video/{pid}/localize/ur"

        # reviewer edits one line and approves: credits reserved, dub rendered, credits debited once
        lines = loc["lines"][:]
        lines[0] = "سن 1908 کی ایک صبح، سائبیریا کا آسمان پھٹ گیا۔"
        assert (await c.post(f"/v1/projects/{pid}/localizations/ur/approve", headers=h, json={"lines": lines[:1]})).status_code == 400
        ok = await c.post(f"/v1/projects/{pid}/localizations/ur/approve", headers=h, json={"lines": lines})
        assert ok.status_code == 202 and ok.json()["credits"] == 2
        assert (await c.post(f"/v1/projects/{pid}/localizations/ur/approve", headers=h, json={"lines": lines})).status_code == 409
        loc = await wait_loc(c, h, pid, "ur", {"ready", "failed"})
        assert loc["status"] == "ready" and loc["lines"][0].startswith("سن 1908")
        assert (await c.get("/v1/review-queue", headers=h)).json()["items"] == []
        assert balance(lurl, h) == (before[0] - 2, before[1], before[2] + 2)

        # the dub is a real MP4 with an Urdu-tagged subtitle track carrying the reviewed text
        v = await c.get(f"/v1/projects/{pid}/localizations/ur/video.mp4", headers=h)
        assert v.status_code == 200 and len(v.content) > 10_000
        srt = (await c.get(f"/v1/projects/{pid}/localizations/ur/subtitles.srt", headers=h)).text
        assert "سن 1908 کی ایک صبح" in srt
        from xen_studio.pipeline import activities
        with psycopg.connect(DB) as conn:
            key = conn.execute("SELECT storage_key FROM localizations WHERE project_id=%s AND language='ur'", (pid,)).fetchone()[0]
        path = activities.deps().storage.path(key)
        assert ffprobe_streams(path) == {"video", "audio", "subtitle"}
        lang_tag = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "s:0", "-show_entries", "stream_tags=language", "-of", "csv=p=0", str(path)],
                                  capture_output=True, text=True).stdout.strip()
        assert lang_tag == "urd"

        # other tenants cannot read it
        other = workspace(lurl)
        assert (await c.get(f"/v1/projects/{pid}/localizations/ur", headers=other)).status_code == 404
        assert (await c.get("/v1/review-queue", headers=other)).json()["items"] == []


async def test_language_limit_on_starter(app):  # noqa: F811
    h = workspace(app.state.ledger_url, plan="starter", credits=200)
    async with client_for(app) as c:
        pid = await rendered_project(c, h)
        with psycopg.connect(DB) as conn:  # simulate a plan with only 2 languages: original + 1
            conn.execute("UPDATE plans SET max_languages=2 WHERE id='starter'")
        try:
            assert (await c.post(f"/v1/projects/{pid}/localizations", headers=h, json={"language": "ur"})).status_code == 202
            r = await c.post(f"/v1/projects/{pid}/localizations", headers=h, json={"language": "ar"})
            assert r.status_code == 403 and "2 languages" in r.json()["error"]["message"]
        finally:
            with psycopg.connect(DB) as conn:
                conn.execute("UPDATE plans SET max_languages=10 WHERE id='starter'")
