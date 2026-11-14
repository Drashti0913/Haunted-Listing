import asyncio
import logging
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.concurrency import run_in_threadpool  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from . import data_sources, nessie  # noqa: E402
from .agent import Director, llm_enabled  # noqa: E402
from .game import GHOSTS, SHOP, Run, offline_setup, rules_director  # noqa: E402

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("api")
app = FastAPI(title="Haunted Listing: Night Shift")
RUNS: dict[str, Run] = {}
DIRECTORS: dict[str, Director] = {}
FRONTEND = Path(__file__).resolve().parents[2] / "frontend"
DIRECTOR_EVERY = 14.0    # seconds between director decisions (free Gemini tier: ~10 requests/min)


class NewRun(BaseModel):
    building_id: str


class Tick(BaseModel):
    since: int = 0
    snapshot: dict = {}


class Act(BaseModel):
    since: int = 0
    ghost_id: str | None = None
    item_id: str | None = None
    item: str | None = None
    result: str | None = None
    stats: dict = {}


def integrations() -> dict:
    return {
        "costar": bool(data_sources.COSTAR_API_BASE and data_sources.COSTAR_API_KEY),
        "vexcel": bool(data_sources.VEXCEL_IMAGE_URL),
        "matterport": bool(data_sources.MATTERPORT_SDK_KEY),
        "deepagents": llm_enabled(),
        "nessie": nessie.enabled(),
    }


@app.get("/api/health")
def health():
    return {"ok": True, "integrations": integrations()}


@app.get("/api/buildings")
def buildings():
    out = [{**{k: b.get(k) for k in ("id", "name", "address", "city", "property_type",
                                     "year_built", "floors", "lat", "lng")},
            "has_scan": bool(data_sources.matterport_info(b))}
           for b in data_sources.list_buildings()]
    return {"buildings": out, "integrations": integrations()}


def _run(rid: str) -> Run:
    if rid not in RUNS:
        raise HTTPException(404, "run not found")
    return RUNS[rid]


@app.post("/api/runs")
async def new_run(req: NewRun):
    try:
        building = data_sources.get_building(req.building_id)
    except KeyError:
        raise HTTPException(404, "building not found")
    run = Run(building)
    if llm_enabled():
        try:
            d = Director(run)
            await run_in_threadpool(d.setup)
            DIRECTORS[run.id] = d
            run.director_mode = "ai"
        except Exception:
            log.exception("AI Director setup failed; using the rule-based director")
            run = Run(building)
    if run.director_mode != "ai":
        offline_setup(run)
    if nessie.enabled():
        try:
            await run_in_threadpool(nessie.open_wallet, run)
        except Exception:
            log.exception("Nessie wallet failed; using a local wallet")
    run.started = time.time()
    RUNS[run.id] = run
    return {**run.public(), "aerial_image_url": data_sources.aerial_image_url(building),
            "matterport": data_sources.matterport_info(building)}


async def _direct(run: Run):
    """One director decision in the background so the game never waits on it."""
    try:
        d = DIRECTORS.get(run.id)
        if d:
            try:
                await run_in_threadpool(d.tick)
                return
            except Exception:
                log.exception("AI Director tick failed; rules this tick")
        rules_director(run)
    finally:
        run.director_busy = False
        run.last_director = time.time()


@app.post("/api/runs/{rid}/tick")
async def tick(rid: str, req: Tick):
    run = _run(rid)
    run.snapshot = req.snapshot
    if run.wallet["live"] and time.time() - run.wallet["refreshed"] > 3:
        run.wallet["refreshed"] = time.time()
        await run_in_threadpool(nessie.refresh, run)
    if (run.status == "playing" and not run.director_busy
            and time.time() - run.last_director > DIRECTOR_EVERY):
        run.director_busy = True
        asyncio.create_task(_direct(run))
    return run.public(req.since)


@app.post("/api/runs/{rid}/collect")
def collect(rid: str, req: Act):
    run = _run(rid)
    it = run.items.get(req.item_id or "")
    if not it:
        raise HTTPException(400, "unknown item")
    it["collected"] = True
    return run.public(req.since)


@app.post("/api/runs/{rid}/capture")
async def capture(rid: str, req: Act):
    run = _run(rid)
    g = run.ghosts.get(req.ghost_id or "")
    if not g or not g["alive"]:
        return run.public(req.since)        # already paid, no double bounty
    g["alive"] = False
    cents = GHOSTS[g["kind"]]["bounty"]
    run.wallet["earned"] += cents
    if run.wallet["live"]:
        try:
            tx = await run_in_threadpool(nessie.pay_bounty, run, cents, f"Bounty: {g['kind']} {g['id']} captured")
            run.wallet["last_tx"] = {"id": tx.get("id"), "kind": "transfer", "status": tx.get("status"),
                                     "amount": cents}
            await run_in_threadpool(nessie.refresh, run)
            return run.public(req.since)
        except Exception:
            log.exception("bounty transfer failed")
    run.wallet["balance"] = run.wallet["earned"] - run.wallet["spent"]
    return run.public(req.since)


@app.post("/api/runs/{rid}/shop")
async def shop(rid: str, req: Act):
    run = _run(rid)
    item = SHOP.get(req.item or "")
    if not item:
        raise HTTPException(400, "unknown item")
    price = item["price"]
    w = run.wallet
    if w["earned"] - w["spent"] < price:      # game rule: spend only what bounties earned
        raise HTTPException(402, f"Not enough bounty: you have {(w['earned'] - w['spent']) / 100:.2f} USD. Capture more ghosts!")
    if w["live"]:
        try:
            tx = await run_in_threadpool(nessie.buy, run, price, f"{item['name']} ({run.title})")
        except nessie.InsufficientFunds:
            raise HTTPException(402, "Capital One declined the card: credit limit reached.")
        except Exception as e:
            log.exception("purchase failed")
            raise HTTPException(502, f"Bank unavailable: {e}")
        w["last_tx"] = {"id": tx.get("id"), "kind": "card purchase", "status": tx.get("status"), "amount": price}
    w["spent"] += price
    if not w["live"]:
        w["balance"] = w["earned"] - w["spent"]
    return {**run.public(req.since), "bought": req.item}


@app.post("/api/runs/{rid}/finish")
async def finish(rid: str, req: Act):
    run = _run(rid)
    if run.status == "playing":
        run.status = req.result if req.result in ("escaped", "dead", "dawn") else "dead"
        s = req.stats
        got = s.get("collected", 0)
        lines = {
            "escaped": f"You walked out with all {len(run.items)} cursed objects.",
            "dead": f"The ghosts drained your health with {got}/{len(run.items)} objects in hand. "
                    "Tip: hold your UV beam on ghosts to capture them, and buy a med kit at the ATM.",
            "dawn": f"Dawn came with {got}/{len(run.items)} objects collected.",
        }
        run.epilogue = (f"{lines[run.status]} Ghosts captured: {s.get('captures', 0)}. "
                        f"Bounty earned: ${run.wallet['earned'] / 100:,.2f}.")
    return run.public(req.since)


@app.get("/api/runs/{rid}")
def get_run(rid: str, since: int = 0):
    return _run(rid).public(since)


@app.middleware("http")
async def no_stale_game_files(request, call_next):
    """Always serve the latest game files, so players never run an old cached version."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
