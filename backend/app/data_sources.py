"""Data layer: CoStar building records, Vexcel aerial imagery, Matterport scans.

- CoStar: data/costar_buildings.json, built from the CoStar hackathon kit joined with
  each building's Matterport rooms (scripts/build_costar_buildings.py). Falls back to
  the made-up samples in data/buildings.json when that file is missing.
- Vexcel: live API (api.vexcelgroup.com/v2) for the aerial photo and building
  attributes at the building's coordinates. Called server-side; the key never
  reaches the browser.
- Matterport: model id + SDK key for the in-browser Showcase embed.
"""
import json
import logging
import math
import os
import re
from functools import lru_cache
from pathlib import Path

import httpx

log = logging.getLogger("data")
ROOT = Path(__file__).resolve().parents[2]
SAMPLE_FILE = ROOT / "data" / "buildings.json"
COSTAR_FILE = ROOT / "data" / "costar_buildings.json"
CACHE = ROOT / "data" / "cache"

VEXCEL_API = "https://api.vexcelgroup.com/v2"
VEXCEL_LAYERS = "urban,urban-r,wide-area,urban-g"
AERIAL_HALF_M = 120          # the fly-in photo covers a 240 m square around the building
_ROUGH = re.compile(r"\b(bitch|fuck|shit|sex|xxx)\b", re.I)


def costar_enabled() -> bool:
    return COSTAR_FILE.exists()


def vexcel_enabled() -> bool:
    return bool(os.getenv("VEXCEL_API_KEY"))


@lru_cache(maxsize=1)
def _load() -> dict[str, dict]:
    if COSTAR_FILE.exists():
        rows = json.loads(COSTAR_FILE.read_text())["buildings"]
        for b in rows:   # keep tenant names game-safe
            b["tenants"] = [t for t in b.get("tenants", []) if not _ROUGH.search(t)]
            b["history"] = [h for h in b.get("history", []) if not _ROUGH.search(h)]
        return {b["id"]: b for b in rows}
    return {b["id"]: b for b in json.loads(SAMPLE_FILE.read_text())["buildings"]}


def list_buildings() -> list[dict]:
    return list(_load().values())


def get_building(building_id: str) -> dict:
    b = _load().get(building_id)
    if not b:
        raise KeyError(building_id)
    return b


# ------------------------------------------------------------------ Vexcel
def _square(lat: float, lng: float, half_m: float) -> str:
    dlat = half_m / 111_320
    dlng = half_m / (111_320 * math.cos(math.radians(lat)))
    w, e, s, n = lng - dlng, lng + dlng, lat - dlat, lat + dlat
    return f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"


def aerial_image_url(building: dict) -> str | None:
    """URL the browser uses for the fly-in ground texture (proxied by our server)."""
    if vexcel_enabled() and building.get("lat") is not None:
        return f"/api/aerial/{building['id']}.jpg"
    return building.get("aerial_image_url")


def vexcel_ortho(building: dict) -> bytes:
    """Real Vexcel ortho photo of a 240 m square around the building (cached on disk)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"aerial-{building['id']}.jpg"
    if path.exists():
        return path.read_bytes()
    r = httpx.post(f"{VEXCEL_API}/ortho/extract", timeout=90,
                   headers={"X-API-KEY": os.environ["VEXCEL_API_KEY"]},
                   json={"wkt": _square(building["lat"], building["lng"], AERIAL_HALF_M), "srid": 4326,
                         "layer": VEXCEL_LAYERS, "crop": "bounding_box", "image-format": "jpeg",
                         "destination-dimensions": "1024,1024"})
    r.raise_for_status()
    path.write_bytes(r.content)
    return r.content


@lru_cache(maxsize=256)
def vexcel_property(building_id: str) -> dict:
    """Vexcel Elements attributes for the parcel: structures, footprint, trees, pool."""
    b = get_building(building_id)
    if not vexcel_enabled() or b.get("lat") is None:
        return {}
    try:
        r = httpx.get(f"{VEXCEL_API}/property/extract", timeout=60,
                      headers={"X-API-KEY": os.environ["VEXCEL_API_KEY"]},
                      params={"wkt": f"POINT({b['lng']} {b['lat']})", "srid": 4326, "layer": VEXCEL_LAYERS,
                              "latest": "true", "include": "precomputed", "unit-system": "imperial"})
        if r.status_code != 200:
            return {"note": f"no Vexcel parcel record here (HTTP {r.status_code})"}
        a = r.json()["features"][0]["properties"]
        main = next((s for s in a.get("structures", []) if s.get("primary-structure")), {})
        return {"imagery_collection": a.get("metadata.collection"),
                "structure_count": a.get("structure.count"),
                "tree_cover_percent": a.get("parcel-tree-cover.percent"),
                "pool_detected": a.get("pool.detected"),
                "footprint_sqft": round(main.get("footprint.area", 0)) or None,
                "roof_material": main.get("roof-characteristics.material.class"),
                "roof_condition": main.get("roof-characteristics.condition")}
    except Exception as e:
        log.warning("Vexcel property lookup failed: %s", e)
        return {}


# ------------------------------------------------------------------ Matterport
def matterport_info(building: dict) -> dict | None:
    key = os.getenv("MATTERPORT_SDK_KEY")
    if building.get("matterport_model_id") and key:
        return {"model_id": building["matterport_model_id"], "sdk_key": key}
    return None
