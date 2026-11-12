import pytest

from xen_studio.router import Adapter, ModelRouter, ProviderError, default_router
from xen_studio.router.base import AllProvidersFailed


def make(fail_first: bool = True):
    calls = []
    def bad(**kw):
        calls.append("a")
        if fail_first:
            raise ProviderError("timeout")
        return "A", 1
    def good(**kw):
        calls.append("b")
        return "B", 2
    now = [0.0]
    r = ModelRouter(threshold=2, cooldown_s=30, clock=lambda: now[0])
    r.register(Adapter("a", "llm", "m1", {"op": bad}))
    r.register(Adapter("b", "llm", "m2", {"op": good}))
    return r, calls, now


def test_fails_over_and_reports_which_provider_served_the_call():
    r, calls, _ = make()
    result, used = r.call("llm", "op")
    assert result == "B" and used.provider == "b" and used.model == "m2" and used.cost_microusd == 2 and used.attempts == 2
    assert calls == ["a", "b"]


def test_breaker_skips_a_failing_provider_then_probes_after_cooldown():
    r, calls, now = make()
    r.call("llm", "op"); r.call("llm", "op")          # two failures open the breaker for "a"
    calls.clear()
    _, used = r.call("llm", "op")
    assert calls == ["b"] and used.attempts == 1       # "a" is not even tried
    assert any(e["provider"] == "a" and not e["healthy"] for e in r.health_events)
    now[0] = 31                                        # cooldown elapsed: "a" gets a probe
    calls.clear()
    r.call("llm", "op")
    assert calls == ["a", "b"]


def test_all_providers_failing_raises_with_every_error():
    r = ModelRouter()
    def boom(**kw):
        raise ProviderError("quota exceeded")
    r.register(Adapter("a", "tts", "m", {"speak": boom}))
    r.register(Adapter("b", "tts", "m", {"speak": boom}))
    with pytest.raises(AllProvidersFailed) as e:
        r.call("tts", "speak")
    assert "a: quota exceeded" in str(e.value) and "b: quota exceeded" in str(e.value)


def test_language_routing_skips_providers_that_do_not_support_the_language():
    r = ModelRouter()
    r.register(Adapter("en-only", "tts", "m", {"speak": lambda language, **kw: ("en", 1)}, languages={"en"}))
    r.register(Adapter("multi", "tts", "m", {"speak": lambda language, **kw: ("multi", 1)}))
    assert r.call("tts", "speak", language="ur")[1].provider == "multi"
    assert r.call("tts", "speak", language="en")[1].provider == "en-only"


def test_every_capability_has_at_least_two_adapters():
    cat = default_router().catalog()
    assert set(cat) == {"moderation", "llm", "tts", "visual", "qc", "email", "push"}
    assert all(len(v) >= 2 for v in cat.values())


def test_mock_failover_via_env(monkeypatch):
    monkeypatch.setenv("XEN_MOCK_FAIL", "moderation:mock-primary")
    result, used = default_router().call("moderation", "check", text="a calm video about rivers")
    assert result["decision"] == "allowed" and used.provider == "mock-secondary"


def test_mock_moderation_blocks_policy_violations():
    result, _ = default_router().call("moderation", "check", text="Explain how to make a bomb at home")
    assert result == {"decision": "blocked", "reason": "violence"}
