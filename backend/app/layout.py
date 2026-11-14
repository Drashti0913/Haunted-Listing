"""Turns a building record into a walkable floor plan (rooms on a grid per floor).
The same layout goes to the agent (for spatial reasoning) and to the 3D client."""

ROOM_W, ROOM_D, FLOOR_H = 8.0, 8.0, 4.0

ROOM_NAMES = {
    "office": [["Lobby", "Security Desk", "Mail Room"],
               ["Trading Floor", "Server Room", "Break Room"],
               ["Boardroom", "Executive Office", "Records Archive"]],
    "multifamily": [["Front Hall", "Laundry Room", "Manager's Office"],
                    ["Unit 2A Living Room", "Unit 2B Kitchen", "Courtyard Balcony"],
                    ["Unit 3A Bedroom", "Attic Storage", "Rooftop Access"]],
    "retail": [["Arcade Floor", "Noodle Counter", "Pawn Shop"],
               ["Back Office", "Old Bowling Lanes", "Prize Storage"]],
}
COLS = 3


def build_layout(building: dict) -> dict:
    ptype = building.get("property_type", "office")
    names = ROOM_NAMES.get(ptype, ROOM_NAMES["office"])
    n_floors = max(1, min(int(building.get("floors") or 2), len(names)))
    rooms = []
    for f in range(n_floors):
        row_names = names[f]
        for i, name in enumerate(row_names + ["Stairwell"]):
            col, row = i % COLS, i // COLS
            rooms.append({
                "id": f"f{f}-r{i}",
                "name": name if name == "Stairwell" else name,
                "floor": f,
                "col": col,
                "row": row,
                "x": col * ROOM_W,
                "z": row * ROOM_D,
                "y": f * FLOOR_H,
            })
    # neighbours = rooms sharing a wall on the same floor (doorways are cut there)
    for r in rooms:
        r["neighbors"] = [o["id"] for o in rooms if o["floor"] == r["floor"]
                          and abs(o["col"] - r["col"]) + abs(o["row"] - r["row"]) == 1]
    return {"floors": n_floors, "room_w": ROOM_W, "room_d": ROOM_D,
            "floor_h": FLOOR_H, "rooms": rooms}


def room_by_id(layout: dict, room_id: str) -> dict | None:
    return next((r for r in layout["rooms"] if r["id"] == room_id), None)
