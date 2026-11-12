"""Temporal host for the Script-to-Video flow.

NOT YET RUN: no Temporal server was available in the build sandbox. The flow logic it wraps
(flow.py) and every activity are tested through the local host; this file only adapts them
to Temporal's API. Verify with `temporal server start-dev` + `python -m xen_studio.pipeline.worker`.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from .flow import script_to_video

TASK_QUEUE = "script-to-video"
_RETRY = RetryPolicy(initial_interval=timedelta(seconds=1), backoff_coefficient=2.0, maximum_attempts=3,
                     non_retryable_error_types=["ValueError", "LookupError"])
_TIMEOUTS = {"generate_visual": 900, "generate_voice": 300, "assemble_render": 1800, "write_script": 300}


class _TemporalHost:
    def __init__(self) -> None:
        self.signals: list[tuple[str, dict]] = []

    async def act(self, name: str, *args: Any) -> Any:
        return await workflow.execute_activity(name, args=list(args), retry_policy=_RETRY,
                                               start_to_close_timeout=timedelta(seconds=_TIMEOUTS.get(name, 60)))

    async def gather(self, calls: list[tuple[str, tuple]]) -> list[Any]:
        return list(await asyncio.gather(*(self.act(n, *a) for n, a in calls)))

    async def wait_signal(self, timeout_s: float):
        try:
            await workflow.wait_condition(lambda: bool(self.signals), timeout=timedelta(seconds=timeout_s))
        except asyncio.TimeoutError:
            return None
        return self.signals.pop(0)


@workflow.defn(name="ScriptToVideo")
class ScriptToVideoWorkflow:
    def __init__(self) -> None:
        self._host = _TemporalHost()

    @workflow.run
    async def run(self, ws: str, pid: str) -> str:
        return await script_to_video(self._host, ws, pid)

    @workflow.signal
    def approve_script(self, data: dict) -> None:
        self._host.signals.append(("approve_script", data))

    @workflow.signal
    def regenerate_script(self, data: dict) -> None:
        self._host.signals.append(("regenerate_script", data))

    @workflow.signal
    def revise(self, data: dict) -> None:
        self._host.signals.append(("revise", data))

    @workflow.signal
    def accept(self, data: dict) -> None:
        self._host.signals.append(("accept", data))

    @workflow.signal
    def cancel(self, data: dict) -> None:
        self._host.signals.append(("cancel", data))


@workflow.defn(name="RunActivity")
class RunActivityWorkflow:
    """One retried activity as a workflow: used for exports."""

    @workflow.run
    async def run(self, name: str, args: list) -> None:
        await workflow.execute_activity(name, args=args, retry_policy=_RETRY, start_to_close_timeout=timedelta(seconds=1800))


class TemporalOrchestrator:
    """Same interface as LocalOrchestrator, backed by a Temporal client. Workflow id = project id (idempotent start)."""

    def __init__(self, client) -> None:
        self.client = client

    async def start(self, ws: str, pid: str) -> None:
        from temporalio.common import WorkflowIDReusePolicy
        from temporalio.exceptions import WorkflowAlreadyStartedError
        try:
            await self.client.start_workflow("ScriptToVideo", args=[ws, pid], id=f"project-{pid}", task_queue=TASK_QUEUE,
                                             id_reuse_policy=WorkflowIDReusePolicy.REJECT_DUPLICATE)
        except WorkflowAlreadyStartedError:
            pass

    async def signal(self, ws: str, pid: str, name: str, data: dict) -> bool:
        await self.client.get_workflow_handle(f"project-{pid}").signal(name, data)
        return True

    async def run_task(self, name: str, *args) -> None:
        from temporalio.exceptions import WorkflowAlreadyStartedError
        try:
            await self.client.start_workflow("RunActivity", args=[name, list(args)], id=f"{name}-{'-'.join(str(a) for a in args)}", task_queue=TASK_QUEUE)
        except WorkflowAlreadyStartedError:
            pass
