"""Real adapters exercised against a mocked HTTP layer: request shape, response parsing, cost,
failover on vendor errors, and the auto / mock / live router modes. No network, no keys."""
import base64
import json
import subprocess

import httpx
import pytest

from xen_studio.router import default_router, real
from xen_studio.router.base import AllProvidersFailed

KEYS = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "STABILITY_API_KEY", "RESEND_API_KEY", "MODEL_ROUTER_MODE")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for k in KEYS:
        monkeypatch.delenv(k, raising=False)
    yield
    real.set_transport(None)


def tiny_png() -> bytes:
    return subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=0x334455:s=64x36", "-frames:v", "1", "-f", "image2", "-c:v", "png", "pipe:1"],
                          capture_output=True, check=True).stdout


def tiny_mp3() -> bytes:
    return subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=1", "-f", "mp3", "pipe:1"], capture_output=True, check=True).stdout


def openai_chat(content: dict, tokens=(100, 200)):
    return {"choices": [{"message": {"content": json.dumps(content)}}], "usage": {"prompt_tokens": tokens[0], "completion_tokens": tokens[1]}}


def test_no_keys_means_mocks_only():
    cat = default_router().catalog()
    assert {p["provider"] for ads in cat.values() for p in ads} == {"mock-primary", "mock-secondary"}


def test_openai_script_request_parse_and_cost(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    seen = {}

    def handler(req: httpx.Request):
        seen["url"], seen["auth"], seen["body"] = str(req.url), req.headers["authorization"], json.loads(req.content)
        return httpx.Response(200, json=openai_chat({"title": "Tunguska", "scenes": [{"narration": "In 1908 the sky split.", "visual": "a forest"},
                                                                                      {"narration": "Nobody knew why.", "visual": "scientists"}]}))
    real.set_transport(httpx.MockTransport(handler))
    r = default_router()
    out, used = r.call("llm", "write_script", language="en", prompt="Tunguska event", target_seconds=16, notes=[])
    assert seen["url"] == "https://api.openai.com/v1/chat/completions" and seen["auth"] == "Bearer sk-test"
    assert seen["body"]["response_format"] == {"type": "json_object"} and "16-second" in seen["body"]["messages"][1]["content"]
    assert out["title"] == "Tunguska" and len(out["scenes"]) == 2 and used.provider == "openai"
    assert used.cost_microusd == int(100 * 0.15 + 200 * 0.6)
    # with a key present, the mocks are not registered behind the real LLM
    assert [p["provider"] for p in r.catalog()["llm"]] == ["openai"]


def test_llm_fails_over_from_openai_to_anthropic(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "ak-test")

    def handler(req: httpx.Request):
        if "openai" in req.url.host:
            return httpx.Response(503)
        assert req.headers["x-api-key"] == "ak-test" and req.headers["anthropic-version"]
        return httpx.Response(200, json={"content": [{"type": "text", "text": 'Here you go: {"notes":[{"note":"a","source":"b"}]}'}],
                                         "usage": {"input_tokens": 10, "output_tokens": 10}})
    real.set_transport(httpx.MockTransport(handler))
    out, used = default_router().call("llm", "research", language="en", prompt="x")
    assert out == [{"note": "a", "source": "b"}] and used.provider == "anthropic" and used.attempts == 2


def test_malformed_model_output_is_a_provider_error(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    real.set_transport(httpx.MockTransport(lambda req: httpx.Response(200, json=openai_chat({"scenes": [{"narration": "only one"}]}))))
    with pytest.raises(AllProvidersFailed, match="fewer than two scenes"):
        default_router().call("llm", "write_script", language="en", prompt="x", target_seconds=20, notes=[])


def test_translate_keeps_line_count(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    real.set_transport(httpx.MockTransport(lambda req: httpx.Response(200, json=openai_chat({"lines": ["ایک", "دو"]}))))
    out, _ = default_router().call("llm", "translate", texts=["one", "two"], source="en", target="ur", glossary=[{"source": "Xen", "target": "Xen"}])
    assert out == ["ایک", "دو"]
    real.set_transport(httpx.MockTransport(lambda req: httpx.Response(200, json=openai_chat({"lines": ["ایک"]}))))
    with pytest.raises(AllProvidersFailed, match="different number of lines"):
        default_router().call("llm", "translate", texts=["one", "two"], source="en", target="ur", glossary=[])


def test_openai_moderation_blocks(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    real.set_transport(httpx.MockTransport(lambda req: httpx.Response(200, json={"results": [{"flagged": True, "categories": {"violence/graphic": True, "hate": False}}]})))
    out, used = default_router().call("moderation", "check", text="...")
    assert out == {"decision": "blocked", "reason": "violence_graphic"} and used.provider == "openai"


def test_elevenlabs_then_openai_tts_produce_wav(monkeypatch, tmp_path):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "el-test")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    mp3 = tiny_mp3()
    hosts = []

    def handler(req: httpx.Request):
        hosts.append(req.url.host)
        if req.url.host == "api.elevenlabs.io":
            assert req.headers["xi-api-key"] == "el-test" and json.loads(req.content)["model_id"] == "eleven_multilingual_v2"
            return httpx.Response(429)  # rate-limited: fail over
        return httpx.Response(200, content=mp3)
    real.set_transport(httpx.MockTransport(handler))
    out_path = str(tmp_path / "v.wav")
    _, used = default_router().call("tts", "speak", language="ur", text="سلام دنیا", voice="slt", out_path=out_path)
    assert hosts == ["api.elevenlabs.io", "api.openai.com"] and used.provider == "openai"
    assert open(out_path, "rb").read(4) == b"RIFF"


def test_generated_image_becomes_a_clip_of_the_right_length(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    png = base64.b64encode(tiny_png()).decode()
    real.set_transport(httpx.MockTransport(lambda req: httpx.Response(200, json={"data": [{"b64_json": png}]})))
    out_path = str(tmp_path / "c.mp4")
    _, used = default_router().call("visual", "render", visual_prompt="a forest", seed=1, seconds=2.0, width=320, height=180, out_path=out_path)
    from xen_studio.pipeline.media import probe
    assert used.provider == "openai" and 1900 <= probe(out_path)["duration_ms"] <= 2100


def test_live_mode_fails_loudly_without_keys(monkeypatch):
    monkeypatch.setenv("MODEL_ROUTER_MODE", "live")
    with pytest.raises(AllProvidersFailed, match="no provider registered"):
        default_router().call("llm", "research", language="en", prompt="x")


def test_mock_mode_ignores_keys(monkeypatch):
    monkeypatch.setenv("MODEL_ROUTER_MODE", "mock")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    assert default_router().catalog()["llm"][0]["provider"] == "mock-primary"


def test_network_error_is_retryable_failover(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re-test")
    def boom(req):
        raise httpx.ConnectTimeout("timeout")
    real.set_transport(httpx.MockTransport(boom))
    with pytest.raises(AllProvidersFailed, match="network error: ConnectTimeout"):
        default_router().call("email", "send", to="a@b.co", subject="s", body="b")
