"""Turns a building record into a walkable floor plan (rooms on a grid per floor).
The same layout goes to the agent (for spatial reasoning) and to the 3D client.

When the building has a Matterport scan, its real scanned rooms (lobby, kitchen,
bedroom, garage...) become the game's rooms; the rest is filled by building type."""

ROOM_W, ROOM_D, FLOOR_H = 8.0, 8.0, 4.0
COLS, ROOMS_PER_FLOOR = 3, 3

ROOM_NAMES = {
    "office": ["Lobby", "Security Desk", "Mail Room", "Trading Floor", "Server Room", "Break Room",
               "Boardroom", "Executive Office", "Records Archive"],
    "multifamily": ["Front Hall", "Laundry Room", "Manager's Office", "Unit 2A Living Room", "Unit 2B Kitchen",
                    "Courtyard Balcony", "Unit 3A Bedroom", "Attic Storage", "Rooftop Access"],
    "retail": ["Shop Floor", "Counter", "Stockroom", "Back Office", "Old Showroom", "Prize Storage",
               "Loading Dock", "Fitting Rooms", "Upstairs Storage"],
}
# Matterport room tags -> game room names (None = skip)
TAG_NAMES = {
    "lobby": "Lobby", "entrance": "Entrance", "bathroom": "Bathroom", "unfurnished": "Empty Unit",
    "bedroom": "Bedroom", "living": "Living Room", "kitchen": "Kitchen", "hallway": "Hallway",
    "corridor": "Corridor", "garage": "Garage", "office": "Office", "utility": "Utility Room",
    "closet": "Closet", "exercise": "Gym", "basement": "Basement", "laundry": "Laundry Room",
    "dining": "Dining Room", "storage": "Storage", "conference": "Conference Room",
    "staircase": None, "other": None,
}


def _scanned_room_names(building: dict) -> list[str]:
    names, counts = [], {}
    for r in building.get("matterport_rooms") or []:
        tags = [t for t in r.get("tags", []) if TAG_NAMES.get(t)]
        tag = next((t for t in tags if t != "unfurnished"), tags[0] if tags else None)   # most specific
        if not tag:
            continue
        base = TAG_NAMES[tag]
        counts[base] = counts.get(base, 0) + 1
        if counts[base] > 2:          # keep variety: at most two of each kind
            continue
        names.append(base if counts[base] == 1 else f"{base} {counts[base]}")
    # entrance-like rooms first: the first room is where the player enters and exits
    names.sort(key=lambda n: 0 if n.startswith(("Lobby", "Entrance")) else 1)
    return names


def build_layout(building: dict) -> dict:
    ptype = building.get("property_type", "office")
    defaults = ROOM_NAMES.get(ptype, ROOM_NAMES["office"])
    n_floors = max(1, min(int(building.get("floors") or 2), 3))
    scanned = _scanned_room_names(building)
    names = (scanned + [d for d in defaults if d not in scanned])[: n_floors * ROOMS_PER_FLOOR]
    rooms = []
    for f in range(n_floors):
        floor_names = names[f * ROOMS_PER_FLOOR:(f + 1) * ROOMS_PER_FLOOR] + ["Stairwell"]
        for i, name in enumerate(floor_names):
            col, row = i % COLS, i // COLS
            rooms.append({
                "id": f"f{f}-r{i}", "name": name, "floor": f,
                "scanned": name in scanned,
                "col": col, "row": row,
                "x": col * ROOM_W, "z": row * ROOM_D, "y": f * FLOOR_H,
            })
    # neighbours = rooms sharing a wall on the same floor (doorways are cut there)
    for r in rooms:
        r["neighbors"] = [o["id"] for o in rooms if o["floor"] == r["floor"]
                          and abs(o["col"] - r["col"]) + abs(o["row"] - r["row"]) == 1]
    return {"floors": n_floors, "room_w": ROOM_W, "room_d": ROOM_D,
            "floor_h": FLOOR_H, "rooms": rooms, "scanned_rooms": len(scanned)}


def room_by_id(layout: dict, room_id: str) -> dict | None:
    return next((r for r in layout["rooms"] if r["id"] == room_id), None)
