"""Build data/costar_buildings.json: real Houston + LA buildings for the game.

Joins the CoStar hackathon kit (property, tenants, sales) with each building's
Matterport scan (floors + room tags from the Matterport GraphQL API).

    .venv/bin/python scripts/build_costar_buildings.py [--per-city 10]

Needs: costar-kit/ (the unzipped CoStar hackathon kit) and MATTERPORT_API_KEY /
MATTERPORT_API_TOKEN in .env. The output stays out of git (CoStar data).
"""
import argparse
import csv
import json
import os
from collections import defaultdict
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
KIT = ROOT / "costar-kit"
OUT = ROOT / "data" / "costar_buildings.json"
load_dotenv(ROOT / ".env")

TYPES = {1: "hotel", 5: "office", 6: "retail", 8: "entertainment", 9: "mixed-use",
         10: "specialty", 11: "multifamily", 13: "healthcare", 2: "industrial", 7: "flex"}
GAME_TYPE = {"office": "office", "multifamily": "multifamily", "retail": "retail",
             "hotel": "multifamily", "mixed-use": "office", "entertainment": "retail",
             "healthcare": "office", "specialty": "office", "industrial": "office", "flex": "office"}
MARKETS = {14: "Houston", 20: "Los Angeles"}


def jsonl(name):
    with open(KIT / "data" / f"{name}.jsonl") as f:
        for line in f:
            yield json.loads(line)


def money(v):
    return f"${v / 1e6:.1f}M" if v >= 1e6 else f"${v:,.0f}"


def matterport(model_id):
    q = ('{ model(id: "%s") { id name floors { id label sequence } '
         'rooms { id label tags floor { id } } } }' % model_id)
    r = httpx.post("https://api.matterport.com/api/models/graph", timeout=30,
                   auth=(os.environ["MATTERPORT_API_KEY"], os.environ["MATTERPORT_API_TOKEN"]),
                   json={"query": q})
    return (r.json().get("data") or {}).get("model")


def main(per_city):
    models = defaultdict(list)
    with open(KIT / "commercial-properties.csv") as f:
        for row in csv.DictReader(f):
            if row["MatterportModelId"]:
                models[int(row["PropertyId"])].append(row["MatterportModelId"])

    print("reading properties…")
    props = {}
    for p in jsonl("commercial-property"):
        a = p.get("primaryAddress") or {}
        built = next((e["year"] for e in p.get("constructionEvents", []) if e.get("eventType") == 2), None)
        renov = next((e["year"] for e in p.get("constructionEvents", []) if e.get("eventType") == 4), None)
        ptype = TYPES.get(p.get("propertyType"))
        if not (p.get("buildingName") and built and ptype and models.get(p["id"])
                and a.get("latitude") and a.get("researchMarketId") in MARKETS):
            continue
        note = next((n["value"] for n in p.get("notes", []) if n.get("value")), "")
        props[p["id"]] = {
            "id": f"costar-{p['id']}", "costar_property_id": p["id"],
            "name": p["buildingName"],
            "address": " ".join(str(x) for x in (a.get("streetNumber"), a.get("streetName"), a.get("streetType")) if x)
                       + f", {a.get('city')}, {a.get('state')}",
            "city": MARKETS[a["researchMarketId"]], "lat": a["latitude"], "lng": a["longitude"],
            "costar_type": ptype, "property_type": GAME_TYPE[ptype],
            "year_built": built, "year_renovated": renov,
            "floors": p.get("numStoriesAboveGrade") or 1,
            "rentable_sqft": p.get("rentableBuildingAreaSquareFeet"),
            "costar_note": note[:500], "matterport_models": models[p["id"]],
            "tenants": [], "sales": [],
        }
    print(f"  {len(props)} candidates with a name, year built and Matterport scan")

    print("reading tenancies…")
    tenancies = defaultdict(list)
    for o in jsonl("location-occupancy"):
        if o["propertyId"] in props and o.get("tenantLocationId"):
            tenancies[o["propertyId"]].append((o.get("fromDate") or "", o["tenantLocationId"]))
    wanted = {t for v in tenancies.values() for _, t in v}
    names = {c["id"]: c["name"] for c in jsonl("company-detail") if c["id"] in wanted and c.get("name")}
    for pid, rows in tenancies.items():
        seen = []
        for date, tid in sorted(rows, reverse=True):
            n = names.get(tid)
            if n and n not in seen:
                seen.append(n)
        props[pid]["tenants"] = seen[:6]
        props[pid]["tenant_count"] = len(seen)

    print("reading sales…")
    for s in jsonl("commercial-sale-comp"):
        if not s.get("soldDate"):
            continue
        for e in s.get("entities", []):
            if e.get("propertyId") in props:
                props[e["propertyId"]]["sales"].append(
                    {"year": int(s["soldDate"][:4]), "price_usd": s.get("soldForPrice")})
    for p in props.values():
        p["sales"].sort(key=lambda x: x["year"], reverse=True)

    def score(p):   # rich, old, story-worthy buildings first
        return (min(len(p["tenants"]), 6) + 2 * bool(p["sales"]) + 2 * bool(p["costar_note"])
                + (3 if p["year_built"] < 1960 else 2 if p["year_built"] < 1985 else 0)
                + min(p["floors"], 5) / 2)

    picked = []
    for city in MARKETS.values():
        pool = sorted((p for p in props.values() if p["city"] == city), key=score, reverse=True)
        n_city, types_used = 0, defaultdict(int)
        for p in pool:
            if n_city >= per_city:
                break
            if types_used[p["costar_type"]] >= 3:      # keep variety
                continue
            for mid in p["matterport_models"][:3]:
                m = matterport(mid)
                if m and m.get("rooms"):
                    floor_seq = {f["id"]: f.get("sequence", 0) for f in m.get("floors") or []}
                    p["matterport_model_id"] = mid
                    p["matterport_name"] = m.get("name")
                    p["matterport_rooms"] = [
                        {"tags": r.get("tags") or [], "label": r.get("label"),
                         "floor": floor_seq.get((r.get("floor") or {}).get("id"), 0)}
                        for r in m["rooms"]]
                    break
            if not p.get("matterport_model_id"):
                continue
            hist = [f"Built in {p['year_built']}"]
            if p["year_renovated"]:
                hist.append(f"Renovated in {p['year_renovated']}")
            for s in p["sales"][:2]:
                hist.append(f"Sold in {s['year']}" + (f" for {money(s['price_usd'])}" if s.get("price_usd") else ""))
            if p["tenants"]:
                hist.append("Tenants over the years include " + ", ".join(p["tenants"][:3]))
            p["history"] = hist
            p["last_sale"] = p["sales"][0] if p["sales"] else None
            picked.append(p)
            n_city += 1
            types_used[p["costar_type"]] += 1
            print(f"  + {city}: {p['name']} ({p['costar_type']}, {p['year_built']}, "
                  f"{len(p['matterport_rooms'])} scanned rooms)")

    OUT.write_text(json.dumps({"_note": "Derived from the CoStar HackPrinceton 2026 kit + Matterport API. Do not publish.",
                               "buildings": picked}, indent=1))
    print(f"wrote {len(picked)} buildings to {OUT}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-city", type=int, default=10)
    main(ap.parse_args().per_city)
