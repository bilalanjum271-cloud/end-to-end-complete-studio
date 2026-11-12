"""XR: prompt -> validated GLB asset (credits reserved and debited), scenes with spatial-audio nodes and
optimistic-concurrency autosave, whole-scene device export, plan gating, tenant isolation."""
import asyncio
import struct

from test_pipeline import app, balance, client_for, ledger_url, workspace  # noqa: F401  # noqa: F401


async def wait_asset(c, h, aid, timeout=30):
    for _ in range(int(timeout / 0.2)):
        a = next(x for x in (await c.get("/v1/xr/assets", headers=h)).json()["assets"] if x["id"] == aid)
        if a["status"] in ("ready", "failed", "blocked"):
            return a
        await asyncio.sleep(0.2)
    raise AssertionError(a)


def glb_json(data: bytes) -> dict:
    import json
    assert data[:4] == b"glTF" and struct.unpack_from("<I", data, 8)[0] == len(data)
    jlen = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + jlen])


async def test_assets_scenes_and_export(app):  # noqa: F811
    lurl = app.state.ledger_url
    h = workspace(lurl, plan="studio", credits=100)
    async with client_for(app) as c:
        assert (await c.post("/v1/xr/assets", headers=h, json={"prompt": "a red rocket"})).status_code == 400  # Idempotency-Key
        r1 = await c.post("/v1/xr/assets", headers={**h, "Idempotency-Key": "a1"}, json={"prompt": "a red rocket"})
        r2 = await c.post("/v1/xr/assets", headers={**h, "Idempotency-Key": "a1"}, json={"prompt": "a red rocket"})
        assert r1.status_code == 202 and r1.json()["id"] == r2.json()["id"]
        rocket = await wait_asset(c, h, r1.json()["id"])
        table = await wait_asset(c, h, (await c.post("/v1/xr/assets", headers={**h, "Idempotency-Key": "a2"}, json={"prompt": "wooden table"})).json()["id"])
        assert rocket["status"] == table["status"] == "ready" and rocket["triangles"] > 0 and rocket["bounds"]["max"][1] > 1
        assert balance(lurl, h) == (90, 0, 10)
        g = glb_json((await c.get(f"/v1/xr/assets/{rocket['id']}/model.glb", headers=h)).content)
        assert g["asset"]["version"] == "2.0" and len(g["meshes"]) == 4

        s = (await c.post("/v1/xr/scenes", headers=h, json={"kind": "vr", "name": "Launch pad"})).json()
        nodes = [{"id": "n1", "asset_id": rocket["id"], "position": [0, 0, -2], "rotation": [0, 1.57, 0], "scale": 1.5,
                  "audio": {"kind": "ambient", "volume": 0.6, "ref_distance": 2}},
                 {"id": "n2", "asset_id": table["id"], "position": [1.5, 0, -2], "rotation": [0, 0, 0], "scale": 1}]
        saved = await c.put(f"/v1/xr/scenes/{s['id']}", headers=h, json={"scene": {"nodes": nodes, "environment": "night"}, "version": 1})
        assert saved.status_code == 200 and saved.json()["version"] == 2
        stale = await c.put(f"/v1/xr/scenes/{s['id']}", headers=h, json={"scene": {"nodes": [], "environment": "night"}, "version": 1})
        assert stale.status_code == 409
        bad = await c.put(f"/v1/xr/scenes/{s['id']}", headers=h, json={"scene": {"nodes": [{**nodes[0], "position": [0, 0, 1e9]}]}, "version": 2})
        assert bad.status_code == 422

        exp = await c.get(f"/v1/xr/scenes/{s['id']}/export.glb", headers=h)
        assert exp.status_code == 200 and exp.headers["content-type"] == "model/gltf-binary"
        sg = glb_json(exp.content)
        roots = [sg["nodes"][i] for i in sg["scenes"][0]["nodes"]]
        assert [n["name"] for n in roots] == ["n1", "n2"] and roots[0]["translation"] == [0, 0, -2] and roots[0]["scale"] == [1.5] * 3
        assert roots[0]["extras"]["audio"]["ref_distance"] == 2 and len(sg["meshes"]) == 9
        for acc in sg["accessors"]:  # every accessor points inside the merged binary chunk
            v = sg["bufferViews"][acc["bufferView"]]
            assert v["byteOffset"] + v["byteLength"] <= sg["buffers"][0]["byteLength"]

        other = workspace(lurl, plan="studio")
        assert (await c.get(f"/v1/xr/scenes/{s['id']}", headers=other)).status_code == 404
        assert (await c.get(f"/v1/xr/assets/{rocket['id']}/model.glb", headers=other)).status_code == 404
        foreign = await c.put(f"/v1/xr/scenes/{(await c.post('/v1/xr/scenes', headers=other, json={'kind': 'ar', 'name': 'x'})).json()['id']}",
                              headers=other, json={"scene": {"nodes": nodes[:1]}, "version": 1})
        assert foreign.status_code == 400, "another tenant's asset cannot be placed"


async def test_plan_gating_and_refund_on_failure(app, monkeypatch):  # noqa: F811
    lurl = app.state.ledger_url
    async with client_for(app) as c:
        starter = workspace(lurl, plan="starter")
        assert (await c.post("/v1/xr/scenes", headers=starter, json={"kind": "ar", "name": "x"})).status_code == 403
        pro = workspace(lurl, plan="pro", credits=20)
        s = (await c.post("/v1/xr/scenes", headers=pro, json={"kind": "ar", "name": "x"})).json()
        assert (await c.get(f"/v1/xr/scenes/{s['id']}/export.glb", headers=pro)).status_code == 403  # preview plan: no device export
        monkeypatch.setenv("XEN_MOCK_FAIL", "3d:mock-primary,3d:mock-secondary")
        a = await wait_asset(c, pro, (await c.post("/v1/xr/assets", headers={**pro, "Idempotency-Key": "f"}, json={"prompt": "lamp"})).json()["id"])
        assert a["status"] == "failed" and "every provider" in a["error"]
        assert balance(lurl, pro) == (20, 0, 0)
