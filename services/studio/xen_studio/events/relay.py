"""Outbox relay: moves events written transactionally into `outbox` onto the event bus.

At-least-once: a row is marked published only after the sink acknowledges it, so a crash can
re-send a batch; every event carries its outbox id as `event_id`, which consumers use to dedupe.
Many relays can run at once: rows are claimed with FOR UPDATE SKIP LOCKED.

Sinks:
  kafka   confluent-kafka producer, key = workspace_id (KAFKA_BROKERS)          production
  jsonl   date-partitioned JSON lines under LAKE_ROOT/<topic>/date=YYYY-MM-DD/   local lakehouse stand-in

    python -m xen_studio.events.relay            # runs forever
    python -m xen_studio.events.relay --once     # one pass (cron, tests)
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Protocol

import psycopg
from psycopg.rows import dict_row


class Sink(Protocol):
    def publish(self, events: list[dict]) -> None: ...


class JsonlSink:
    def __init__(self, root: str):
        self.root = Path(root)

    def publish(self, events: list[dict]) -> None:
        by_file: dict[Path, list[str]] = {}
        for e in events:
            f = self.root / e["topic"] / f"date={e['created_at'][:10]}" / "events.jsonl"
            by_file.setdefault(f, []).append(json.dumps(e, ensure_ascii=False))
        for f, lines in by_file.items():
            f.parent.mkdir(parents=True, exist_ok=True)
            with open(f, "a", encoding="utf-8") as out:
                out.write("\n".join(lines) + "\n")
                out.flush()
                os.fsync(out.fileno())


class KafkaSink:
    """Written for production; not run in the build sandbox (no broker). Requires `pip install confluent-kafka`."""

    def __init__(self, brokers: str):
        from confluent_kafka import Producer  # noqa: PLC0415
        self.p = Producer({"bootstrap.servers": brokers, "enable.idempotence": True, "acks": "all", "compression.type": "zstd", "linger.ms": 20})

    def publish(self, events: list[dict]) -> None:
        errors: list[str] = []
        for e in events:
            self.p.produce(e["topic"], key=e["workspace_id"], value=json.dumps(e, ensure_ascii=False).encode(),
                           headers={"event_id": e["event_id"], "event_type": e["event_type"]},
                           on_delivery=lambda err, _msg: errors.append(str(err)) if err else None)
        self.p.flush(30)
        if errors:
            raise RuntimeError(f"{len(errors)} events not acknowledged: {errors[0]}")


def relay_once(database_url: str, sink: Sink, batch: int = 500) -> int:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        rows = conn.execute("""SELECT workspace_id, id, topic, event_type, payload, created_at FROM outbox
                               WHERE published_at IS NULL ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED""", (batch,)).fetchall()
        if not rows:
            return 0
        events = [{"event_id": str(r["id"]), "workspace_id": str(r["workspace_id"]), "topic": r["topic"], "event_type": r["event_type"],
                   "created_at": r["created_at"].isoformat(), "payload": r["payload"]} for r in rows]
        sink.publish(events)  # raises -> transaction rolls back -> rows stay unpublished and are retried
        conn.execute("UPDATE outbox SET published_at = now() WHERE (workspace_id, id) IN (SELECT unnest(%s::uuid[]), unnest(%s::uuid[]))",
                     ([e["workspace_id"] for e in events], [e["event_id"] for e in events]))
        return len(events)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    url = os.environ["DATABASE_URL"]
    sink: Sink = KafkaSink(os.environ["KAFKA_BROKERS"]) if os.environ.get("EVENT_SINK") == "kafka" else JsonlSink(os.environ.get("LAKE_ROOT", "./.lake"))
    while True:
        n = relay_once(url, sink)
        if args.once:
            print(f"relayed {n} events")
            return
        if n == 0:
            time.sleep(0.5)


if __name__ == "__main__":
    main()
