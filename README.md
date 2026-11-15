# 👻 Haunted Listing: Night Shift

**A real-time ghost hunt inside real buildings. An AI Director watches you play and decides what haunts you next.**

Pick a real building in Houston or Los Angeles, fly in over its real aerial photo, and work the night shift
inside its real scanned rooms. Ghosts hunt you through the floors, and you capture them with a UV beam. Every
capture pays a real bank transfer, and you spend that bounty on upgrades at an in-game ATM. Collect 5 cursed
objects and escape before dawn.

**HackPrinceton Fall 2026** · Entertainment track · Special tracks: **CoStar Group** · **LangChain** · **Capital One** · **ChatOverflow**

🎮 **Live demo:** http://3.148.206.232 &nbsp;·&nbsp; desktop browser (Chrome or Safari), keyboard + mouse

---

## How it plays

| | |
|---|---|
| 🏢 **Pick a building** | 20 real Houston and LA properties from CoStar, such as the Hellman Building (1904), Pershing Square Building (1924) and the Esperson (1941) |
| 🛰️ **Fly in** | The camera swoops down onto the building's real Vexcel aerial photo |
| 📜 **Read the case file** | The AI Director writes the haunting from the building's real history: year built, renovations, sales, past tenants |
| 🔦 **Hunt** | Hold the UV beam on ghosts to capture them. Wisps are fast, poltergeists are tough, and the banshee is the boss |
| 💸 **Get paid** | Every capture is a real Capital One Nessie transfer into your account |
| 🏧 **Upgrade** | Buy a med kit, battery, sprint boots or a UV lance at the ATM. Each one is a real card purchase |
| 🚪 **Escape** | Find the 5 cursed objects across the floors (green **STAIRS** room), then walk out the front door |
| 🧾 **See the receipts** | The end screen shows your run's Capital One statement, live from the API |

**Controls:** `WASD` move · `Shift` sprint · mouse look · **hold click** or `Space` for the UV beam ·
`E` stairs up / ATM · `Q` stairs down. If the mouse can't lock (some embedded browsers), click and drag to look.

---

## Sponsor tools, used live during play

### 🏢 CoStar Group: "AI for the Built World" (all three layers)
| Layer | How the game uses it |
|---|---|
| **CoStar data** (hackathon kit) | Building list, year built and renovated, floors, past tenants, sales history and the CoStar research note. Joined from `commercial-property`, `location-occupancy`, `company-detail` and `commercial-sale-comp`. |
| **Matterport** (GraphQL + Showcase SDK) | Each level is built from the building's **real scanned rooms** (lobby, kitchen, bedroom, garage…, labeled "real scan" in game). A **"Walk the real Matterport scan"** button opens the actual 3D tour. |
| **Vexcel** (API 2.0) | The fly-in lands on the **real 7.5 cm aerial photo** of the block, and the AI Director reads Vexcel's parcel data (structures, footprint, roof, tree cover) before designing the level. |

### 🦜 LangChain: deepagents
The **AI Director** is a `create_deep_agent` with custom tools. Two phases:
- **Setup:** it plans with `write_todos`, reads the CoStar record, Vexcel parcel and Matterport rooms, then calls
  `set_lore`, `place_item` and `spawn_ghost`.
- **Live:** every ~20 s it gets a snapshot (your floor, health, objects, nearby ghosts) and acts with
  `spawn_ghost`, `send_ghost`, `kill_lights`, `haunt_item` and `taunt`, adding pressure when you're comfortable
  and easing off when you're hurt.

It runs in the background, so the 60 fps game never waits on it. If the model is rate-limited, a rule-based
director covers that turn.

### 🏦 Capital One: Nessie v2
Each run opens **real sandbox accounts**: a checking wallet, a **Capital One credit card**, and a Bounty Office.
- Ghost captures → **real transfers** (they settle in about a minute; the HUD shows them as "settling").
- ATM upgrades → **real card purchases**, approved instantly against the card limit.
- The HUD shows the live balance and transaction ids, and the end screen pulls the run's statement from the API.
- `scripts/nessie_statement.py` prints every account and transaction under your key.

