"""Scene validation and whole-scene GLB export (merges placed assets into one file with their transforms)."""
from __future__ import annotations

import json
import math
import struct

from pydantic import BaseModel, Field, field_validator

from .glb import read_glb


class AudioSource(BaseModel):
    kind: str = Field(pattern="^(ambient|music|voice)$")
    volume: float = Field(ge=0, le=1)
    ref_distance: float = Field(default=1.0, gt=0, le=100)  # spatial audio falloff (metres)


class Node(BaseModel):
    id: str = Field(min_length=1, max_length=40)
    asset_id: str = Field(pattern="^[0-9a-f-]{36}$")
    position: list[float] = Field(min_length=3, max_length=3)
    rotation: list[float] = Field(min_length=3, max_length=3)  # euler radians XYZ
    scale: float = Field(gt=0, le=100)
    audio: AudioSource | None = None

    @field_validator("position", "rotation")
    @classmethod
    def finite(cls, v: list[float]) -> list[float]:
        if not all(math.isfinite(x) and abs(x) < 1000 for x in v):
            raise ValueError("values must be finite and within 1 km")
        return v


class Scene(BaseModel):
    nodes: list[Node] = Field(default_factory=list, max_length=200)
    environment: str = Field(default="studio", pattern="^(studio|outdoor|night|passthrough)$")


def _quat(rx: float, ry: float, rz: float) -> list[float]:
    cx, sx, cy, sy, cz, sz = math.cos(rx / 2), math.sin(rx / 2), math.cos(ry / 2), math.sin(ry / 2), math.cos(rz / 2), math.sin(rz / 2)
    return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz]  # XYZ order, glTF xyzw


def export_scene(scene: Scene, asset_paths: dict[str, str], out_path: str) -> dict:
    out = {"asset": {"version": "2.0", "generator": "Xen Studio XR scene export"}, "scene": 0, "scenes": [{"nodes": []}],
           "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": [], "buffers": [], "extras": {"ai_generated": True}}
    blob = bytearray()
    for node in scene.nodes:
        path = asset_paths[node.asset_id]
        g = read_glb(path)
        with open(path, "rb") as f:
            data = f.read()
        jlen = struct.unpack_from("<I", data, 12)[0]
        bin_chunk = data[28 + jlen: 28 + jlen + g["buffers"][0]["byteLength"]]
        base = len(blob)
        blob += bin_chunk + b"\x00" * ((-len(bin_chunk)) % 4)
        v0, a0, m0, mat0 = len(out["bufferViews"]), len(out["accessors"]), len(out["meshes"]), len(out["materials"])
        out["bufferViews"] += [{**v, "byteOffset": v.get("byteOffset", 0) + base} for v in g["bufferViews"]]
        out["accessors"] += [{**a, "bufferView": a["bufferView"] + v0} for a in g["accessors"]]
        out["materials"] += g.get("materials", [])
        for m in g["meshes"]:
            prims = [{**p, "attributes": {k: i + a0 for k, i in p["attributes"].items()}, "indices": p["indices"] + a0,
                      **({"material": p["material"] + mat0} if "material" in p else {})} for p in m["primitives"]]
            out["meshes"].append({**m, "primitives": prims})
        children = []
        for gn in g["nodes"]:
            child = {k: v for k, v in gn.items() if k != "children"}
            if "mesh" in gn:
                child["mesh"] = gn["mesh"] + m0
            out["nodes"].append(child)
            children.append(len(out["nodes"]) - 1)
        out["nodes"].append({"name": node.id, "children": children, "translation": node.position, "rotation": _quat(*node.rotation),
                             "scale": [node.scale] * 3, **({"extras": {"audio": node.audio.model_dump()}} if node.audio else {})})
        out["scenes"][0]["nodes"].append(len(out["nodes"]) - 1)
    out["buffers"] = [{"byteLength": len(blob)}]
    js = json.dumps(out, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))
    read_glb(out_path)
    return {"nodes": len(scene.nodes), "bytes": 28 + len(js) + len(blob)}
