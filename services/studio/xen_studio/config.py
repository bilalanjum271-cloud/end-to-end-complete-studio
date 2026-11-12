"""Configuration from environment variables only (secrets never live in code)."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    ledger_url: str
    internal_token: str
    media_root: str
    orchestrator: str  # "local" (in-process, dev and tests) or "temporal"
    temporal_address: str
    credits_per_minute: int


def load() -> Config:
    def need(name: str) -> str:
        v = os.environ.get(name)
        if not v:
            raise RuntimeError(f"{name} is required")
        return v

    return Config(
        database_url=need("DATABASE_URL"),
        ledger_url=os.environ.get("LEDGER_URL", "http://localhost:8102"),
        internal_token=need("INTERNAL_SERVICE_TOKEN"),
        media_root=os.environ.get("MEDIA_ROOT", "./.media"),
        orchestrator=os.environ.get("ORCHESTRATOR", "local"),
        temporal_address=os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"),
        credits_per_minute=int(os.environ.get("CREDITS_PER_VIDEO_MINUTE", "10")),
    )
