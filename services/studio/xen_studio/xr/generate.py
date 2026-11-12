"""Mock text-to-3D: composes a recognisable object from primitives, picked by keywords in the prompt
and coloured by any colour words. A real adapter (Meshy, Tripo, self-hosted model) replaces this."""
from __future__ import annotations

import re

from .glb import Mesh, box, cylinder, sphere

COLORS = {"red": (0.85, 0.2, 0.2, 1), "blue": (0.2, 0.4, 0.85, 1), "green": (0.25, 0.65, 0.35, 1), "yellow": (0.95, 0.8, 0.2, 1),
          "orange": (0.95, 0.5, 0.15, 1), "purple": (0.55, 0.3, 0.75, 1), "white": (0.92, 0.92, 0.92, 1), "black": (0.08, 0.08, 0.08, 1),
          "gold": (0.85, 0.65, 0.2, 1), "silver": (0.75, 0.75, 0.78, 1), "wood": (0.55, 0.36, 0.2, 1), "pink": (0.95, 0.5, 0.65, 1)}
WOOD, LEAF, METAL, STONE = (0.5, 0.33, 0.18, 1), (0.22, 0.55, 0.3, 1), (0.7, 0.72, 0.75, 1), (0.6, 0.6, 0.58, 1)


def _accent(prompt: str, default):
    for word, c in COLORS.items():
        if re.search(rf"\b{word}\b", prompt):
            return c
    return default


def compose(prompt: str) -> tuple[str, list[Mesh]]:
    p = prompt.lower()
    a = lambda d: _accent(p, d)  # noqa: E731
    if re.search(r"\b(tree|pine|forest)\b", p):
        return "tree", [cylinder(0.08, 0.06, 0.6, color=WOOD, name="trunk"),
                        cylinder(0.45, 0.0, 0.7, at=(0, 0.45, 0), color=a(LEAF), name="lower-crown"),
                        cylinder(0.32, 0.0, 0.55, at=(0, 0.85, 0), color=a(LEAF), name="upper-crown")]
    if re.search(r"\b(house|home|cabin|hut)\b", p):
        return "house", [box(1.0, 0.7, 0.8, at=(0, 0.35, 0), color=a((0.9, 0.85, 0.75, 1)), name="walls"),
                         cylinder(0.78, 0.0, 0.5, at=(0, 0.7, 0), segments=4, color=(0.6, 0.2, 0.15, 1), name="roof"),
                         box(0.2, 0.4, 0.02, at=(0, 0.2, 0.41), color=WOOD, name="door")]
    if re.search(r"\b(rocket|spaceship|ship)\b", p):
        return "rocket", [cylinder(0.15, 0.15, 0.9, color=a(METAL), metallic=0.6, roughness=0.3, name="body"),
                          cylinder(0.15, 0.0, 0.35, at=(0, 0.9, 0), color=(0.85, 0.2, 0.2, 1), name="nose"),
                          box(0.02, 0.3, 0.25, at=(0.16, 0.15, 0), color=(0.85, 0.2, 0.2, 1), name="fin-a"),
                          box(0.02, 0.3, 0.25, at=(-0.16, 0.15, 0), color=(0.85, 0.2, 0.2, 1), name="fin-b")]
    if re.search(r"\b(table|desk)\b", p):
        parts = [box(1.2, 0.05, 0.7, at=(0, 0.72, 0), color=a(WOOD), name="top")]
        parts += [box(0.06, 0.7, 0.06, at=(x, 0.35, z), color=a(WOOD), name=f"leg-{i}") for i, (x, z) in enumerate(((0.55, 0.3), (-0.55, 0.3), (0.55, -0.3), (-0.55, -0.3)))]
        return "table", parts
    if re.search(r"\b(chair|seat|stool)\b", p):
        parts = [box(0.45, 0.05, 0.45, at=(0, 0.45, 0), color=a(WOOD), name="seat"), box(0.45, 0.5, 0.04, at=(0, 0.72, -0.2), color=a(WOOD), name="back")]
        parts += [box(0.04, 0.45, 0.04, at=(x, 0.22, z), color=a(WOOD), name=f"leg-{i}") for i, (x, z) in enumerate(((0.2, 0.2), (-0.2, 0.2), (0.2, -0.2), (-0.2, -0.2)))]
        return "chair", parts
    if re.search(r"\b(lamp|light)\b", p):
        return "lamp", [cylinder(0.15, 0.15, 0.03, color=METAL, metallic=0.8, roughness=0.3, name="base"),
                        cylinder(0.015, 0.015, 0.8, at=(0, 0.03, 0), color=METAL, metallic=0.8, roughness=0.3, name="stem"),
                        cylinder(0.22, 0.1, 0.25, at=(0, 0.75, 0), color=a((0.95, 0.85, 0.6, 1)), name="shade")]
    if re.search(r"\b(planet|globe|ball|moon|sun)\b", p):
        return "sphere", [sphere(0.5, at=(0, 0.5, 0), color=a((0.3, 0.5, 0.85, 1)), name="sphere")]
    # default: a pedestal with an abstract piece, so every prompt yields a usable, scaled asset
    return "sculpture", [cylinder(0.3, 0.3, 0.1, color=STONE, name="pedestal"), sphere(0.22, at=(0, 0.35, 0), color=a((0.27, 0.84, 0.63, 1)), roughness=0.3, name="form"),
                         box(0.12, 0.3, 0.12, at=(0, 0.65, 0), color=a((0.27, 0.84, 0.63, 1)), name="crown")]
