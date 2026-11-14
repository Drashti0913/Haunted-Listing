"""Game state, what the player is allowed to see, and an offline game master
used when no ANTHROPIC_API_KEY is set (so the demo never breaks)."""
import random
import uuid

from .layout import build_layout, room_by_id


class Game:
    def __init__(self, building: dict):
        self.id = uuid.uuid4().hex[:10]
        self.building = building
        self.layout = build_layout(building)
        self.title = ""
        self.intro = ""
        self.mystery = ""
        self.solution = ""
        self.culprit_id: str | None = None
        self.npcs: dict[str, dict] = {}
        self.clues: dict[str, dict] = {}
        self.events: list[dict] = []
        self.status = "playing"          # playing | won | lost
        self.hints_used = 0

    # --- mutations used by both the agent tools and the offline GM -------
    def emit(self, kind: str, **data):
        self.events.append({"seq": len(self.events), "kind": kind, **data})

    def spawn_npc(self, name, role, room_id, persona, secret, alibi):
        if not room_by_id(self.layout, room_id):
            return f"Unknown room {room_id}"
        nid = f"npc{len(self.npcs) + 1}"
        self.npcs[nid] = {"id": nid, "name": name, "role": role, "room": room_id,
                          "persona": persona, "secret": secret, "alibi": alibi}
        return f"Spawned {name} as {nid} in {room_id}"

    def place_clue(self, room_id, name, description, points_to=""):
        if not room_by_id(self.layout, room_id):
            return f"Unknown room {room_id}"
        cid = f"clue{len(self.clues) + 1}"
        self.clues[cid] = {"id": cid, "room": room_id, "name": name,
                           "description": description, "points_to": points_to,
                           "found": False}
        return f"Placed {name} as {cid} in {room_id}"

    def move_npc(self, npc_id, room_id):
        if npc_id not in self.npcs or not room_by_id(self.layout, room_id):
            return "Invalid npc or room"
        self.npcs[npc_id]["room"] = room_id
        self.emit("move", npc_id=npc_id, room=room_id)
        return f"Moved {npc_id} to {room_id}"

    def ready(self) -> list[str]:
        problems = []
        if not self.title:
            problems.append("set_story not called")
        if len(self.npcs) < 3:
            problems.append("need at least 3 suspects")
        if len(self.clues) < 4:
            problems.append("need at least 4 clues")
        if self.culprit_id not in self.npcs:
            problems.append("culprit must be one of the spawned suspects")
        return problems

    # --- what the browser gets (no culprit, no secrets) ------------------
    def public(self, since: int = 0) -> dict:
        b = self.building
        return {
            "id": self.id, "status": self.status, "title": self.title,
            "intro": self.intro, "mystery": self.mystery,
            "building": {k: b.get(k) for k in ("id", "name", "address", "city", "lat", "lng",
                                                "property_type", "year_built", "floors",
                                                "tenants", "history")},
            "layout": self.layout,
            "npcs": [{k: n[k] for k in ("id", "name", "role", "room")} for n in self.npcs.values()],
            "clues": [{"id": c["id"], "room": c["room"], "name": c["name"], "found": c["found"],
                       "description": c["description"] if c["found"] else None}
                      for c in self.clues.values()],
            "events": self.events[since:],
            "solution": self.solution if self.status != "playing" else None,
        }


# ---------------------------------------------------------------------------
# Offline game master (deterministic, no LLM)
# ---------------------------------------------------------------------------
NAMES = ["Marisol Vega", "Desmond Okafor", "Priya Raman", "Walt Brennan", "June Takahashi"]
ROLES = {"office": ["night security guard", "junior analyst", "building engineer", "senior partner"],
         "multifamily": ["building manager", "tenant in 2A", "handyman", "landlord's nephew"],
         "retail": ["arcade owner", "noodle chef", "pawn broker", "developer's agent"]}


def offline_setup(game: Game):
    b, rooms = game.building, [r for r in game.layout["rooms"] if r["name"] != "Stairwell"]
    rnd = random.Random(b["id"])
    year = b.get("year_built") or 1970
    history = b.get("history") or ["It has stood here for decades"]
    roles = ROLES.get(b.get("property_type"), ROLES["office"])
    game.title = f"The Ghost of {b['name'].split('(')[0].strip()}"
    game.intro = (f"Built in {year}. {history[0]}. Tonight the lights flicker on every floor "
                  f"and a voice in the walls says it was cheated out of this building.")
    game.mystery = "Someone has been staging the haunting to scare buyers away. Find out who."
    picks = rnd.sample(rooms, k=min(len(rooms), 7))
    for i in range(3):
        game.spawn_npc(NAMES[i], roles[i], picks[i]["id"],
                       persona=f"Nervous {roles[i]} who has worked here for years.",
                       secret="Knows about the hidden sale documents." if i == 1 else "Owes money to the owner.",
                       alibi=f"Says they were in the {picks[(i + 1) % 3]['name']} all night.")
    culprit = "npc2"
    game.culprit_id = culprit
    c_name = game.npcs[culprit]["name"]
    game.place_clue(picks[3]["id"], "Fog machine remote", "A cheap remote, still warm. Initials on the back match a staff badge.", culprit)
    game.place_clue(picks[4]["id"], f"{year} blueprint", f"Original {year} plans show a crawlspace behind this wall: perfect for a hidden speaker.", culprit)
    game.place_clue(picks[5 % len(picks)]["id"], "Sale contract draft", f"A draft offer for the building. Whoever scares off the buyers gets it cheap. Signed: {c_name}.", culprit)
    game.place_clue(picks[6 % len(picks)]["id"], "Torn ghost costume", "A white sheet with a staff lanyard caught in the seam.", culprit)
    game.solution = f"{c_name} faked the haunting to drive the price down before buying the building."
    game.emit("narrate", text=game.intro)


def offline_talk(game: Game, npc_id: str, message: str):
    n = game.npcs[npc_id]
    lines = [f"I'm the {n['role']}. {n['alibi']}",
             "You hear that? The walls... they hum at night.",
             f"Ask around about the {game.building.get('year_built', 'old')} renovation. People get quiet."]
    if npc_id == game.culprit_id and sum(c["found"] for c in game.clues.values()) >= 2:
        lines.append("Why are you looking at me like that? I was nowhere near that crawlspace.")
    game.emit("say", npc_id=npc_id, text=lines[len(game.events) % len(lines)])


def offline_hint(game: Game):
    unfound = [c for c in game.clues.values() if not c["found"]]
    if unfound:
        room = room_by_id(game.layout, unfound[0]["room"])
        game.emit("narrate", text=f"A cold draft pulls you toward the {room['name']} on floor {room['floor'] + 1}.")
    else:
        game.emit("narrate", text="You have every clue. Who benefits if this building looks haunted?")
