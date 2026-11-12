import json
import os
import uuid

import psycopg
import pytest

from xen_studio.events.relay import JsonlSink, relay_once

DB = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="needs TEST_DATABASE_URL")


def add(conn, ws, topic, payload):
    eid = str(uuid.uuid4())
    conn.execute("INSERT INTO outbox (workspace_id,id,topic,event_type,payload) VALUES (%s,%s,%s,%s,%s)", (ws, eid, topic, topic, json.dumps(payload)))
    return eid


def test_relay_publishes_each_event_once_and_retries_on_sink_failure(tmp_path):
    with psycopg.connect(DB) as conn:  # start from an empty backlog so the assertions are exact
        conn.execute("UPDATE outbox SET published_at = now() WHERE published_at IS NULL")
        ws = str(uuid.uuid4())
        ids = [add(conn, ws, "credits.debited", {"amount": 5}), add(conn, ws, "render.completed", {"version": 1})]

    class Broken:
        def publish(self, events):
            raise RuntimeError("broker down")
    with pytest.raises(RuntimeError):
        relay_once(DB, Broken())
    with psycopg.connect(DB) as conn:
        assert conn.execute("SELECT count(*) FROM outbox WHERE published_at IS NULL AND id = ANY(%s::uuid[])", (ids,)).fetchone()[0] == 2

    sink = JsonlSink(str(tmp_path))
    assert relay_once(DB, sink) == 2
    assert relay_once(DB, sink) == 0
    files = sorted(p.relative_to(tmp_path).parts[0] for p in tmp_path.rglob("events.jsonl"))
    assert files == ["credits.debited", "render.completed"]
    line = json.loads(next(tmp_path.rglob("credits.debited/*/events.jsonl")).read_text().splitlines()[0])
    assert line["event_id"] in ids and line["workspace_id"] == ws and line["payload"] == {"amount": 5}
