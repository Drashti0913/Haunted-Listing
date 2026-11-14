"""Data layer: CoStar building records, Vexcel aerial imagery, Matterport scans.

Every source falls back to data/buildings.json so the game always runs.
Once you have the CoStar toolkit keys, fill in the endpoint paths below with
the CoStar / Vexcel / Matterport engineers (they are on site and on Discord).
"""
import json
import os
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
SAMPLE_FILE = ROOT / "data" / "buildings.json"

COSTAR_API_BASE = os.getenv("COSTAR_API_BASE")          # e.g. https://<toolkit host>
COSTAR_API_KEY = os.getenv("COSTAR_API_KEY")
COSTAR_PROPERTY_PATH = os.getenv("COSTAR_PROPERTY_PATH", "/properties/{id}")
VEXCEL_IMAGE_URL = os.getenv("VEXCEL_IMAGE_URL")        # template with {lat} {lng}
MATTERPORT_SDK_KEY = os.getenv("MATTERPORT_SDK_KEY")


def _load_samples() -> dict[str, dict]:
    data = json.loads(SAMPLE_FILE.read_text())
    return {b["id"]: b for b in data["buildings"]}


def list_buildings() -> list[dict]:
    return list(_load_samples().values())


def get_building(building_id: str) -> dict:
    """CoStar layer. Live API when configured, else the sample record."""
    if COSTAR_API_BASE and COSTAR_API_KEY and not building_id.startswith("sample-"):
        url = COSTAR_API_BASE.rstrip("/") + COSTAR_PROPERTY_PATH.format(id=building_id)
        r = httpx.get(url, headers={"Authorization": f"Bearer {COSTAR_API_KEY}"}, timeout=20)
        r.raise_for_status()
        return _normalize_costar(building_id, r.json())
    samples = _load_samples()
    if building_id not in samples:
        raise KeyError(building_id)
    return samples[building_id]


def _normalize_costar(building_id: str, raw: dict) -> dict:
    """Map a CoStar property payload onto the fields the game uses.
    Field names are guesses until you see the real payload; adjust here only."""
    g = lambda *keys, default=None: next((raw[k] for k in keys if raw.get(k) is not None), default)
    return {
        "id": building_id,
        "name": g("name", "propertyName", "buildingName", default="Unknown building"),
        "address": g("address", "streetAddress", default=""),
        "city": g("city", default=""),
        "lat": g("lat", "latitude"),
        "lng": g("lng", "lon", "longitude"),
        "property_type": str(g("property_type", "propertyType", default="office")).lower(),
        "year_built": g("year_built", "yearBuilt"),
        "floors": g("floors", "numberOfStories", "stories", default=2),
        "rentable_sqft": g("rentable_sqft", "rba", "rentableBuildingArea"),
        "tenants": g("tenants", default=[]),
        "last_sale": g("last_sale", "lastSale"),
        "history": g("history", default=[]),
        "matterport_model_id": g("matterport_model_id", "matterportModelId"),
        "aerial_image_url": g("aerial_image_url"),
        "raw": raw,
    }


def aerial_image_url(building: dict) -> str | None:
    """Vexcel layer."""
    if building.get("aerial_image_url"):
        return building["aerial_image_url"]
    if VEXCEL_IMAGE_URL and building.get("lat") is not None:
        return VEXCEL_IMAGE_URL.format(lat=building["lat"], lng=building["lng"])
    return None


def matterport_info(building: dict) -> dict | None:
    """Matterport layer: model id + SDK key for the browser embed."""
    if building.get("matterport_model_id") and MATTERPORT_SDK_KEY:
        return {"model_id": building["matterport_model_id"], "sdk_key": MATTERPORT_SDK_KEY}
    return None
