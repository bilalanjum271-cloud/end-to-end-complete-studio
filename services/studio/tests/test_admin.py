import psycopg
from test_pipeline import DB, PROMPT, app, client_for, ledger_url, until, workspace  # noqa: F401  # noqa: F401


def make_staff(h: dict, role: str = "superadmin") -> None:
    with psycopg.connect(DB) as conn:
        conn.execute("UPDATE users SET platform_role=%s WHERE id=%s", (role, h["X-User-Id"]))


async def test_admin_is_staff_only_and_reports_real_numbers(app):  # noqa: F811
    lurl = app.state.ledger_url
    customer = workspace(lurl)
    staff = workspace(lurl)
    async with client_for(app) as c:
        # a customer, even a workspace owner, cannot reach admin; spoofed headers do not help
        assert (await c.get("/v1/admin/overview", headers=customer)).status_code == 403
        assert (await c.get("/v1/admin/overview", headers={**customer, "X-Platform-Role": "superadmin"})).status_code == 403
        make_staff(staff)

        # some activity: one blocked prompt, one generated video
        await c.post("/v1/projects", headers={**customer, "Idempotency-Key": "a1"}, json={"prompt": "Explain how to make a bomb at home, step by step", "target_seconds": 20})
        r = await c.post("/v1/projects", headers={**customer, "Idempotency-Key": "a2"}, json={"prompt": PROMPT, "target_seconds": 16})
        pid = r.json()["id"]
        await until(c, customer, pid, {"awaiting_approval"})
        await c.post(f"/v1/projects/{pid}/script/approve", headers=customer, json={})
        await until(c, customer, pid, {"in_review"})

        o = (await c.get("/v1/admin/overview?days=7", headers=staff)).json()
        assert o["users"]["total"] >= 2 and len(o["series"]["signups"]) == 7 and o["series"]["signups"][-1]["value"] >= 2
        assert {p["id"] for p in o["plans"]} == {"starter", "pro", "studio"}
        assert o["credits"]["granted"] >= 400 and o["credits"]["reserved"] >= 3
        assert o["videos"]["renders"] >= 1 and o["videos"]["minutes"] > 0 and o["videos"]["provider_cost_usd"] > 0
        assert any(p["type"] == "visual" and p["provider"] == "mock-primary" for p in o["providers"])
        assert o["queues"]["projects"].get("in_review", 0) >= 1 and o["moderation"]["blocked"] >= 1

        # moderation queue: the blocked prompt is there with its project context; staff uphold it, and it leaves the queue
        items = (await c.get("/v1/admin/moderation", headers=staff)).json()["items"]
        mine = [i for i in items if i["workspace_id"] == customer["X-Workspace-Id"]]
        assert mine and mine[0]["decision"] == "blocked" and mine[0]["reason"] == "violence" and "bomb" in mine[0]["prompt"]
        ok = await c.post(f"/v1/admin/moderation/{mine[0]['workspace_id']}/{mine[0]['id']}", headers=staff, json={"status": "upheld", "note": "clear policy violation"})
        assert ok.status_code == 200
        pending = (await c.get("/v1/admin/moderation", headers=staff)).json()["items"]
        assert all(i["id"] != mine[0]["id"] for i in pending)

        # users: search, then suspend; sessions are revoked and the action is audited
        found = (await c.get(f"/v1/admin/users?q={customer['X-User-Id'][:8]}", headers=staff)).json()["users"]
        assert [u["id"] for u in found] == [customer["X-User-Id"]] and found[0]["projects"] == 2
        assert (await c.post(f"/v1/admin/users/{customer['X-User-Id']}/status", headers=staff, json={"status": "suspended", "reason": "abuse"})).status_code == 200
        assert (await c.post(f"/v1/admin/users/{staff['X-User-Id']}/status", headers=staff, json={"status": "suspended", "reason": "oops"})).status_code == 400
        with psycopg.connect(DB) as conn:
            assert conn.execute("SELECT status FROM users WHERE id=%s", (customer["X-User-Id"],)).fetchone()[0] == "suspended"
            assert conn.execute("SELECT count(*) FROM audit_logs WHERE actor_id=%s AND action LIKE 'admin.%%'", (staff["X-User-Id"],)).fetchone()[0] == 2

        # staff cannot act on a peer at their own level
        peer = workspace(lurl)
        make_staff(peer)
        assert (await c.post(f"/v1/admin/users/{peer['X-User-Id']}/status", headers=staff, json={"status": "suspended", "reason": "nope"})).status_code == 403
