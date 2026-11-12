"""Minimal glTF 2.0 binary (GLB) writer: indexed triangle meshes with normals and PBR base colours.
Enough for generated assets to open in three.js, Blender, model-viewer, Unity (glTFast) and OpenXR runtimes."""
from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass, field


@dataclass
class Mesh:
    positions: list[tuple[float, float, float]] = field(default_factory=list)
    normals: list[tuple[float, float, float]] = field(default_factory=list)
    indices: list[int] = field(default_factory=list)
    color: tuple[float, float, float, float] = (0.8, 0.8, 0.8, 1.0)
    metallic: float = 0.0
    roughness: float = 0.7
    name: str = "part"

    def add(self, other: "Mesh") -> None:
        base = len(self.positions)
        self.positions += other.positions
        self.normals += other.normals
        self.indices += [i + base for i in other.indices]


def _move(m: Mesh, dx: float, dy: float, dz: float) -> Mesh:
    m.positions = [(x + dx, y + dy, z + dz) for x, y, z in m.positions]
    return m


def box(w: float, h: float, d: float, at=(0.0, 0.0, 0.0), **mat) -> Mesh:
    m = Mesh(**mat)
    hx, hy, hz = w / 2, h / 2, d / 2
    faces = [((1, 0, 0), [(hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz)]),
             ((-1, 0, 0), [(-hx, -hy, hz), (-hx, hy, hz), (-hx, hy, -hz), (-hx, -hy, -hz)]),
             ((0, 1, 0), [(-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz), (hx, hy, -hz)]),
             ((0, -1, 0), [(-hx, -hy, hz), (-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz)]),
             ((0, 0, 1), [(hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz), (-hx, -hy, hz)]),
             ((0, 0, -1), [(-hx, -hy, -hz), (-hx, hy, -hz), (hx, hy, -hz), (hx, -hy, -hz)])]
    for n, quad in faces:
        b = len(m.positions)
        m.positions += quad
        m.normals += [n] * 4
        m.indices += [b, b + 1, b + 2, b, b + 2, b + 3]
    return _move(m, *at)


def cylinder(r_bottom: float, r_top: float, h: float, at=(0.0, 0.0, 0.0), segments: int = 24, **mat) -> Mesh:
    """Cylinder or cone (r_top=0), base on y=0 before moving. Side normals account for the slope."""
    m = Mesh(**mat)
    slope = (r_bottom - r_top) / h
    for i in range(segments + 1):
        a = 2 * math.pi * i / segments
        c, s = math.cos(a), math.sin(a)
        ln = math.sqrt(1 + slope * slope)
        n = (c / ln, slope / ln, s / ln)
        m.positions += [(r_bottom * c, 0.0, r_bottom * s), (r_top * c, h, r_top * s)]
        m.normals += [n, n]
    for i in range(segments):
        a, b, c2, d = 2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3
        m.indices += [a, b, d, a, d, c2]
    for y, r, ny in ((0.0, r_bottom, -1.0), (h, r_top, 1.0)):  # caps
        if r <= 0:
            continue
        centre = len(m.positions)
        m.positions.append((0.0, y, 0.0))
        m.normals.append((0.0, ny, 0.0))
        for i in range(segments + 1):
            a = 2 * math.pi * i / segments
            m.positions.append((r * math.cos(a), y, r * math.sin(a)))
            m.normals.append((0.0, ny, 0.0))
        for i in range(segments):
            p, q = centre + 1 + i, centre + 2 + i
            m.indices += [centre, q, p] if ny < 0 else [centre, p, q]
    return _move(m, *at)


def sphere(r: float, at=(0.0, 0.0, 0.0), rings: int = 16, segments: int = 24, **mat) -> Mesh:
    m = Mesh(**mat)
    for i in range(rings + 1):
        phi = math.pi * i / rings
        for j in range(segments + 1):
            th = 2 * math.pi * j / segments
            n = (math.sin(phi) * math.cos(th), math.cos(phi), math.sin(phi) * math.sin(th))
            m.positions.append((r * n[0], r * n[1], r * n[2]))
            m.normals.append(n)
    w = segments + 1
    for i in range(rings):
        for j in range(segments):
            a, b = i * w + j, (i + 1) * w + j
            m.indices += [a, a + 1, b, b, a + 1, b + 1]
    return _move(m, *at)


