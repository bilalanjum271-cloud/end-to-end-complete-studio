from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable


class ProviderError(Exception):
    """A provider failed in a way that another provider might not (timeout, 5xx, quota)."""


class AllProvidersFailed(Exception):
    pass


@dataclass
class Used:
    provider: str
    model: str
    cost_microusd: int
    attempts: int
    duration_ms: int


@dataclass
class Adapter:
    """One provider for one capability. `methods` maps operation name -> callable returning (result, cost_microusd)."""

    name: str
    capability: str
    model: str
    methods: dict[str, Callable[..., tuple[Any, int]]]
    languages: set[str] | None = None  # None = any language


@dataclass
class _Breaker:
    failures: int = 0
    opened_at: float = 0.0


@dataclass
class ModelRouter:
    threshold: int = 3
    cooldown_s: float = 30.0
    clock: Callable[[], float] = time.monotonic
    _adapters: dict[str, list[Adapter]] = field(default_factory=dict)
    _breakers: dict[str, _Breaker] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    health_events: list[dict] = field(default_factory=list)  # relayed to the provider.health topic

    def register(self, adapter: Adapter) -> None:
        self._adapters.setdefault(adapter.capability, []).append(adapter)

    def catalog(self) -> dict[str, list[dict]]:
        return {cap: [{"provider": a.name, "model": a.model, "available": self._available(a)} for a in ads]
                for cap, ads in self._adapters.items()}

    def _key(self, a: Adapter) -> str:
        return f"{a.capability}:{a.name}"

    def _available(self, a: Adapter) -> bool:
        b = self._breakers.get(self._key(a))
        return not b or b.failures < self.threshold or self.clock() - b.opened_at >= self.cooldown_s

    def _record(self, a: Adapter, ok: bool, error: str = "") -> None:
        with self._lock:
            b = self._breakers.setdefault(self._key(a), _Breaker())
            was_open = b.failures >= self.threshold
            if ok:
                b.failures = 0
            else:
                b.failures += 1
                if b.failures >= self.threshold:
                    b.opened_at = self.clock()
            now_open = b.failures >= self.threshold
            if was_open != now_open or not ok:
                self.health_events.append({"capability": a.capability, "provider": a.name, "healthy": not now_open, "error": error})

    def call(self, capability: str, operation: str, *, language: str | None = None, **kwargs: Any) -> tuple[Any, Used]:
        """Try adapters in priority order; fail over on ProviderError; skip adapters with an open breaker."""
        candidates = [a for a in self._adapters.get(capability, [])
                      if operation in a.methods and (a.languages is None or language is None or language in a.languages)]
        if not candidates:
            raise AllProvidersFailed(f"no provider registered for {capability}.{operation} (language={language})")
        attempts, errors = 0, []
        started = time.monotonic()
        for a in candidates:
            if not self._available(a):
                errors.append(f"{a.name}: circuit open")
                continue
            attempts += 1
            try:
                result, cost = a.methods[operation](**kwargs) if language is None else a.methods[operation](language=language, **kwargs)
            except ProviderError as err:
                self._record(a, False, str(err))
                errors.append(f"{a.name}: {err}")
                continue
            self._record(a, True)
            return result, Used(a.name, a.model, cost, attempts, int((time.monotonic() - started) * 1000))
        raise AllProvidersFailed(f"{capability}.{operation} failed on every provider: {'; '.join(errors)}")
