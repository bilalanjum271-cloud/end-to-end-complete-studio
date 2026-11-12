"""Temporal worker for the script-to-video task queue. Scale with KEDA on task-queue backlog.

    python -m xen_studio.pipeline.worker
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor

from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from .. import config
from ..router import default_router
from . import activities
from .temporal_workflow import TASK_QUEUE, ScriptToVideoWorkflow


async def main() -> None:
    cfg = config.load()
    activities.configure(activities.Deps(cfg, default_router()))
    client = await Client.connect(cfg.temporal_address)
    acts = [activity.defn(name=f.__name__)(f) for f in activities.ALL]
    with ThreadPoolExecutor(max_workers=16) as pool:
        await Worker(client, task_queue=TASK_QUEUE, workflows=[ScriptToVideoWorkflow], activities=acts,
                     activity_executor=pool, max_concurrent_activities=16).run()


if __name__ == "__main__":
    asyncio.run(main())
