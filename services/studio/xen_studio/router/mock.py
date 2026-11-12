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

    return {"research": research, "write_script": write_script, "rewrite_scene": rewrite_scene, "package": package}


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
    def render(visual_prompt: str, seed: int, seconds: float, width: int, height: int, out_path: str):
        _maybe_fail("visual", provider)
        color = PALETTE[seed % len(PALETTE)]
        accent = ["0x46d6a0", "0x7fb4ff", "0xf2b84b"][seed % 3]
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


def default_router() -> ModelRouter:
    r = ModelRouter()
    for name in ("mock-primary", "mock-secondary"):
        r.register(Adapter(name, "moderation", "mock-policy-1", {"check": _moderate(name)}))
        r.register(Adapter(name, "llm", "mock-writer-1", _llm(name)))
        r.register(Adapter(name, "tts", "mock-flite-1", {"speak": _tts(name)}))
        r.register(Adapter(name, "visual", "mock-titlecard-1", {"render": _visual(name)}))
        r.register(Adapter(name, "qc", "mock-probe-1", {"score": _qc(name)}))
        r.register(Adapter(name, "email", "mock-smtp-1", {"send": _notify(name, "email")}))
        r.register(Adapter(name, "push", "mock-push-1", {"send": _notify(name, "push")}))
    return r
