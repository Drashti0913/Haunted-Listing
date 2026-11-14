"""Night Shift: a real-time ghost hunt inside a real building.

The browser runs the action (movement, ghosts chasing, the UV beam). The server
holds the run, pays bounties through Capital One Nessie, and streams commands
from the AI Director (deepagents) or, without an API key, the rule-based director."""
import random
import time
import uuid

from .layout import build_layout, room_by_id

GHOSTS = {   # hp, speed (m/s), damage per second, bounty in cents
    "wisp":        {"hp": 30,  "speed": 2.6, "dps": 8,  "bounty": 2500,  "label": "Wisp"},
    "poltergeist": {"hp": 70,  "speed": 2.1, "dps": 14, "bounty": 6000,  "label": "Poltergeist"},
    "banshee":     {"hp": 220, "speed": 1.8, "dps": 26, "bounty": 25000, "label": "Banshee"},
}
SHOP = {     # item -> price in cents, what it does (applied in the browser)
    "battery": {"price": 4000,  "name": "Extended battery", "desc": "+60% beam battery"},
    "medkit":  {"price": 3000,  "name": "Med kit",          "desc": "Heal to full"},
    "boots":   {"price": 6000,  "name": "Sprint boots",     "desc": "+30% move speed"},
    "lance":   {"price": 12000, "name": "UV lance",         "desc": "Double beam damage"},
}
ITEMS = {
    "office": ["Cracked trading ledger", "Stopped pocket watch", "Bloodstained memo", "Ticker tape reel",
               "Brass desk key", "Founder's portrait"],
    "multifamily": ["Rusted mailbox key", "Child's music box", "Torn eviction notice", "Hollywood headshot",
                    "Cold teacup", "Locket with no photo"],
    "retail": ["Haunted bowling pin", "Glitching arcade token", "Pawned wedding ring", "Fortune cookie (unopened)",
               "Prize ticket roll", "Neon sign letter"],
}
N_ITEMS = 5
TIME_LIMIT = 300


class Run:
    def __init__(self, building: dict):
        self.id = uuid.uuid4().hex[:10]
        self.building = building
        self.layout = build_layout(building)
        self.title = ""
        self.intro = ""
        self.taunts: list[str] = []
        self.items: dict[str, dict] = {}
        self.ghosts: dict[str, dict] = {}
        self.commands: list[dict] = []
        self.status = "playing"
        self.started = time.time()
        rooms = self.layout["rooms"]
        self.exit_room = next(r["id"] for r in rooms if r["floor"] == 0)
        self.atm_room = self.exit_room
        # director bookkeeping
        self.snapshot: dict = {}
        self.director_busy = False
        self.last_director = 0.0
        self.director_log: list[str] = []
        self.director_mode = "rules"
        # wallet (Capital One Nessie when configured, else local)
        self.wallet = {"live": False, "earned": 0, "spent": 0, "balance": 0, "pending": 0, "refreshed": 0.0,
                       "player_account": None, "bank_account": None, "merchant": None, "last_tx": None}
        self.epilogue = ""

    # ---------------------------------------------------------------- commands
    def cmd(self, kind: str, **data):
        c = {"seq": len(self.commands), "kind": kind, **data}
        self.commands.append(c)
        return c

    def spawn_ghost(self, room_id: str, kind: str = "wisp") -> str:
        if kind not in GHOSTS:
            return f"Unknown ghost kind {kind}; use one of {list(GHOSTS)}"
        if not room_by_id(self.layout, room_id):
            return f"Unknown room {room_id}"
        alive = sum(g["alive"] for g in self.ghosts.values())
        if alive >= 9:
            return "Too many ghosts alive (max 9). Use send_ghost instead."
        if kind == "banshee" and any(g["alive"] and g["kind"] == "banshee" for g in self.ghosts.values()):
            return "A banshee is already loose."
        gid = f"g{len(self.ghosts) + 1}"
        self.ghosts[gid] = {"id": gid, "kind": kind, "room": room_id, "alive": True}
        self.cmd("spawn", ghost={"id": gid, "kind": kind, "room": room_id, **GHOSTS[kind]})
        return f"Spawned {kind} {gid} in {room_id}"

    def send_ghost(self, ghost_id: str, room_id: str) -> str:
        g = self.ghosts.get(ghost_id)
        if not g or not g["alive"] or not room_by_id(self.layout, room_id):
            return "Invalid ghost or room"
        g["room"] = room_id
        self.cmd("send", ghost_id=ghost_id, room=room_id)
        return f"{ghost_id} now hunting toward {room_id}"

    def flicker(self, floor: int, seconds: float = 4) -> str:
        self.cmd("flicker", floor=int(floor), seconds=max(1.0, min(float(seconds), 8.0)))
        return f"Lights out on floor {floor}"

    def taunt(self, text: str) -> str:
        self.cmd("taunt", text=text[:140])
        return "Taunted"

    def haunt_item(self, item_id: str, room_id: str) -> str:
        it = self.items.get(item_id)
        if not it or it["collected"] or not room_by_id(self.layout, room_id):
            return "Invalid item or room"
        it["room"] = room_id
        self.cmd("move_item", item_id=item_id, room=room_id)
        return f"{it['name']} vanished and reappeared in {room_id}"

    def place_item(self, room_id: str, name: str, lore: str) -> str:
        if not room_by_id(self.layout, room_id) or len(self.items) >= N_ITEMS:
            return "Invalid room or already 5 items"
        iid = f"i{len(self.items) + 1}"
        self.items[iid] = {"id": iid, "room": room_id, "name": name, "lore": lore, "collected": False}
        return f"Placed {iid}"

    def ready(self) -> list[str]:
        p = []
        if not self.title:
            p.append("call set_lore")
        if len(self.items) != N_ITEMS:
            p.append(f"place exactly {N_ITEMS} items (have {len(self.items)})")
        if not self.ghosts:
            p.append("spawn at least one ghost")
        return p

    def public(self, since: int = 0) -> dict:
        b = self.building
        return {
            "id": self.id, "status": self.status, "title": self.title, "intro": self.intro,
            "building": {k: b.get(k) for k in ("id", "name", "address", "city", "lat", "lng",
                                                "property_type", "year_built", "floors", "history")},
            "layout": self.layout, "exit_room": self.exit_room, "atm_room": self.atm_room,
            "time_limit": TIME_LIMIT, "ghost_types": GHOSTS, "shop": SHOP,
            "items": list(self.items.values()),
            "commands": self.commands[since:],
            "wallet": self.wallet_view(),
            "director": {"mode": self.director_mode, "busy": self.director_busy,
                         "last": self.director_log[-1] if self.director_log else ""},
            "epilogue": self.epilogue,
        }

    def wallet_view(self) -> dict:
        w = self.wallet
        return {"live": w["live"], "earned": w["earned"], "spent": w["spent"],
                "balance": w["balance"], "pending": w["pending"], "last_tx": w["last_tx"]}