def write_glb(parts: list[Mesh], path: str, name: str = "asset") -> dict:
    """Writes one node per part (each with its own material). Returns {"triangles", "bounds"}."""
    bin_chunks, buffer_views, accessors, meshes, materials, nodes = [], [], [], [], [], []
    offset = 0

    def add_view(data: bytes, target: int) -> int:
        nonlocal offset
        pad = (-len(data)) % 4
        bin_chunks.append(data + b"\x00" * pad)
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
        offset += len(data) + pad
        return len(buffer_views) - 1

    lo, hi, tris = [math.inf] * 3, [-math.inf] * 3, 0
    for k, p in enumerate(parts):
        pos = struct.pack(f"<{len(p.positions) * 3}f", *[c for v in p.positions for c in v])
        nrm = struct.pack(f"<{len(p.normals) * 3}f", *[c for v in p.normals for c in v])
        idx = struct.pack(f"<{len(p.indices)}I", *p.indices)
        pmin = [min(v[i] for v in p.positions) for i in range(3)]
        pmax = [max(v[i] for v in p.positions) for i in range(3)]
        lo, hi = [min(a, b) for a, b in zip(lo, pmin, strict=True)], [max(a, b) for a, b in zip(hi, pmax, strict=True)]
        accessors += [
            {"bufferView": add_view(pos, 34962), "componentType": 5126, "count": len(p.positions), "type": "VEC3", "min": pmin, "max": pmax},
            {"bufferView": add_view(nrm, 34962), "componentType": 5126, "count": len(p.normals), "type": "VEC3"},
            {"bufferView": add_view(idx, 34963), "componentType": 5125, "count": len(p.indices), "type": "SCALAR"},
        ]
        a = len(accessors) - 3
        materials.append({"name": f"{p.name}-material", "pbrMetallicRoughness": {"baseColorFactor": list(p.color), "metallicFactor": p.metallic, "roughnessFactor": p.roughness}})
        meshes.append({"name": p.name, "primitives": [{"attributes": {"POSITION": a, "NORMAL": a + 1}, "indices": a + 2, "material": k}]})
        nodes.append({"name": p.name, "mesh": k})
        tris += len(p.indices) // 3
    blob = b"".join(bin_chunks)
    gltf = {"asset": {"version": "2.0", "generator": "Xen Studio XR pipeline"}, "scene": 0,
            "scenes": [{"name": name, "nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes, "materials": materials,
            "accessors": accessors, "bufferViews": buffer_views, "buffers": [{"byteLength": len(blob)}],
            "extras": {"ai_generated": True, "generator": "Xen Studio"}}
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + blob)
    return {"triangles": tris, "bounds": {"min": [round(x, 4) for x in lo], "max": [round(x, 4) for x in hi]}}


def read_glb(path: str) -> dict:
    """Parses and validates a GLB header and JSON chunk (used by QC and tests)."""
    with open(path, "rb") as f:
        data = f.read()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError("not a valid glTF 2.0 binary")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    if jtype != 0x4E4F534A:
        raise ValueError("first GLB chunk must be JSON")
    gltf = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from("<II", data, 20 + jlen)
    if btype != 0x004E4942 or blen < gltf["buffers"][0]["byteLength"]:
        raise ValueError("GLB binary chunk is missing or short")
    for acc in gltf["accessors"]:
        view = gltf["bufferViews"][acc["bufferView"]]
        size = {"VEC3": 12, "SCALAR": 4}[acc["type"]] * acc["count"]
        if view["byteOffset"] + size > blen or view["byteLength"] < size:
            raise ValueError("accessor points outside the binary chunk")
    return gltf
