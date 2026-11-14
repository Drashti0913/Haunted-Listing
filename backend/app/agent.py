"""The AI Game Master: a LangChain deepagent that reads the building's data,
plans a mystery, places suspects and clues in real rooms, then reacts live
to what the player does."""
import json
import logging
import os

from deepagents import create_deep_agent
from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langgraph.checkpoint.memory import MemorySaver

from . import data_sources
from .game import Game
from .layout import room_by_id

log = logging.getLogger("gm")
MODEL = os.getenv("GM_MODEL", "claude-opus-5-5")
_checkpointer = MemorySaver()


def llm_enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


SYSTEM_PROMPT = """You are the Game Master of "Haunted Listing", a 3D mystery game that
takes place inside a real building. Your job has two phases.

SETUP: Study the building with get_building_record, get_aerial_view and list_rooms.
Write a short plan with write_todos first. Then build a mystery rooted in this building's
real history, tenants, year built and last sale (a "haunting" that someone is faking, a
lost deed, a sabotaged sale, and so on). Call set_story once, spawn exactly 3 or 4 suspects
with spawn_npc, and place 4 to 6 clues with place_clue. Use the rooms on purpose: clues go
where they make physical sense (blueprints in an archive, a fog machine near a vent), spread
them across floors so the player has to explore, and keep each suspect away from the clue
that incriminates them. Exactly one suspect is the culprit; every clue's points_to names the
suspect id it implicates (red herrings may point at innocents, but at least 3 clues must point
at the culprit). Keep text short and vivid: clue descriptions under 40 words.

PLAY: You will get messages starting with PLAYER_. React like a living world:
- PLAYER_TALK: answer in character with npc_say (1 to 3 sentences). Innocent suspects tell
  the truth but hide their secret; the culprit lies, but slips if the player cites a found clue.
- PLAYER_FOUND: narrate the discovery in one sentence. You may raise the stakes: move a
  suspect with move_npc, or (at most twice per game) place a new clue.
- PLAYER_HINT: nudge toward an unfound clue's room with narrate, without naming the culprit.
- PLAYER_ACCUSE: narrate a dramatic 2-3 sentence ending matching the verdict you are given.
Always act through tools; your plain-text reply is ignored by the game."""


def _make_tools(game: Game):
    @tool
    def get_building_record() -> str:
        """CoStar layer: the building's property record (type, year built, floors, tenants, sales, history)."""
        b = {k: v for k, v in game.building.items() if k != "raw"}
        return json.dumps(b)

    @tool
    def get_aerial_view() -> str:
        """Vexcel layer: aerial imagery and surroundings for this address."""
        url = data_sources.aerial_image_url(game.building)
        return json.dumps({"image_url": url, "lat": game.building.get("lat"),
                           "lng": game.building.get("lng"),
                           "note": "Players fly in from this aerial view before entering."})

    @tool
    def list_rooms() -> str:
        """Matterport / floor-plan layer: every room with id, name, floor and adjacent rooms."""
        rooms = [{"id": r["id"], "name": r["name"], "floor": r["floor"] + 1,
                  "neighbors": [room_by_id(game.layout, n)["name"] for n in r["neighbors"]]}
                 for r in game.layout["rooms"]]
        scan = data_sources.matterport_info(game.building)
        return json.dumps({"rooms": rooms, "real_3d_scan": bool(scan)})

    @tool
    def set_story(title: str, intro: str, mystery: str, solution: str, culprit_npc_id: str) -> str:
        """Set the mystery. intro: 2-3 sentences shown on arrival. mystery: the player's goal in one
        sentence. solution: what really happened. culprit_npc_id: id returned by spawn_npc (e.g. npc2);
        call this after spawning suspects."""
        game.title, game.intro, game.mystery, game.solution = title, intro, mystery, solution
        game.culprit_id = culprit_npc_id
        return "Story set"

    @tool
    def spawn_npc(name: str, role: str, room_id: str, persona: str, secret: str, alibi: str) -> str:
        """Place a suspect in a room. Returns the npc id."""
        return game.spawn_npc(name, role, room_id, persona, secret, alibi)

    @tool
    def place_clue(room_id: str, name: str, description: str, points_to: str) -> str:
        """Hide a clue in a room. points_to is the npc id it implicates."""
        out = game.place_clue(room_id, name, description, points_to)
        if game.events:  # mid-game: tell the client a new clue appeared
            game.emit("clue_added")
        return out

    @tool
    def move_npc(npc_id: str, room_id: str) -> str:
        """Move a suspect to another room (they react to the player's progress)."""
        return game.move_npc(npc_id, room_id)

    @tool
    def npc_say(npc_id: str, text: str) -> str:
        """Speak as a suspect."""
        if npc_id not in game.npcs:
            return "Unknown npc"
        game.emit("say", npc_id=npc_id, text=text)
        return "said"

    @tool
    def narrate(text: str) -> str:
        """Game-master narration shown to the player."""
        game.emit("narrate", text=text)
        return "narrated"

    return [get_building_record, get_aerial_view, list_rooms, set_story, spawn_npc,
            place_clue, move_npc, npc_say, narrate]


def _model(effort: str):
    return ChatAnthropic(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": effort},
        # Server-side fallback if a request is declined by a safety classifier.
        betas=["server-side-fallback-2026-07-01"],
        model_kwargs={"fallbacks": "default"},
    )


class GameMaster:
    def __init__(self, game: Game):
        self.game = game
        tools = _make_tools(game)
        self.setup_agent = create_deep_agent(model=_model("medium"), tools=tools,
                                             system_prompt=SYSTEM_PROMPT,
                                             checkpointer=_checkpointer)
        self.play_agent = create_deep_agent(model=_model("low"), tools=tools,
                                            system_prompt=SYSTEM_PROMPT,
                                            checkpointer=_checkpointer)
        self.cfg = {"configurable": {"thread_id": game.id}, "recursion_limit": 80}

    def _run(self, agent, text: str):
        agent.invoke({"messages": [{"role": "user", "content": text}]}, self.cfg)

    def setup(self):
        self._run(self.setup_agent, "Set up a new game for this building now.")
        problems = self.game.ready()
        if problems:
            self._run(self.setup_agent, "The game is not ready: " + "; ".join(problems) + ". Fix it with the tools.")
        if self.game.ready():
            raise RuntimeError("GM setup incomplete: " + "; ".join(self.game.ready()))
        self.game.emit("narrate", text=self.game.intro)

    def event(self, text: str):
        self._run(self.play_agent, text)
