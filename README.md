# Haunted Listing: Night Shift

**A real-time ghost hunt inside real buildings. An AI Director watches you play and decides what haunts you next.**

HackPrinceton Fall 2026 · Entertainment track · CoStar "AI for the Built World" · LangChain deepagents · Capital One Nessie

## The game

Pick a real building in Houston or Los Angeles, fly in from above, and work the night shift in first person.
Collect the 5 cursed objects hidden across its floors and escape through the front door before dawn (5 minutes).
Ghosts hunt you through the rooms. Hold your UV beam on them to capture them. Wisps are fast, poltergeists
are tougher, and the banshee is the boss. Every capture pays a bounty into your bank account, and you spend it
at the ATM by the entrance on upgrades.

Controls: **WASD** move · **Shift** sprint · **mouse** look · **hold click / Space** UV beam · **E** use, stairs up · **Q** stairs down.
(If the mouse doesn't lock, click and drag to look and use Space for the beam.)

## Company tools, used live during play

| Company | Tool | Live role in the game | Env var |
|---|---|---|---|
| LangChain | `deepagents` | **AI Director.** Designs the haunting from the building's real data (lore, taunts, where the cursed objects go), then every ~7 s reads a live snapshot (your floor, health, objects, nearby ghosts) and acts: spawns ghosts, sends hunters to your room, kills the lights, moves objects, taunts you. | `ANTHROPIC_API_KEY` |
| Capital One | Nessie v2 API | **Real economy.** Each run opens a real wallet account and a Bounty Office account. Every capture is a real transfer; every upgrade at the in-game ATM is a real purchase. The bank declines what you can't afford. The HUD shows the live balance and the transaction id. | `NESSIE_API_KEY` |
| CoStar Group | Building data · Vexcel aerial · Matterport scans | **The level.** The property record drives the floors and the ghost story. Vexcel imagery is the ground in the fly-in. Matterport opens the real scan. | `COSTAR_*`, `VEXCEL_IMAGE_URL`, `MATTERPORT_SDK_KEY` |

The title screen shows which tools are live (● LIVE / ○ off). Every tool has a fallback, so the game always runs:
a rule-based director, a local wallet, and sample buildings. The sample buildings in `data/buildings.json` are
made up, not CoStar records.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # add your keys
.venv/bin/uvicorn backend.app.main:app --port 8080
```

Open http://localhost:8080.

## Deploy to AWS (App Runner)

1. `brew install awscli`, start Docker Desktop, then `aws configure` with your own AWS keys.
2. Put your keys in `.env`.
3. `bash deploy/aws_deploy.sh` (about 5 minutes; it prints the public https link). Re-run to ship updates.
4. Cost is about $0.06–0.10/hour. Delete the `haunted-listing` service in App Runner when you're done.

## How it works

```
browser (Three.js)                         server (FastAPI)
  movement, ghost chase AI, UV beam   ⇄   /api/runs            start a run (Director setup + Nessie wallet)
  every 2.5 s: POST /tick snapshot    →   /api/runs/{id}/tick  stores snapshot; runs a Director decision in the
  ← Director commands (spawn/send/                              background every ~7 s, returns new commands
     lights/taunt/move object)
  capture → /capture                   →  Nessie transfer (bounty)
  ATM → /shop                          →  Nessie purchase (upgrade)
```

- `backend/app/agent.py`: deepagents Director (setup tools + live tick tools)
- `backend/app/nessie.py`: Capital One Nessie client (wallet, bounties, purchases, balance)
- `backend/app/game.py`: run state, ghost and shop tables, offline setup, rule-based director
- `backend/app/data_sources.py`: CoStar / Vexcel / Matterport adapters (plug real endpoints in here)
- `frontend/main.js`: the game

## 2-minute pitch

1. **Hook (10 s):** "Every building has a past. We made it come for you."
2. **Live demo (80 s):** pick a building → fly in → the intro cites its real history → capture a wisp (show the
   real Capital One transfer appear) → buy a med kit at the ATM → the AI Director kills the lights and sends the
   banshee → escape.
3. **How (20 s):** CoStar data builds the level, a LangChain deepagent directs the scares in real time, and
   Capital One Nessie runs the economy.
4. **Next (10 s):** horror tours of real cities, an escape-room mode for real venues, gamified open houses.
