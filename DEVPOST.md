# Devpost submission: copy each section into the matching Devpost field

## Project name
Haunted Listing: Night Shift

## Elevator pitch (Devpost limit: 200 characters)
A real-time ghost hunt inside real buildings: CoStar data, Matterport scans and Vexcel aerials build the level, a LangChain AI directs the scares live, and Capital One pays your bounties.

---

## About the project (paste into "Project story"; Devpost supports Markdown)

## Inspiration
Every building has a past. The Hellman Building in downtown LA went up in 1904, sold for $1.7M in 1996 and was renovated in 2000, and nobody walking past it today knows any of that. CoStar holds that history for millions of buildings, Matterport has scanned their insides and Vexcel has photographed them from above. We asked: what if that data didn't sit in a dashboard, but came for you? Property tours are boring. Horror games are not.

## What it does
**Haunted Listing: Night Shift** is a real-time, first-person ghost hunt set inside **real** Houston and Los Angeles buildings.

1. **Pick a real building:** 20 properties from the CoStar data kit, such as the Hellman Building (1904), the Pershing Square Building (1924) and the Esperson (1941).
2. **Fly in** over the building's **real Vexcel aerial photo**.
3. **Read the case file:** our AI Director writes the haunting from the building's real CoStar record (year built, renovations, sales, past tenants), so the story is about *this* building.
4. **Hunt:** the floors are built from the building's **real Matterport-scanned rooms**. Ghosts chase you; hold your UV beam on them to capture them.
5. **Get paid for real:** every capture is a **real Capital One Nessie bank transfer**. Spend your bounty at the in-game ATM on upgrades, which are **real card purchases**.
6. **Escape:** find 5 cursed objects across the floors and walk out before dawn. The end screen shows your run's **live Capital One statement**.

The whole time, an **AI Director** (a LangChain deepagent) watches how you play and decides what happens next. It spawns ghosts next to you when you're comfortable, sends hunters to your room, kills the lights, moves the object you're heading for, and eases off when you're hurt.

## How we built it
- **Frontend:** Three.js with no build step: a procedural 3D interior from the building's room layout, ghost chase AI, the UV beam, HUD, minimap, ATM and WebAudio sound effects.
- **Backend:** Python and FastAPI, with all sponsor API calls made server-side so no key reaches the browser.
- **LangChain deepagents AI Director:** `create_deep_agent` with custom tools. In **setup** it plans with `write_todos`, reads the CoStar record, the Vexcel parcel data and the Matterport rooms, then calls `set_lore`, `place_item` and `spawn_ghost`. In **live play** it gets a game snapshot every ~20 seconds and acts with `spawn_ghost`, `send_ghost`, `kill_lights`, `haunt_item` and `taunt`. Turns run in the background so the 60 fps game never waits, and a rule-based director covers any turn the model can't. The model is Gemini 2.5 Flash on the free tier, through Gemini's OpenAI-compatible endpoint.
- **CoStar Group (all three layers):**
  - **CoStar data kit:** we joined `commercial-property`, `location-occupancy`, `company-detail` and `commercial-sale-comp` into one record per building (year built from construction events, tenants by move-in date, sales history), then picked old, story-rich buildings that have scans.
  - **Matterport GraphQL API:** each building's scanned rooms (lobby, kitchen, bathroom, garage, gym…) become the game's rooms, labeled "real scan" in game. The **Showcase SDK** lets you walk the actual 3D tour.
  - **Vexcel API 2.0:** `ortho/extract` gives the fly-in's real 7.5 cm aerial photo, and `property/extract` gives parcel facts (structures, footprint, roof, tree cover) that the AI Director reads.
- **Capital One Nessie v2:** each run opens a real checking wallet, a Capital One credit card and a Bounty Office account. Captures are transfers, ATM upgrades are card purchases, and the end screen calls `GET /accounts/{id}/transactions` for the run's statement.
- **Deployment:** Docker on a free-tier AWS EC2 instance, with setup scripts and a systemd timer that auto-deploys every push to GitHub. CoStar's licensed data is generated on the server and never committed.

## Challenges we ran into
- **Nessie settles in about 60 seconds,** too slow to spend a bounty mid-game. We gave every player a real **Capital One credit card**: card purchases are approved instantly against the credit limit while the bounty transfers settle in the background.
- **AI latency vs. 60 fps:** an AI turn takes about 11 seconds. We made the Director fully asynchronous: the game streams snapshots, the agent queues commands, and the game applies them on arrival.
- **Free-tier model limits:** our Gemini key type hung LangChain's native Gemini client, so we switched to the OpenAI-compatible endpoint. We also hit per-minute and daily quotas, so we spaced out Director turns and added a rule-based fallback so a game never stalls. A free local 7B model through Ollama couldn't drive the agent's tools at all.
- **Real data is messy:** Matterport room labels were often empty, but room *tags* (lobby, kitchen, bathroom) were reliable. Some real tenant names weren't game-safe, so we filtered them.
- **Licensing:** CoStar and Vexcel data are licensed for the hackathon, so the repo holds only code. The data is built on the server from the kit.

## Accomplishments that we're proud of
- **Every sponsor tool runs live during play, not as decoration.** The CoStar data writes the story, the Matterport rooms are the level, the Vexcel photo is the world you fly into, the deepagent directs the scares, and Capital One moves the money.
- The AI Director writes lines like *"The historic Hellman Building, erected in 1904… a 1996 sale for a mere $1.7 million, followed by a renovation in 2000, may have stirred restless spirits"* from the real record.
- It's deployed publicly on AWS at $0 cost, with auto-deploy from GitHub.
- The coding agent that built it shared 20+ verified field notes on ChatOverflow.

## What we learned
- Agentic AI in a real-time game is about **pacing**: background turns, small fresh context each turn, and always a fallback.
- Bank APIs have **settlement**. Designing around pending vs. completed money (a credit card for instant spending) made the economy feel real.
- Real-estate data becomes compelling when you can **stand inside it**.

## What's next for Haunted Listing
- **Haunted walking tours:** play the real buildings on your street with a phone.
- **Escape-room mode** for real venues and museums from their Matterport scans.
- **Gamified open houses:** a fun way for buyers to explore a listing's real rooms and history.
- **Multiplayer night shifts,** plus a leaderboard settled in Nessie.

---

## Built with (paste into the "Built with" tags)
python, fastapi, three.js, javascript, langchain, deepagents, langgraph, gemini, costar, matterport, vexcel, capital-one-nessie, aws-ec2, docker, webaudio, chatoverflow

## Try it out (links)
- Live demo: http://3.148.206.232
- GitHub: https://github.com/Drashti0913/Haunted-Listing
- Demo video: (paste your YouTube link here)

## Tracks to select
- **Main track (choose exactly one):** Entertainment
- **Special tracks:**
  - CoStar Group: AI for the Built World
  - LangChain: Best use of deepagents
  - Capital One: Best Usage of Nessie
  - ChatOverflow Agent Leaderboard (ChatOverflow username: drashti0913)

## Other required fields
- Team members' Discord usernames (required to contact winners)
- Add all teammates to the Devpost project
