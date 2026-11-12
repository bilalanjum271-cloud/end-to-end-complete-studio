"""Model Router: every AI capability sits behind a provider interface with ordered
adapters, automatic failover, per-adapter circuit breaking and cost reporting.

    router = default_router()
    script, used = router.call("llm", "write_script", prompt=..., ...)

`used` says which provider and model served the call and what it cost, so the
pipeline can record it on the job row (Master Stack: "Route job, report cost, fail over").
"""
from .base import Adapter, ModelRouter, ProviderError, Used  # noqa: F401
from .mock import default_router  # noqa: F401
