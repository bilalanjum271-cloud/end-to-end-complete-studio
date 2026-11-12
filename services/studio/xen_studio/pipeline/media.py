"""FFmpeg helpers and the storage interface. All generation writes through Storage so the
local-directory backend can be swapped for S3-compatible object storage without touching the pipeline."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


class Storage:
    """Local-directory object store. Keys look like `<workspace>/<project>/...` so tenants never share a prefix."""

    def __init__(self, root: str):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError("storage key escapes the storage root")
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def put_file(self, key: str, src: str | Path) -> str:
        dst = self.path(key)
        tmp = dst.with_suffix(dst.suffix + ".part")
        shutil.copyfile(src, tmp)
        os.replace(tmp, dst)  # atomic: readers never see a half-written file
        return key

    def put_text(self, key: str, text: str) -> str:
        dst = self.path(key)
        tmp = dst.with_suffix(dst.suffix + ".part")
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, dst)
        return key

    def exists(self, key: str) -> bool:
        return self.path(key).is_file()


def run(args: list[str], timeout: int = 300) -> None:
    proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {proc.stderr.strip()[-600:]}")


def probe(path: str | Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
                          "-of", "json", str(path)], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout)
    return {"duration_ms": int(float(data["format"]["duration"]) * 1000), "streams": data.get("streams", [])}


def sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _ts(ms: int, sep: str) -> str:
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{milli:03d}"


def subtitles(cues: list[tuple[int, int, str]]) -> tuple[str, str]:
    """Returns (srt, vtt) for cues of (start_ms, end_ms, text)."""
    srt = "\n".join(f"{i}\n{_ts(a, ',')} --> {_ts(b, ',')}\n{t}\n" for i, (a, b, t) in enumerate(cues, 1))
    vtt = "WEBVTT\n\n" + "\n".join(f"{_ts(a, '.')} --> {_ts(b, '.')}\n{t}\n" for a, b, t in cues)
    return srt, vtt


def assemble(segments: list[tuple[str, str]], srt_path: str, out_path: str, watermark: str | None, fit_video_to_audio: bool = False, language: str = "eng") -> None:
    """Stitches (video, audio) scene pairs, levels the audio (EBU R128), embeds a subtitle track
    and, when the plan requires it, burns the watermark."""
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i, (video, audio) in enumerate(segments):
            part = os.path.join(tmp, f"part{i}.mp4")
            if fit_video_to_audio:
                # Dubbed narration rarely matches the original length: hold the last frame so speech is never cut.
                run(["ffmpeg", "-y", "-i", video, "-i", audio, "-filter_complex", "[0:v]tpad=stop_mode=clone:stop_duration=120[v]",
                     "-map", "[v]", "-map", "1:a:0", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                     "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-shortest", part])
            else:
                run(["ffmpeg", "-y", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
                     "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-shortest", part])
            parts.append(part)
        listing = os.path.join(tmp, "list.txt")
        Path(listing).write_text("".join(f"file '{p}'\n" for p in parts))
        vf = []
        if watermark:
            safe = watermark.replace("'", "").replace(":", "")
            vf = ["-vf", f"drawtext=text='{safe}':fontcolor=white@0.55:fontsize=22:x=w-tw-24:y=24"]
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-i", srt_path,
             "-map", "0:v:0", "-map", "0:a:0", "-map", "1:0", *vf,
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
             "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
             "-c:s", "mov_text", "-metadata:s:s:0", f"language={language}",
             "-metadata", "comment=AI-generated with Xen Studio", "-movflags", "+faststart", out_path])


def add_music(video: str, music: str, out_path: str) -> None:
    """Mixes a music bed under the narration. The bed ducks (sidechain compression) whenever someone speaks."""
    run(["ffmpeg", "-y", "-i", video, "-i", music, "-filter_complex",
         "[1:a]volume=0.35[bed];[bed][0:a]sidechaincompress=threshold=0.03:ratio=10:attack=15:release=400[ducked];"
         "[0:a][ducked]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]",
         "-map", "0:v:0", "-map", "[a]", "-map", "0:s?", "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
         "-movflags", "+faststart", out_path])