# --------------------------------------------------------------------------- offline setup
def offline_setup(run: Run):
    b = run.building
    rnd = random.Random(b["id"] + run.id)
    year = b.get("year_built") or 1970
    history = b.get("history") or ["Nobody remembers who built it"]
    name = b["name"].split("(")[0].strip()
    run.title = f"Night Shift at {name}"
    run.intro = (f"Built in {year}. {history[0]}. {history[-1]}. Since then, the night crew stopped "
                 f"coming back. Collect the {N_ITEMS} cursed objects and get out before dawn.")
    run.taunts = [f"This building was mine in {year}.", "You can't sell what belongs to the dead.",
                  "The lights are mine.", f"{history[0]}... and you walked right in.",
                  "Every floor remembers.", "Run faster."]
    rooms = [r for r in run.layout["rooms"] if r["name"] != "Stairwell" and r["id"] != run.exit_room]
    rnd.shuffle(rooms)
    rooms.sort(key=lambda r: -r["floor"])            # hide the best stuff upstairs
    names = ITEMS.get(b.get("property_type"), ITEMS["office"])
    for i in range(N_ITEMS):
        r = rooms[i % len(rooms)]
        run.place_item(r["id"], names[i], f"It hums when you touch it. Floor {r['floor'] + 1}, {r['name']}.")
    for f in range(run.layout["floors"]):
        cand = [r for r in run.layout["rooms"] if r["floor"] == f and r["id"] != run.exit_room]
        run.spawn_ghost(rnd.choice(cand)["id"], "wisp")


# --------------------------------------------------------------------------- rule-based director
def rules_director(run: Run):
    s = run.snapshot
    if not s:
        return
    rnd = random.Random()
    floor = s.get("floor", 0)
    here = s.get("room")
    alive = [g for g in run.ghosts.values() if g["alive"]]
    on_floor = [g for g in alive if room_by_id(run.layout, g["room"])["floor"] == floor]
    collected = sum(i["collected"] for i in run.items.values())
    hp = s.get("hp", 100)
    near = [r for r in run.layout["rooms"] if r["floor"] == floor and r["id"] != here]
    acted = []
    if not on_floor and near:
        acted.append(run.spawn_ghost(rnd.choice(near)["id"], "wisp" if hp < 50 else rnd.choice(["wisp", "poltergeist"])))
    elif hp > 60 and len(on_floor) < 3 and near:
        acted.append(run.spawn_ghost(rnd.choice(near)["id"], "poltergeist"))
    if collected >= 3 and not any(g["kind"] == "banshee" for g in run.ghosts.values()) and near:
        acted.append(run.spawn_ghost(rnd.choice(near)["id"], "banshee"))
        acted.append(run.taunt("You took what was mine. Now I take you."))
    if alive and here and hp > 40:
        g = rnd.choice(alive)
        acted.append(run.send_ghost(g["id"], here))
    if rnd.random() < 0.3:
        acted.append(run.flicker(floor, 3))
    if rnd.random() < 0.35 and run.taunts:
        acted.append(run.taunt(rnd.choice(run.taunts)))
    run.director_log.append("; ".join(acted) or "watching")
