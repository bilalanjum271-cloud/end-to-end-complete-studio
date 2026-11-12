"""Real provider adapters. Each one is enabled only when its API key is in the environment;
nothing here runs without keys. All HTTP goes through one httpx.Client so tests can inject a
mock transport and so timeouts are uniform.

Capability  Providers (priority order)            Keys
llm         OpenAI, Anthropic                     OPENAI_API_KEY, ANTHROPIC_API_KEY
moderation  OpenAI moderation                     OPENAI_API_KEY
tts         ElevenLabs, OpenAI TTS                ELEVENLABS_API_KEY, OPENAI_API_KEY
visual      OpenAI Images, Stability AI           OPENAI_API_KEY, STABILITY_API_KEY
email       Resend                                RESEND_API_KEY (+ EMAIL_FROM)

Model names and per-unit prices are configurable (XEN_<PROVIDER>_MODEL, XEN_PRICE_*), because both change often.
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
from typing import Any, Callable

import httpx

from .base import Adapter, ProviderError

TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=5.0)
_client: httpx.Client | None = None


def client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=TIMEOUT)
    return _client


def set_transport(transport: httpx.BaseTransport | None) -> None:
    """Tests inject httpx.MockTransport here."""
    global _client
    _client = httpx.Client(timeout=TIMEOUT, transport=transport) if transport else None


def _env(name: str, default: str) -> str:
    return os.environ.get(name) or default


def _price(name: str, default: float) -> float:
    return float(os.environ.get(name, default))


def _post(url: str, *, headers: dict, json_body: dict | None = None, files: Any = None, data: Any = None) -> httpx.Response:
    try:
        res = client().post(url, headers=headers, json=json_body, files=files, data=data)
    except httpx.HTTPError as err:  # timeouts, DNS, resets: another provider may succeed
        raise ProviderError(f"network error: {err.__class__.__name__}") from err
    if res.status_code == 429 or res.status_code >= 500:
        raise ProviderError(f"HTTP {res.status_code}")
    if res.status_code >= 400:
        # 4xx is usually our request or the account (bad key, no quota); still fail over, but say so clearly.
        raise ProviderError(f"HTTP {res.status_code}: {res.text[:200]}")
    return res


# ── LLM: one JSON-in / JSON-out contract, two vendors ───────────────────────────

SYSTEM = ("You are the writing engine of Xen Studio, a video production platform. Write original, factual, engaging narration "
          "for short-form and documentary video. Never invent quotes or statistics; when unsure, speak generally. "
          "Reply with JSON only, matching the requested shape exactly.")


def _openai_json(prompt: str) -> tuple[dict, int]:
    key = os.environ["OPENAI_API_KEY"]
    res = _post("https://api.openai.com/v1/chat/completions", headers={"Authorization": f"Bearer {key}"}, json_body={
        "model": _env("XEN_OPENAI_MODEL", "gpt-4o-mini"), "response_format": {"type": "json_object"}, "temperature": 0.7,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]})
    body = res.json()
    usage = body.get("usage", {})
    cost = usage.get("prompt_tokens", 0) * _price("XEN_PRICE_OPENAI_IN_MICRO", 0.15) + usage.get("completion_tokens", 0) * _price("XEN_PRICE_OPENAI_OUT_MICRO", 0.6)
    return _parse(body["choices"][0]["message"]["content"]), int(cost)


def _anthropic_json(prompt: str) -> tuple[dict, int]:
    key = os.environ["ANTHROPIC_API_KEY"]
    res = _post("https://api.anthropic.com/v1/messages", headers={"x-api-key": key, "anthropic-version": "2023-06-01"}, json_body={
        "model": _env("XEN_ANTHROPIC_MODEL", "claude-sonnet-4-5"), "max_tokens": 4096, "system": SYSTEM,
        "messages": [{"role": "user", "content": prompt}]})
    body = res.json()
    text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
    usage = body.get("usage", {})
    cost = usage.get("input_tokens", 0) * _price("XEN_PRICE_ANTHROPIC_IN_MICRO", 3.0) + usage.get("output_tokens", 0) * _price("XEN_PRICE_ANTHROPIC_OUT_MICRO", 15.0)
    return _parse(text), int(cost)


def _parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ProviderError("model did not return JSON")
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError as err:
        raise ProviderError("model returned malformed JSON") from err


def _require(obj: dict, key: str, kind: type) -> Any:
    v = obj.get(key)
    if not isinstance(v, kind) or (kind in (list, str) and not v):
        raise ProviderError(f"model output is missing '{key}'")
    return v


def llm_methods(ask: Callable[[str], tuple[dict, int]]) -> dict[str, Callable]:
    def research(prompt: str, language: str):
        out, cost = ask(f"Topic request: {prompt!r}\nList 3 to 6 short research notes a scriptwriter needs (background, key facts, common misconceptions). "
                        'Shape: {"notes":[{"note":"...","source":"name of a reputable source type or publication"}]}')
        notes = _require(out, "notes", list)
        return [{"note": str(n.get("note", ""))[:500], "source": str(n.get("source", ""))[:200]} for n in notes if isinstance(n, dict)], cost

    def write_script(prompt: str, language: str, target_seconds: int, notes: list, feedback: str = "", version: int = 1):
        n = max(2, min(12, round(target_seconds / 8)))
        words = int(target_seconds * 2.3)
        out, cost = ask(
            f"Write a {target_seconds}-second video script in language '{language}' for: {prompt!r}.\n"
            f"Research notes: {json.dumps(notes)[:3000]}\n" + (f"The user asked for these changes to the previous draft: {feedback!r}\n" if feedback else "") +
            f"Exactly {n} scenes, about {words} spoken words in total. Open with a hook in scene 1; end with a payoff. "
            "Each scene: narration (spoken text only) and visual (one sentence describing the image to show, in English). "
            'Shape: {"title":"...","scenes":[{"narration":"...","visual":"..."}]}')
        scenes = _require(out, "scenes", list)
        clean = [{"narration": str(s["narration"]).strip()[:2000], "visual": str(s.get("visual", "")).strip()[:500]} for s in scenes if isinstance(s, dict) and s.get("narration")]
        if len(clean) < 2:
            raise ProviderError("model returned fewer than two scenes")
        return {"title": str(out.get("title") or prompt)[:80], "scenes": clean, "language": language}, cost

    def rewrite_scene(narration: str, feedback: str, language: str):
        out, cost = ask(f"Rewrite this narration in language '{language}', keeping length and meaning, applying: {feedback!r}.\n"
                        f"Narration: {narration!r}\n" + 'Shape: {"narration":"..."}')
        return {"narration": str(_require(out, "narration", str))[:2000]}, cost

    def package(title: str, narration: str, language: str):
        out, cost = ask(f"Video title: {title!r}. Opening line: {narration!r}. Language: {language}.\n"
                        "Write publish metadata for YouTube/TikTok/Instagram: 3 title options (under 70 characters, no clickbait lies), "
                        "a 2-3 sentence description that ends with 'This video contains AI-generated content.', and 8-12 lowercase tags. "
                        'Shape: {"titles":["..."],"description":"...","tags":["..."]}')
        return {"titles": [str(t)[:100] for t in _require(out, "titles", list)][:3], "description": str(_require(out, "description", str))[:2000],
                "tags": [str(t).lower()[:40] for t in _require(out, "tags", list)][:12]}, cost

    def adapt(text: str, language: str, target_seconds: int, title_hint: str = ""):
        n = max(2, min(12, round(target_seconds / 8)))
        out, cost = ask(f"Turn this source text, which the user owns, into a {target_seconds}-second animated video script in language '{language}'. "
                        "Keep its facts and voice; do not add claims that are not in the text. "
                        f"Exactly {n} scenes, about {int(target_seconds * 2.3)} spoken words in total. Each scene: narration and visual (one English sentence describing the animated shot).\n"
                        f"Source text: {text[:12000]!r}\n" + 'Shape: {"title":"...","scenes":[{"narration":"...","visual":"..."}]}')
        scenes = [{"narration": str(x["narration"])[:2000], "visual": str(x.get("visual", ""))[:500]} for x in _require(out, "scenes", list) if isinstance(x, dict) and x.get("narration")]
        if len(scenes) < 2:
            raise ProviderError("model returned fewer than two scenes")
        return {"title": str(out.get("title") or title_hint or "Untitled")[:80], "scenes": scenes, "language": language}, cost

    def translate(texts: list[str], source: str, target: str, glossary: list[dict]):
        terms = "; ".join(f"{g['source']} -> {g['target']}" for g in glossary) or "none"
        out, cost = ask(f"Translate these narration lines from '{source}' to '{target}' for natural spoken voice-over (adapt idioms, keep meaning and length). "
                        f"Always use these glossary terms exactly: {terms}.\nLines: {json.dumps(texts, ensure_ascii=False)}\n"
                        'Shape: {"lines":["..."]} with the same number of lines in the same order.')
        lines = _require(out, "lines", list)
        if len(lines) != len(texts):
            raise ProviderError("translation returned a different number of lines")
        return [str(x)[:2000] for x in lines], cost

    return {"research": research, "write_script": write_script, "rewrite_scene": rewrite_scene, "package": package, "translate": translate, "adapt": adapt}


# ── moderation ─────────────────────────────────────────────────────────────────

def openai_moderation(text: str):
    key = os.environ["OPENAI_API_KEY"]
    res = _post("https://api.openai.com/v1/moderations", headers={"Authorization": f"Bearer {key}"},
                json_body={"model": _env("XEN_OPENAI_MODERATION_MODEL", "omni-moderation-latest"), "input": text[:30000]})
    r = res.json()["results"][0]
    flagged = [k for k, v in r.get("categories", {}).items() if v]
    return ({"decision": "blocked", "reason": flagged[0].replace("/", "_")} if r.get("flagged") else {"decision": "allowed", "reason": ""}), 0


# ── speech ─────────────────────────────────────────────────────────────────────

def _to_wav(audio: bytes, out_path: str) -> None:
    proc = subprocess.run(["ffmpeg", "-y", "-i", "pipe:0", "-ar", "44100", "-ac", "2", out_path], input=audio, capture_output=True, timeout=120)
    if proc.returncode != 0:
        raise ProviderError("could not decode synthesized audio")


def elevenlabs_tts(text: str, language: str, voice: str, out_path: str):
    key = os.environ["ELEVENLABS_API_KEY"]
    voice_id = voice if voice and voice != "slt" else _env("XEN_ELEVENLABS_VOICE", "21m00Tcm4TlvDq8ikWAM")
    res = _post(f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128", headers={"xi-api-key": key},
                json_body={"text": text, "model_id": _env("XEN_ELEVENLABS_MODEL", "eleven_multilingual_v2"), "language_code": language})
    _to_wav(res.content, out_path)
    return {"path": out_path, "synthetic_speech": True}, int(len(text) * _price("XEN_PRICE_ELEVENLABS_CHAR_MICRO", 180))


def openai_tts(text: str, language: str, voice: str, out_path: str):
    key = os.environ["OPENAI_API_KEY"]
    res = _post("https://api.openai.com/v1/audio/speech", headers={"Authorization": f"Bearer {key}"},
                json_body={"model": _env("XEN_OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), "voice": _env("XEN_OPENAI_VOICE", "alloy"), "input": text, "response_format": "mp3"})
    _to_wav(res.content, out_path)
    return {"path": out_path, "synthetic_speech": True}, int(len(text) * _price("XEN_PRICE_OPENAI_TTS_CHAR_MICRO", 15))


# ── visuals: a generated still per scene, animated with a slow push-in ──────────

def _still_to_clip(image: bytes, seconds: float, width: int, height: int, out_path: str) -> None:
    frames = max(24, int(seconds * 24))
    vf = (f"scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,crop={width * 2}:{height * 2},"
          f"zoompan=z='min(zoom+0.0008,1.12)':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps=24")
    proc = subprocess.run(["ffmpeg", "-y", "-i", "pipe:0", "-vf", vf, "-frames:v", str(frames), "-c:v", "libx264", "-preset", "veryfast",
                           "-pix_fmt", "yuv420p", out_path], input=image, capture_output=True, timeout=300)
    if proc.returncode != 0:
        raise ProviderError("could not animate the generated image")


STYLE = "cinematic documentary still, natural light, photorealistic, no text, no watermark"


def _styled(visual_prompt: str, style: dict | None) -> str:
    return f"{visual_prompt}. {style['look']}" if style and style.get("look") else f"{visual_prompt}. {STYLE}"


def openai_image(visual_prompt: str, seed: int, seconds: float, width: int, height: int, out_path: str, style: dict | None = None):
    key = os.environ["OPENAI_API_KEY"]
    res = _post("https://api.openai.com/v1/images/generations", headers={"Authorization": f"Bearer {key}"}, json_body={
        "model": _env("XEN_OPENAI_IMAGE_MODEL", "gpt-image-1"), "prompt": _styled(visual_prompt, style), "size": "1536x1024" if width >= height else "1024x1536", "n": 1})
    _still_to_clip(base64.b64decode(res.json()["data"][0]["b64_json"]), seconds, width, height, out_path)
    return {"path": out_path}, int(_price("XEN_PRICE_OPENAI_IMAGE_MICRO", 63_000))


def stability_image(visual_prompt: str, seed: int, seconds: float, width: int, height: int, out_path: str, style: dict | None = None):
    key = os.environ["STABILITY_API_KEY"]
    res = _post("https://api.stability.ai/v2beta/stable-image/generate/core", headers={"Authorization": f"Bearer {key}", "Accept": "image/*"},
                files={"none": ""}, data={"prompt": _styled(visual_prompt, style), "aspect_ratio": "16:9" if width >= height else "9:16",
                                          "seed": str(seed % 4294967294), "output_format": "png"})
    _still_to_clip(res.content, seconds, width, height, out_path)
    return {"path": out_path}, int(_price("XEN_PRICE_STABILITY_IMAGE_MICRO", 30_000))


# ── email ──────────────────────────────────────────────────────────────────────

def resend_email(to: str, subject: str, body: str):
    key = os.environ["RESEND_API_KEY"]
    if not to:
        raise ProviderError("no recipient")
    res = _post("https://api.resend.com/emails", headers={"Authorization": f"Bearer {key}"}, json_body={
        "from": _env("EMAIL_FROM", "Xen Studio <notifications@example.com>"), "to": [to], "subject": subject, "text": body})
    return {"accepted": True, "id": res.json().get("id", "")}, 100


# ── text to 3D (Meshy: create a preview task, poll, download the GLB) ───────────

def meshy_text_to_3d(prompt: str, out_path: str, poll_s: float = 5.0, timeout_s: float = 600.0):
    import time as _time
    key = os.environ["MESHY_API_KEY"]
    h = {"Authorization": f"Bearer {key}"}
    task = _post("https://api.meshy.ai/openapi/v2/text-to-3d", headers=h, json_body={"mode": "preview", "prompt": prompt[:600], "art_style": "realistic", "should_remesh": True}).json()
    task_id = task.get("result")
    if not task_id:
        raise ProviderError("Meshy did not return a task id")
    deadline = _time.monotonic() + timeout_s
    while _time.monotonic() < deadline:
        try:
            st = client().get(f"https://api.meshy.ai/openapi/v2/text-to-3d/{task_id}", headers=h).json()
        except httpx.HTTPError as err:
            raise ProviderError(f"network error: {err.__class__.__name__}") from err
        if st.get("status") == "SUCCEEDED":
            glb = client().get(st["model_urls"]["glb"])
            if glb.status_code >= 400:
                raise ProviderError("could not download the generated model")
            with open(out_path, "wb") as f:
                f.write(glb.content)
            from ..xr.glb import read_glb
            read_glb(out_path)  # reject anything that is not a valid GLB before it reaches a customer
            return {"path": out_path, "kind": "generated", "triangles": 0, "bounds": None}, int(_price("XEN_PRICE_MESHY_MICRO", 200_000))
        if st.get("status") in ("FAILED", "CANCELED", "EXPIRED"):
            raise ProviderError(f"Meshy task {st.get('status', '').lower()}")
        _time.sleep(poll_s)
    raise ProviderError("Meshy task timed out")


# ── link ingestion (no key; enabled with INGEST_ALLOW_NETWORK=1) ───────────────

def web_ingest(url: str):
    try:
        res = client().get(url, headers={"User-Agent": "XenStudioBot/1.0 (+rights-attested ingestion)"}, follow_redirects=True)
    except httpx.HTTPError as err:
        raise ProviderError(f"could not fetch the link: {err.__class__.__name__}") from err
    if res.status_code >= 400:
        raise ProviderError(f"the link returned HTTP {res.status_code}")
    if "html" not in res.headers.get("content-type", "") and "text" not in res.headers.get("content-type", ""):
        raise ProviderError("only web pages and text can be ingested; upload video and audio files instead")
    html = res.text[:2_000_000]
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    paras = re.findall(r"<p[^>]*>(.*?)</p>", html, re.S | re.I)
    text = " ".join(re.sub(r"<[^>]+>", "", p).strip() for p in paras)
    text = re.sub(r"\s+", " ", re.sub(r"&[a-z#0-9]+;", " ", text)).strip()
    return {"title": re.sub(r"\s+", " ", title.group(1)).strip()[:80] if title else "", "text": text[:20000]}, 0


# ── registry ───────────────────────────────────────────────────────────────────

def real_adapters() -> list[Adapter]:
    has = lambda k: bool(os.environ.get(k))  # noqa: E731
    out: list[Adapter] = []
    if has("OPENAI_API_KEY"):
        out += [Adapter("openai", "llm", _env("XEN_OPENAI_MODEL", "gpt-4o-mini"), llm_methods(_openai_json)),
                Adapter("openai", "moderation", "omni-moderation-latest", {"check": openai_moderation})]
    if has("ANTHROPIC_API_KEY"):
        out.append(Adapter("anthropic", "llm", _env("XEN_ANTHROPIC_MODEL", "claude-sonnet-4-5"), llm_methods(_anthropic_json)))
    if has("ELEVENLABS_API_KEY"):
        out.append(Adapter("elevenlabs", "tts", _env("XEN_ELEVENLABS_MODEL", "eleven_multilingual_v2"), {"speak": elevenlabs_tts}))
    if has("OPENAI_API_KEY"):
        out += [Adapter("openai", "tts", _env("XEN_OPENAI_TTS_MODEL", "gpt-4o-mini-tts"), {"speak": openai_tts}),
                Adapter("openai", "visual", _env("XEN_OPENAI_IMAGE_MODEL", "gpt-image-1"), {"render": openai_image})]
    if has("STABILITY_API_KEY"):
        out.append(Adapter("stability", "visual", "stable-image-core", {"render": stability_image}))
    if has("MESHY_API_KEY"):
        out.append(Adapter("meshy", "3d", "meshy-text-to-3d", {"generate": meshy_text_to_3d}))
    if os.environ.get("INGEST_ALLOW_NETWORK") == "1":
        out.append(Adapter("web", "ingest", "html-reader", {"fetch": web_ingest}))
    if has("RESEND_API_KEY"):
        out.append(Adapter("resend", "email", "resend", {"send": resend_email}))
    return out
