# Haunted Listing

**Every real building has a story. An AI game master turns it into a 3D mystery you can walk through.**

HackPrinceton Fall 2026 · Entertainment track · CoStar "AI for the Built World" · LangChain deepagents · Capital One Nessie

## Company tools used (live, not mocked)

| Company | Tool | What it does in the game | Env var |
|---|---|---|---|
| CoStar Group | Building data, Vexcel aerial imagery, Matterport 3D scans | Facts the mystery is built from, the fly-in view, the real interior | `COSTAR_*`, `VEXCEL_IMAGE_URL`, `MATTERPORT_SDK_KEY` |
| LangChain | `deepagents` | The AI game master: plans, places suspects and clues, reacts live | `ANTHROPIC_API_KEY` |
| Capital One | Nessie v2 API | Every suspect gets a real bank account; the GM writes the money trail as real purchases and transfers; a bank terminal in the building pulls statements live | `NESSIE_API_KEY` |

The title screen shows which of these are live (● LIVE / ○ off).

Pick a building in Houston or Los Angeles. You fly in from the aerial view (Vexcel layer)
and walk its floors in first person (Matterport / floor-plan layer). A LangChain **deepagent**
game master reads the property record (CoStar layer): year built, tenants, sales, history.
It plans a mystery rooted in those facts and places suspects and clues in the rooms where
they make physical sense. It then reacts live: suspects answer in character, move when you
get close, and the GM hints when you're stuck.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env        # add ANTHROPIC_API_KEY (and CoStar/Vexcel/Matterport keys when you have them)
.venv/bin/uvicorn backend.app.main:app --port 8080
```

Open http://localhost:8080. Without `ANTHROPIC_API_KEY` the game runs with a built-in offline
game master, so the demo never breaks.

Controls: WASD move, mouse look (click the scene first; if the mouse doesn't lock, drag to look),
**E** talk / examine / stairs up, **Q** stairs down, **J** journal + accuse, **H** hint.

## Deploy to AWS (App Runner)

1. Install the AWS CLI (`brew install awscli`) and start Docker Desktop.
2. `aws configure` with your own AWS access key (region `us-east-1` is fine).
3. Put your keys in `.env`.
4. `bash deploy/aws_deploy.sh` and wait about 5 minutes. It prints a public `https://…awsapprunner.com` link.

Re-run step 4 to ship updates. Cost is about $0.06–0.10 per hour while it runs (1 vCPU / 2 GB, one instance).
To stop paying: delete the `haunted-listing` service in the App Runner console.

## Plugging in the real CoStar data (do this first!)

All data access is in `backend/app/data_sources.py`.

- **CoStar**: set `COSTAR_API_BASE`, `COSTAR_API_KEY`, `COSTAR_PROPERTY_PATH`; map the payload in `_normalize_costar`.
  Add real building ids to `data/buildings.json` (or load a list from the API in `list_buildings`).
- **Vexcel**: set `VEXCEL_IMAGE_URL` (template with `{lat}` `{lng}`) or put `aerial_image_url` on a building. It becomes the ground texture for the fly-in.
- **Matterport**: set `MATTERPORT_SDK_KEY` and `matterport_model_id` on a building. The case file then shows
  "View the real Matterport scan", which embeds the real 3D tour and tags found clues at real sweep positions.
  Next step: feed Matterport room labels into `layout.py` so the playable floor plan matches the scan.

The sample buildings in `data/buildings.json` are made up placeholders, not CoStar records.

## How it works

```
frontend/ (Three.js)          backend/app/ (FastAPI)
  title → fly-in → explore  ⇄   main.py         REST API, serves the frontend
  talk / examine / accuse       agent.py        deepagents GM + tools (Claude Opus 5.5)
                                game.py         state, hidden solution, offline GM
                                layout.py       building → rooms per floor
                                data_sources.py CoStar / Vexcel / Matterport adapters
```

Game master tools: `record_transaction` and `pull_bank_records` (Capital One), `get_building_record`, `get_aerial_view`, `list_rooms`, `set_story`, `spawn_npc`,
`place_clue`, `move_npc`, `npc_say`, `narrate` (plus deepagents' built-in `write_todos` planning).
The culprit and secrets stay on the server; the browser only sees what the player has discovered.

## 2-minute pitch

1. **Problem (15 s):** buildings have decades of stories in their records that nobody ever hears, and virtual tours are boring.
2. **Demo (75 s):** pick a building → fly in from above → the GM's case file cites the real year built and history →
   question a suspect → find a clue → the suspect moves → accuse → ending.
3. **How (20 s):** three CoStar layers feed one agent that plans, places and reacts.
4. **Next (10 s):** gamified open houses, local-history lessons for classrooms, evacuation drills in the real floor plan.
