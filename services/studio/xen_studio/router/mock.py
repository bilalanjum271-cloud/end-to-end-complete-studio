"""Mock providers. They let the whole platform run with no API keys, deterministically.

Two mock providers are registered per capability so failover is always exercised the same
way it will be with real vendors. Set XEN_MOCK_FAIL="llm:mock-primary,tts:mock-primary"
to make a provider raise ProviderError (used by tests and chaos drills).

What the mocks really do:
  moderation  keyword policy check
  llm         template-based research notes and scripts (no language model)
  tts         local speech synthesis with FFmpeg's flite voice (English); a tone bed if flite is unavailable
  visual      a title-card clip rendered with FFmpeg from the scene's visual prompt and seed
  qc          structural checks with ffprobe (streams present, duration matches)
"""
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import textwrap

from .base import Adapter, ModelRouter, ProviderError

BLOCKED_TERMS = {
    "violence": ["how to make a bomb", "build a bomb", "kill my", "school shooting"],
    "sexual_minors": ["child porn", "underage sex"],
    "hate": ["ethnic cleansing guide", "gas the"],
    "real_person_deepfake": ["deepfake of", "fake video of the president"],
}


def _maybe_fail(capability: str, provider: str) -> None:
    if f"{capability}:{provider}" in os.environ.get("XEN_MOCK_FAIL", "").split(","):
        raise ProviderError(f"{provider} is unavailable (simulated)")


def _moderate(provider: str):
    def check(text: str):
        _maybe_fail("moderation", provider)
        low = text.lower()
        for reason, terms in BLOCKED_TERMS.items():
            if any(t in low for t in terms):
                return {"decision": "blocked", "reason": reason}, 20
        return {"decision": "allowed", "reason": ""}, 20
    return check


def _topic(prompt: str) -> str:
    t = re.sub(r"\s+", " ", prompt.strip().rstrip(".!?"))
    t = re.sub(r"^(please\s+)?((make|create|write|generate|produce)\s+)?(me\s+)?((a|an|the)\s+)?((short|quick|brief|long)\s+)?"
               r"(video|documentary|script|film|explainer|story)\s+(about|on|of|explaining)\s+", "", t, flags=re.I)
    t = re.split(r",\s*(told|narrated|explained|in the style|as a)\b", t, maxsplit=1, flags=re.I)[0]
    return t[:120].strip() or "this topic"