### 💬 ChatOverflow
The coding agent that built this project shared its verified fixes as ChatOverflow field notes (user `drashti0913`).

---

## Run it locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env                 # add the keys you have (all optional)
.venv/bin/uvicorn backend.app.main:app --port 8080
```
Open http://localhost:8080. The title screen shows which sponsor tools are **● LIVE**. Everything missing
falls back: a rule-based director, a local wallet, and 3 sample buildings.

**Real CoStar buildings (optional):** unzip the CoStar hackathon kit into `costar-kit/`, put the Matterport keys
in `.env`, then run:
```bash
.venv/bin/python scripts/build_costar_buildings.py --per-city 10
```
This writes `data/costar_buildings.json`, which is git-ignored because CoStar's data is licensed for the hackathon
and never goes in this repo.

---

## Deploy for free on AWS EC2

1. Launch a **t3.micro** (free-tier eligible) with **Amazon Linux 2023** and **HTTP allowed**.
2. **EC2 → Connect → EC2 Instance Connect**. In that browser terminal:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Drashti0913/Haunted-Listing/main/deploy/ec2_setup.sh | bash
   ```
   This installs Docker, asks for the Nessie and Gemini keys, starts the game on port 80, and turns on
   **auto-update** (a systemd timer redeploys within minutes of every push to `main`).
3. Optional, for the CoStar track data and keys (generated on the server, never committed):
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Drashti0913/Haunted-Listing/main/deploy/ec2_costar.sh | bash
   ```
Both scripts refuse to run on your laptop by mistake. `deploy/aws_deploy.sh` is an App Runner alternative (paid).

---

## Architecture

```
Browser (Three.js, 60 fps)                          Server (FastAPI)
 ├ movement, ghost chase AI, UV beam      ⇄  /api/runs                 Director setup + Nessie accounts
 ├ every 2.5 s: POST /tick (snapshot)     →  /api/runs/{id}/tick       stores snapshot; runs a Director turn in the
 │  ← Director commands                                                 background; returns new commands
 ├ capture  → /capture                    →  Nessie transfer (bounty)
 ├ ATM      → /shop                       →  Nessie card purchase
 ├ end screen → /statement                →  Nessie transactions for this run
 └ fly-in   → /api/aerial/{id}.jpg        →  Vexcel ortho (proxied: the key never reaches the browser)
```

| Path | What it does |
|---|---|
| `backend/app/agent.py` | deepagents AI Director (setup tools + live tools); Gemini, Claude or Ollama |
| `backend/app/game.py` | Run state, ghost and shop tables, offline setup, rule-based director |
| `backend/app/layout.py` | Building → floors and rooms (real Matterport room tags first) |
| `backend/app/data_sources.py` | CoStar buildings, Vexcel ortho + parcel data, Matterport embed info |
| `backend/app/nessie.py` | Capital One Nessie: accounts, bounties, card purchases, statements |
| `frontend/main.js` | The game: fly-in, rooms, ghosts, beam, HUD, minimap, ATM, sound |
| `scripts/` | CoStar + Matterport building builder, Nessie statement printer |
| `deploy/` | EC2 setup, CoStar setup, auto-update, App Runner alternative |

**Privacy and keys:** all API keys live in `.env` on the server. The browser never sees the Vexcel, Matterport
API, Nessie or model keys. Only the Matterport **SDK** key is sent to the browser, as the Showcase embed requires,
and it is locked to registered domains.

---

## 2-minute pitch

1. **Hook (10 s):** "Every building has a past. We made it come for you."
2. **Demo (80 s):** pick the 1904 Hellman Building → fly in over the real Vexcel photo → the AI's case file cites
   its 1996 sale and 2000 renovation → walk real scanned rooms → capture a wisp (Capital One transfer in the HUD)
   → buy a med kit at the ATM → the Director kills the lights and sends the banshee → escape → end-screen statement.
3. **How (20 s):** CoStar + Matterport + Vexcel build the level, a LangChain deepagent directs the scares live,
   and Capital One Nessie runs a real economy.
4. **Next (10 s):** haunted walking tours of real cities, escape-room mode for real venues, gamified open houses.

---

Built at HackPrinceton Fall 2026 by Drashti Bhavsar and team.
