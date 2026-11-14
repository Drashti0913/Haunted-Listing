import logging
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import data_sources, nessie  # noqa: E402
from .agent import GameMaster, llm_enabled  # noqa: E402
from .game import Game, offline_hint, offline_setup, offline_talk  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("api")
app = FastAPI(title="Haunted Listing")
GAMES: dict[str, Game] = {}
GMS: dict[str, GameMaster] = {}
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"


class NewGame(BaseModel):
    building_id: str


class Talk(BaseModel):
    npc_id: str
    message: str
    since: int = 0


class Act(BaseModel):
    since: int = 0
    clue_id: str | None = None
    npc_id: str | None = None


def integrations() -> dict:
    """Which sponsor tools are live right now (shown on the title screen)."""
    return {
        "costar": bool(data_sources.COSTAR_API_BASE and data_sources.COSTAR_API_KEY),
        "vexcel": bool(data_sources.VEXCEL_IMAGE_URL),
        "matterport": bool(data_sources.MATTERPORT_SDK_KEY),
        "deepagents": llm_enabled(),
        "nessie": nessie.enabled(),
    }


@app.get("/api/health")
def health():
    return {"ok": True, "llm": llm_enabled(), "integrations": integrations()}


@app.get("/api/buildings")
def buildings():
    out = []
    for b in data_sources.list_buildings():
        out.append({**{k: b.get(k) for k in ("id", "name", "address", "city", "property_type",
                                            "year_built", "floors", "lat", "lng")},
                    "aerial_image_url": data_sources.aerial_image_url(b),
                    "has_scan": bool(data_sources.matterport_info(b))})
    return {"buildings": out, "llm": llm_enabled(), "integrations": integrations()}


def _game(gid: str) -> Game:
    if gid not in GAMES:
        raise HTTPException(404, "game not found")
    return GAMES[gid]


@app.post("/api/games")
async def new_game(req: NewGame):
    try:
        building = data_sources.get_building(req.building_id)
    except KeyError:
        raise HTTPException(404, "building not found")
    game = Game(building)
    gm_mode = "offline"
    if llm_enabled():
        try:
            gm = GameMaster(game)
            await run_in_threadpool(gm.setup)
            GMS[game.id] = gm
            gm_mode = "ai"
        except Exception:
            log.exception("AI setup failed, using offline game master")
            game = Game(building)
    if gm_mode == "offline":
        offline_setup(game)
    GAMES[game.id] = game
    return {**game.public(), "gm": gm_mode,
            "aerial_image_url": data_sources.aerial_image_url(building),
            "matterport": data_sources.matterport_info(building)}


async def _gm_event(game: Game, text: str, fallback):
    gm = GMS.get(game.id)
    if gm:
        try:
            await run_in_threadpool(gm.event, text)
            return
        except Exception:
            log.exception("GM turn failed, using offline reply")
    fallback()


@app.post("/api/games/{gid}/talk")
async def talk(gid: str, req: Talk):
    game = _game(gid)
    if req.npc_id not in game.npcs:
        raise HTTPException(400, "unknown npc")
    found = [c["name"] for c in game.clues.values() if c["found"]]
    n = game.npcs[req.npc_id]
    await _gm_event(game,
                    f"PLAYER_TALK to {req.npc_id} ({n['name']}, in {n['room']}). "
                    f"Clues the player has found: {found or 'none'}. Player says: {req.message[:500]}",
                    lambda: offline_talk(game, req.npc_id, req.message))
    return game.public(req.since)


@app.post("/api/games/{gid}/found")
async def found(gid: str, req: Act):
    game = _game(gid)
    clue = game.clues.get(req.clue_id or "")
    if not clue:
        raise HTTPException(400, "unknown clue")
    if not clue["found"]:
        clue["found"] = True
        game.emit("found", clue_id=clue["id"])
        n_found = sum(c["found"] for c in game.clues.values())
        await _gm_event(game,
                        f"PLAYER_FOUND {clue['id']} '{clue['name']}' in {clue['room']}. "
                        f"{n_found}/{len(game.clues)} clues found.",
                        lambda: game.emit("narrate", text=f"You found: {clue['name']}."))
    return game.public(req.since)


@app.post("/api/games/{gid}/hint")
async def hint(gid: str, req: Act):
    game = _game(gid)
    game.hints_used += 1
    unfound = [f"{c['id']} in {c['room']}" for c in game.clues.values() if not c["found"]]
    await _gm_event(game, f"PLAYER_HINT. Unfound clues: {unfound or 'none'}",
                    lambda: offline_hint(game))
    return game.public(req.since)


@app.post("/api/games/{gid}/accuse")
async def accuse(gid: str, req: Act):
    game = _game(gid)
    if game.status != "playing":
        return game.public(req.since)
    if req.npc_id not in game.npcs:
        raise HTTPException(400, "unknown npc")
    correct = req.npc_id == game.culprit_id
    game.status = "won" if correct else "lost"
    verdict = "CORRECT, the player wins" if correct else (
        f"WRONG, the real culprit was {game.npcs[game.culprit_id]['name']}")
    await _gm_event(game, f"PLAYER_ACCUSE {req.npc_id}. Verdict: {verdict}. Solution: {game.solution}",
                    lambda: game.emit("narrate", text=("Case closed! " if correct else "Wrong suspect. ") + game.solution))
    return game.public(req.since)


@app.post("/api/games/{gid}/bank")
async def bank(gid: str, req: Act):
    """The in-game bank terminal: live Capital One Nessie statements for every suspect."""
    game = _game(gid)
    if not game.bank_enabled:
        raise HTTPException(400, "Capital One banking is not configured")
    try:
        records = await run_in_threadpool(nessie.statements, game)
    except Exception as e:
        log.exception("Nessie statements failed")
        raise HTTPException(502, f"Bank unavailable: {e}")
    if not game.bank_viewed:
        game.bank_viewed = True
        game.emit("bank_viewed")
        await _gm_event(game, "PLAYER_BANK: the player pulled everyone's bank records.",
                        lambda: game.emit("narrate", text="The statements print out. Someone has been spending a lot on special effects…"))
    return {"records": records, **game.public(req.since)}


@app.get("/api/games/{gid}")
def get_game(gid: str, since: int = 0):
    return _game(gid).public(since)


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
