"""The AI Director: a LangChain deepagent that designs the haunting from the building's
real data, then watches the player in real time and decides what the ghosts do next."""
import json
import logging
import os

from deepagents import create_deep_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver

from . import data_sources
from .game import GHOSTS, N_ITEMS, Run
from .layout import room_by_id

log = logging.getLogger("director")
MODEL = os.getenv("GM_MODEL", "claude-opus-5-5")
_checkpointer = MemorySaver()


def llm_enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


SETUP_PROMPT = f"""You are the AI Director of "Night Shift", a real-time first-person ghost hunt
inside a real building. Study the building with get_building_record, get_aerial_view and
list_rooms, plan with write_todos, then build the haunting from its REAL facts (year built,
tenants, sales, history):
- set_lore once: a title, a 2-3 sentence intro that cites the building's real history, and
  6 short taunts (under 12 words each) the ghosts will whisper, rooted in that history.
- place_item exactly {N_ITEMS} times: cursed objects tied to the building's past, spread over
  every floor, never in the Stairwell or the entrance room {{exit_room}}. Best ones upstairs.
- spawn_ghost one wisp per floor to start (kinds: {', '.join(GHOSTS)}).
Act only through tools."""

TICK_PROMPT = """You are the AI Director of "Night Shift", a real-time ghost hunt. You get a live
snapshot of the game every few seconds. Make it thrilling but fair, like a horror-game director:
- Player comfortable (high hp, no ghost on their floor, collecting fast): add pressure. Spawn a
  ghost in a room next to them, send a ghost to their room, or kill the lights on their floor.
- Player struggling (hp under 40): ease off. At most one taunt, or send ghosts away.
- After 3+ items are collected, release the banshee once.
- Optionally use haunt_item to move an uncollected item the player is heading toward.
Take 1 to 3 actions with tools, then stop. Keep taunts under 12 words. Act only through tools."""


def _tools(run: Run, setup: bool):
    @tool
    def get_building_record() -> str:
        """CoStar layer: the property record (type, year built, floors, tenants, sales, history)."""
        return json.dumps({k: v for k, v in run.building.items() if k != "raw"})

    @tool
    def get_aerial_view() -> str:
        """Vexcel layer: aerial imagery for this address (the player flies in from it)."""
        return json.dumps({"image_url": data_sources.aerial_image_url(run.building),
                           "lat": run.building.get("lat"), "lng": run.building.get("lng")})

    @tool
    def list_rooms() -> str:
        """Matterport / floor-plan layer: rooms with id, name, floor and adjacent rooms."""
        return json.dumps([{"id": r["id"], "name": r["name"], "floor": r["floor"],
                            "neighbors": r["neighbors"]} for r in run.layout["rooms"]])

    @tool
    def set_lore(title: str, intro: str, taunts: list[str]) -> str:
        """Set the run's title, intro and the ghosts' taunts."""
        run.title, run.intro, run.taunts = title, intro, [t[:100] for t in taunts][:10]
        return "Lore set"

    @tool
    def place_item(room_id: str, name: str, lore: str) -> str:
        """Hide one cursed object in a room. lore: one sentence shown when picked up."""
        if room_id == run.exit_room:
            return "Not in the entrance room"
        return run.place_item(room_id, name, lore)

    @tool
    def spawn_ghost(room_id: str, kind: str) -> str:
        """Spawn a ghost (wisp | poltergeist | banshee) in a room."""
        return run.spawn_ghost(room_id, kind)

    @tool
    def send_ghost(ghost_id: str, room_id: str) -> str:
        """Send a living ghost to hunt in a room (any floor; ghosts phase through floors)."""
        return run.send_ghost(ghost_id, room_id)

    @tool
    def kill_lights(floor: int, seconds: float) -> str:
        """Black out a floor for 1-8 seconds."""
        return run.flicker(floor, seconds)

    @tool
    def taunt(text: str) -> str:
        """Whisper a taunt on the player's screen."""
        return run.taunt(text)

    @tool
    def haunt_item(item_id: str, room_id: str) -> str:
        """Teleport an uncollected cursed object to another room."""
        return run.haunt_item(item_id, room_id)

    if setup:
        return [get_building_record, get_aerial_view, list_rooms, set_lore, place_item, spawn_ghost]
    return [list_rooms, spawn_ghost, send_ghost, kill_lights, taunt, haunt_item]


def _model(effort: str):
    return ChatAnthropic(model=MODEL, max_tokens=16000, output_config={"effort": effort},
                         betas=["server-side-fallback-2026-07-01"],
                         model_kwargs={"fallbacks": "default"})


class Director:
    def __init__(self, run: Run):
        self.run = run
        self.setup_agent = create_deep_agent(
            model=_model("low"), tools=_tools(run, True),
            system_prompt=SETUP_PROMPT.replace("{exit_room}", run.exit_room),
            checkpointer=_checkpointer)
        self.tick_agent = create_deep_agent(model=_model("low"), tools=_tools(run, False),
                                            system_prompt=TICK_PROMPT)
        self.ticks = 0

    def setup(self):
        cfg = {"configurable": {"thread_id": f"{self.run.id}-setup"}, "recursion_limit": 80}
        self.setup_agent.invoke({"messages": [{"role": "user", "content": "Design the haunting now."}]}, cfg)
        if self.run.ready():
            self.setup_agent.invoke({"messages": [{"role": "user", "content":
                                     "Not ready: " + "; ".join(self.run.ready()) + ". Fix it."}]}, cfg)
        if self.run.ready():
            raise RuntimeError("Director setup incomplete: " + "; ".join(self.run.ready()))

    def tick(self):
        """One real-time decision. Fresh context each tick, with a short memory of past moves."""
        self.ticks += 1
        run, s = self.run, self.run.snapshot
        alive = [{"id": g["id"], "kind": g["kind"], "room": g["room"],
                  "floor": room_by_id(run.layout, g["room"])["floor"]}
                 for g in run.ghosts.values() if g["alive"]]
        uncollected = [{"id": i["id"], "room": i["room"]} for i in run.items.values() if not i["collected"]]
        msg = json.dumps({
            "player": s, "ghosts_alive": alive, "uncollected_items": uncollected,
            "items_collected": sum(i["collected"] for i in run.items.values()),
            "your_last_moves": run.director_log[-3:], "taunts_available": run.taunts,
        })
        before = len(run.commands)
        self.tick_agent.invoke({"messages": [{"role": "user", "content": "SNAPSHOT " + msg}]},
                               {"recursion_limit": 25})
        acts = [c["kind"] for c in run.commands[before:]]
        run.director_log.append(", ".join(acts) or "watching")
