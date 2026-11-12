"""The Script-to-Video workflow, written once against a small Host interface.

Two hosts run this same function:
  * TemporalHost  (temporal_workflow.py)  durable, retried, survives restarts: production
  * LocalHost     (local_runner.py)       in-process asyncio: local development and tests

The function contains no I/O and no clocks of its own, which keeps it deterministic for Temporal.
"""
from __future__ import annotations

from typing import Any, Protocol

APPROVAL_TIMEOUT_S = 7 * 24 * 3600
REVIEW_TIMEOUT_S = 30 * 24 * 3600
MAX_SCRIPT_REGENERATIONS = 5


class Host(Protocol):
    async def act(self, name: str, *args: Any) -> Any: ...
    async def gather(self, calls: list[tuple[str, tuple]]) -> list[Any]: ...
    async def wait_signal(self, timeout_s: float) -> tuple[str, dict] | None: ...


async def script_to_video(h: Host, ws: str, pid: str) -> str:
    reserved = False
    try:
        if (await h.act("moderate_prompt", ws, pid))["decision"] == "blocked":
            return "blocked"
        if not (await h.act("reserve_credits", ws, pid))["ok"]:
            return "insufficient_credits"
        reserved = True

        # script, then the first human pause: approve / regenerate
        if not await h.act("write_script", ws, pid, ""):
            await h.act("settle_credits", ws, pid, "release", "script blocked by moderation")
            return "blocked"
        await h.act("notify", ws, pid, "script_ready")
        regenerations = 0
        while True:
            sig = await h.wait_signal(APPROVAL_TIMEOUT_S)
            if sig is None or sig[0] == "cancel":
                await h.act("settle_credits", ws, pid, "release", "cancelled before approval")
                await h.act("finish", ws, pid, "cancelled", None)
                return "cancelled"
            name, data = sig
            if name == "regenerate_script" and regenerations < MAX_SCRIPT_REGENERATIONS:
                regenerations += 1
                if not await h.act("write_script", ws, pid, data.get("feedback", "")):
                    await h.act("settle_credits", ws, pid, "release", "script blocked by moderation")
                    return "blocked"
            elif name == "approve_script":
                positions = await h.act("approve_script", ws, pid, data["user_id"], data.get("edits", []))
                break

        # generation, then the second human pause: accept / revise (limited by plan)
        while True:
            await _generate(h, ws, pid, positions)
            if not await h.act("assemble_render", ws, pid):
                await h.act("settle_credits", ws, pid, "release", "output blocked by moderation")
                return "blocked"
            await h.act("package_render", ws, pid)
            await h.act("notify", ws, pid, "video_ready")
            while True:
                sig = await h.wait_signal(REVIEW_TIMEOUT_S)
                if sig is None or sig[0] == "accept":
                    await h.act("settle_credits", ws, pid, "commit", "")
                    await h.act("finish", ws, pid, "completed", None)
                    return "completed"
                if sig[0] == "revise":
                    prep = await h.act("prepare_regeneration", ws, pid, sig[1]["user_id"], sig[1]["positions"], sig[1].get("feedback", ""))
                    if prep["ok"]:
                        positions = prep["positions"]
                        break  # regenerate only those scenes, then reassemble
    except Exception as err:  # noqa: BLE001 - any failure refunds the reservation
        if reserved:
            await h.act("settle_credits", ws, pid, "release", "generation failed")
        await h.act("finish", ws, pid, "failed", str(err)[:500])
        await h.act("notify", ws, pid, "generation_failed")
        return "failed"


async def _generate(h: Host, ws: str, pid: str, positions: list[int]) -> None:
    # Voices for all scenes in parallel, then visuals in parallel (each cut to its narration length).
    await h.gather([("generate_voice", (ws, pid, p)) for p in positions])
    await h.gather([("generate_visual", (ws, pid, p)) for p in positions])