def _llm(provider: str):
    def research(prompt: str, language: str):
        _maybe_fail("llm", provider)
        topic = _topic(prompt)
        return [
            {"note": f"Working definition and scope of {topic}.", "source": "mock://research/overview"},
            {"note": f"Key dates and figures connected to {topic}.", "source": "mock://research/timeline"},
            {"note": f"The most common misconception about {topic}.", "source": "mock://research/misconceptions"},
        ], 900

    def write_script(prompt: str, language: str, target_seconds: int, notes: list, feedback: str = "", version: int = 1):
        _maybe_fail("llm", provider)
        topic = _topic(prompt)
        n = max(2, min(12, round(target_seconds / 8)))
        words = max(8, int(target_seconds / n * 2.3))  # ~2.3 spoken words per second
        beats = [
            ("Hook", f"What if everything you assumed about {topic} was only half the story?"),
            ("Setup", f"To understand {topic}, we have to go back to where it really began."),
            ("Turn", f"Then something changed, and {topic} was never seen the same way again."),
            ("Evidence", f"The record is clear. Look closely at {topic} and a pattern appears."),
            ("Stakes", f"This matters, because {topic} still shapes decisions being made today."),
            ("Twist", f"But the most surprising part of {topic} is the part almost nobody mentions."),
            ("Payoff", f"So the next time you hear about {topic}, you will know what sits underneath."),
        ]
        scenes = []
        for i in range(n):
            label, line = beats[-1] if i == n - 1 else beats[min(i, len(beats) - 2)]
            fillers = [f"Here is the part of {topic} that matters most.", "Take it one step at a time.", "The details are simpler than they look.",
                       "Keep this in mind for what comes next.", "It changes how the rest of the story reads."]
            narration = line
            for extra in fillers[i % len(fillers):] + fillers[:i % len(fillers)]:  # whole sentences only, up to the scene's word budget
                if len((narration + " " + extra).split()) > words:
                    break
                narration += " " + extra
            if feedback:
                label = f"{label} (revised)"
            scenes.append({"narration": narration, "visual": f"{label}: {topic}"})
        title = topic[:1].upper() + topic[1:]
        return {"title": title[:80], "scenes": scenes, "language": language}, 2400 * n

    def rewrite_scene(narration: str, feedback: str, language: str):
        _maybe_fail("llm", provider)
        lead = "Put simply," if "simpl" in feedback.lower() else "Look again:"
        return {"narration": f"{lead} {narration[0].lower()}{narration[1:]}"}, 600

    def package(title: str, narration: str, language: str):
        _maybe_fail("llm", provider)
        topic = title.rstrip(".")
        words = [w.strip(".,?!").lower() for w in topic.split() if len(w.strip(".,?!")) > 3]
        tags = list(dict.fromkeys(words + ["documentary", "explained", "history"]))[:10]
        low = topic[0].lower() + topic[1:]
        first = re.split(r"(?<=[.?!])\s", narration.strip())[0]
        return {"titles": [f"The Truth About {low}", f"{topic}: What Really Happened", f"Why {low} Still Matters"],
                "description": f"{first} A short, clear look at {low}.\n\nMade with Xen Studio. This video contains AI-generated content.",
                "tags": tags}, 500

    def adapt(text: str, language: str, target_seconds: int, title_hint: str = ""):
        """Mock adaptation: splits the user's own text into scenes by sentence, trimmed to the target length.
        A real LLM rewrites it for narration; the mock never invents content."""
        _maybe_fail("llm", provider)
        sentences = [x.strip() for x in re.split(r"(?<=[.!?۔])\s+", re.sub(r"\s+", " ", text.strip())) if x.strip()]
        budget = int(target_seconds * 2.3)
        kept, words = [], 0
        for x in sentences:
            if kept and words + len(x.split()) > budget:
                break
            kept.append(x)
            words += len(x.split())
        n = max(2, min(12, round(target_seconds / 8), len(kept)))
        n = min(n, len(kept)) if len(kept) >= 2 else 2
        if len(kept) < 2:
            kept = (kept or [text[:200] or "Untitled."]) + ["The end."]
        groups = [kept[i * len(kept) // n:(i + 1) * len(kept) // n] for i in range(n)]
        scenes = [{"narration": " ".join(g), "visual": " ".join(g)[:160]} for g in groups if g]
        title = title_hint or sentences[0][:60] if sentences else "Untitled"
        return {"title": title.rstrip(".")[:80], "scenes": scenes, "language": language}, 1500 * len(scenes)

    def translate(texts: list[str], source: str, target: str, glossary: list[dict]):
        """Mock translation: cannot translate, so it applies the glossary and tags each line with the target language.
        Real translation needs an LLM key."""
        _maybe_fail("llm", provider)
        out = []
        for t in texts:
            for g in glossary:
                t = re.sub(re.escape(g["source"]), g["target"], t, flags=re.I)
            out.append(f"[{target}] {t}")
        return out, 300 * len(texts)

    return {"research": research, "write_script": write_script, "rewrite_scene": rewrite_scene, "package": package, "translate": translate, "adapt": adapt}


def _has_flite() -> bool:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
    return " flite " in out


def _tts(provider: str):
    def speak(text: str, language: str, voice: str, out_path: str):
        _maybe_fail("tts", provider)
        seconds = max(1.5, len(text.split()) / 2.3)
        if language == "en" and _has_flite():
            clean = re.sub(r"[^A-Za-z0-9 ,.?!'-]", " ", text)
            textfile = out_path + ".txt"
            with open(textfile, "w") as f:
                f.write(clean)
            cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"flite=textfile={textfile}:voice={voice or 'slt'}", "-ar", "44100", "-ac", "2", out_path]
        else:
            # No local voice for this language: a quiet tone bed of the right length stands in for narration.
            cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds:.2f}", "-af", "volume=0.15", "-ar", "44100", "-ac", "2", out_path]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise ProviderError(f"tts synthesis failed: {proc.stderr.strip()[-200:]}")
        return {"path": out_path, "synthetic_speech": cmd[4].startswith("flite")}, int(len(text) * 30)
    return speak


PALETTE = ["0x10161d", "0x161b26", "0x1a1f1c", "0x1d1a22", "0x201c18", "0x14201f"]


