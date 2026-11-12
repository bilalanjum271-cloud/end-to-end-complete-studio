"""In-process host for the workflow: local development and tests only.

It is not durable: a restart loses running workflows (their credits stay reserved until the
project is cancelled). Production runs the same flow on Temporal (ORCHESTRATOR=temporal).
"""
from __future__ import annotations

import asyncio
from typing import Any

from . import activities
from .flow import script_to_video

_ACTS = {f.__name__: f for f in activities.ALL}


class LocalHost:
    def __init__(self, max_parallel: int = 4):
        self.signals: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()
        self._sem = asyncio.Semaphore(max_parallel)  # bulkhead: bounded concurrent generation per project

    async def act(self, name: str, *args: Any) -> Any:
        last: Exception | None = None
        for attempt in range(3):  # same retry budget the Temporal policy uses
            try:
                async with self._sem:
                    return await asyncio.to_thread(_ACTS[name], *args)
            except (ValueError, LookupError):
                raise
            except Exception as err:  # noqa: BLE001
                last = err
                await asyncio.sleep(0.2 * 2**attempt)
        assert last is not None
        raise last

    async def gather(self, calls: list[tuple[str, tuple]]) -> list[Any]:
        return list(await asyncio.gather(*(self.act(n, *a) for n, a in calls)))

    async def wait_signal(self, timeout_s: float):
        try:
            return await asyncio.wait_for(self.signals.get(), timeout_s)
        except asyncio.TimeoutError:
            return None


class LocalOrchestrator:
    def __init__(self) -> None:
        self._hosts: dict[str, LocalHost] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    async def start(self, ws: str, pid: str) -> None:
        if pid in self._tasks:
            return
        host = LocalHost()
        self._hosts[pid] = host
        task = asyncio.create_task(script_to_video(host, ws, pid))
        self._tasks[pid] = task
        task.add_done_callback(lambda _: (self._hosts.pop(pid, None), self._tasks.pop(pid, None)))

    async def signal(self, ws: str, pid: str, name: str, data: dict) -> bool:
        host = self._hosts.get(pid)
        if not host:
            return False
        await host.signals.put((name, data))
        return True

    async def wait(self, pid: str, timeout: float = 120) -> str | None:
        task = self._tasks.get(pid)
        return await asyncio.wait_for(asyncio.shield(task), timeout) if task else None