def _visual(provider: str):
    def render(visual_prompt: str, seed: int, seconds: float, width: int, height: int, out_path: str, style: dict | None = None):
        _maybe_fail("visual", provider)
        color = PALETTE[seed % len(PALETTE)]
        accent = ["0x46d6a0", "0x7fb4ff", "0xf2b84b"][seed % 3]
        if style and style.get("palette"):
            return _animated(visual_prompt, seed, seconds, width, height, out_path, style["palette"])
        caption = "\n".join(textwrap.wrap(re.sub(r"[^A-Za-z0-9 ,.?!()-]", "", visual_prompt), 34)[:4])
        capfile = out_path + ".txt"
        with open(capfile, "w") as f:
            f.write(caption)
        vf = (f"drawbox=x=0:y=ih-8:w=iw*t/{seconds:.3f}:h=8:color={accent}@0.9:t=fill,"
              f"drawtext=textfile={capfile}:fontcolor=white:fontsize={height // 14}:line_spacing=14:x=(w-text_w)/2:y=(h-text_h)/2")
        proc = subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c={color}:s={width}x{height}:r=24:d={seconds:.3f}",
                               "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", out_path],
                              capture_output=True, text=True, timeout=180)
        if proc.returncode != 0:
            raise ProviderError(f"visual render failed: {proc.stderr.strip()[-200:]}")
        return {"path": out_path}, int(seconds * 40_000)
    return render


def _animated(visual_prompt: str, seed: int, seconds: float, width: int, height: int, out_path: str, palette: list[str]):
    """Mock animation: the style's palette with shapes drifting across the frame and the scene caption.
    Stands in for a real image or video model; motion and colors follow the style profile."""
    bg, a1, a2 = (palette + palette)[:3]
    caption = "\n".join(textwrap.wrap(re.sub(r"[^A-Za-z0-9 ,.?!()-]", "", visual_prompt), 34)[:3])
    capfile = out_path + ".txt"
    with open(capfile, "w") as f:
        f.write(caption)
    s = seconds
    off = seed % 97
    vf = (f"drawbox=x='mod(t*{90 + off}+{off * 7},iw+200)-200':y=ih*0.18:w=200:h=200:color={a1}@0.85:t=fill,"
          f"drawbox=x='iw-mod(t*{60 + off}+{off * 3},iw+300)':y=ih*0.58:w=300:h=120:color={a2}@0.7:t=fill,"
          f"drawbox=x=0:y=ih-8:w=iw*t/{s:.3f}:h=8:color={a1}@0.9:t=fill,"
          f"drawtext=textfile={capfile}:fontcolor=white:fontsize={height // 16}:line_spacing=12:x=(w-text_w)/2:y=h*0.42:box=1:boxcolor=black@0.35:boxborderw=16")
    proc = subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c={bg}:s={width}x{height}:r=24:d={s:.3f}", "-vf", vf,
                           "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", out_path], capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise ProviderError(f"animation render failed: {proc.stderr.strip()[-200:]}")
    return {"path": out_path}, int(seconds * 50_000)


MOODS = {"calm": (220.0, 277.18, 329.63), "uplifting": (261.63, 329.63, 392.0), "tense": (196.0, 233.08, 277.18)}


def _music(provider: str):
    def compose(seconds: float, mood: str, out_path: str):
        """Mock music: a soft three-note pad in the mood's chord with a slow swell. Stands in for a music model."""
        _maybe_fail("music", provider)
        f1, f2, f3 = MOODS.get(mood, MOODS["calm"])
        expr = f"0.18*(sin(2*PI*{f1}*t)+0.8*sin(2*PI*{f2}*t)+0.6*sin(2*PI*{f3}*t))*(0.6+0.4*sin(2*PI*t/8))"
        proc = subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"aevalsrc={expr}:s=44100:d={seconds:.2f}", "-af", "afade=t=in:d=1.5,lowpass=f=1800",
                               "-ac", "2", out_path], capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise ProviderError("music render failed")
        return {"path": out_path}, int(seconds * 1000)
    return compose


PUBLISHER_HOSTS = ("netflix.com", "disneyplus.com", "hbomax.com", "max.com", "primevideo.com", "hulu.com", "spotify.com",
                   "music.apple.com", "crunchyroll.com", "paramountplus.com", "peacocktv.com")


def _rights(provider: str):
    def check(url: str, text: str):
        """Mock copyright screen: links to major commercial catalogs are held for human review; everything else is
        cleared on the user's ownership attestation. A real adapter calls a fingerprinting / content-ID vendor."""
        _maybe_fail("rights", provider)
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
        if any(host == h or host.endswith("." + h) for h in PUBLISHER_HOSTS):
            return {"result": "needs_review", "reason": f"{host} hosts commercially licensed media"}, 50
        if not text.strip():
            return {"result": "rejected", "reason": "no readable content at the link"}, 50
        return {"result": "clear", "reason": "owner attestation on file; no catalog match"}, 50
    return check


def _ingest(provider: str):
    def fetch(url: str):
        """Mock ingestion: deterministic article text derived from the URL (no network)."""
        _maybe_fail("ingest", provider)
        from urllib.parse import urlparse
        u = urlparse(url)
        topic = re.sub(r"[-_/]+", " ", (u.path or "").strip("/")).strip() or (u.hostname or "this page")
        return {"title": topic[:80].title(), "text": (f"This story is about {topic}. It begins with a simple question. "
                f"The people involved had no idea how far it would go. Step by step, the answer became clear. "
                f"In the end, {topic} changed the way they worked. And that is why it is worth telling.")}, 100
    return fetch


def _qc(provider: str):
    def score(path: str, expected_ms: int):
        _maybe_fail("qc", provider)
        from ..pipeline.media import probe
        info = probe(path)
        kinds = {s["codec_type"] for s in info["streams"]}
        drift = abs(info["duration_ms"] - expected_ms) / max(expected_ms, 1)
        s = 1.0
        if "video" not in kinds:
            s -= 0.6
        if "audio" not in kinds:
            s -= 0.3
        s -= min(0.4, drift)
        fingerprint = int(hashlib.sha256(path.encode()).hexdigest()[:2], 16) / 255 * 0.05
        return {"score": round(max(0.0, s - fingerprint), 3), "duration_ms": info["duration_ms"]}, 300
    return score


def _notify(provider: str, channel: str):
    def send(to: str, subject: str, body: str):
        _maybe_fail(channel, provider)
        return {"accepted": True, "to": to}, 10  # a real adapter calls the email / push vendor here
    return send


def _three_d(provider: str):
    def generate(prompt: str, out_path: str):
        _maybe_fail("3d", provider)
        from ..xr.generate import compose
        from ..xr.glb import write_glb
        kind, parts = compose(prompt)
        info = write_glb(parts, out_path, name=kind)
        return {"path": out_path, "kind": kind, **info}, 20_000
    return generate


def mock_adapters() -> list[Adapter]:
    out = []
    for name in ("mock-primary", "mock-secondary"):
        out += [Adapter(name, "moderation", "mock-policy-1", {"check": _moderate(name)}),
                Adapter(name, "llm", "mock-writer-1", _llm(name)),
                Adapter(name, "tts", "mock-flite-1", {"speak": _tts(name)}),
                Adapter(name, "visual", "mock-titlecard-1", {"render": _visual(name)}),
                Adapter(name, "qc", "mock-probe-1", {"score": _qc(name)}),
                Adapter(name, "email", "mock-smtp-1", {"send": _notify(name, "email")}),
                Adapter(name, "push", "mock-push-1", {"send": _notify(name, "push")}),
                Adapter(name, "music", "mock-pad-1", {"compose": _music(name)}),
                Adapter(name, "rights", "mock-catalog-1", {"check": _rights(name)}),
                Adapter(name, "ingest", "mock-reader-1", {"fetch": _ingest(name)}),
                Adapter(name, "3d", "mock-primitives-1", {"generate": _three_d(name)})]
    return out


def default_router() -> ModelRouter:
    """MODEL_ROUTER_MODE:
      auto (default)  each capability uses its real providers when keys are set, otherwise the mocks.
                      Mocks never act as failover behind a real provider: a customer must not silently get mock output.
      mock            mocks only (tests, demos, CI)
      live            real providers only; a capability with no key fails loudly
    """
    from .real import real_adapters
    mode = os.environ.get("MODEL_ROUTER_MODE", "auto").lower()
    real = [] if mode == "mock" else real_adapters()
    with_real = {a.capability for a in real}
    r = ModelRouter()
    for a in real:
        r.register(a)
    if mode != "live":
        for a in mock_adapters():
            if a.capability not in with_real:
                r.register(a)
    return r
