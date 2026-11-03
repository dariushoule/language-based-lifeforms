# Language Based Lifeforms

A persistent aquarium of alien, bioluminescent fish ("LBLs") who live a few minutes each and spend them talking, arguing and putting what they learn into words. Every fish's personality, voice and memories grow out of a random Wikipedia article. Across generations their teachings accumulate into the **Compendium**, a book of fish philosophy that keeps evolving as newcomers rework, embrace and dispute what came before. The server runs the tank authoritatively and streams it over websocket; any number of observers watch in the browser (Phaser), read the conversation as it happens, and open the Compendium.

## Run

```sh
npm install
cp .env.example .env   # then fill it in
npm run dev            # sim on :8080, web on :5173, mind connected to the sim
```

The mind needs [uv](https://docs.astral.sh/uv/) and an OpenAI-compatible endpoint; fish art needs `FAL_API_KEY`. Without a mind (or when it is slow or down) fish act on a simple instinct, and newcomers arrive with a plain stand-in personality.

## How it fits together

```
 sim (Node, server/)   ── /ws: deltas at 10Hz, compendium, departed ──>  observers (Phaser, client/)
   │  /mind: perception and births out, decisions and personas in (bearer MIND_TOKEN)
   │  Wikipedia (1 request per 2s at most) · fal (fish art) · SQLite (data/aquarium.db)
 mind (Python, mind/)  ──>  LLM (DS4 on the Sparks, via vLLM)
```

- **The sim owns the tank** (`server/sim.js`, 20Hz). Fish carry out short plans (`swim_to`, `eat`, `approach`, `follow`, `attack`, `flee`, `rest`, `wander`) and speak. When one fish speaks to another, the two swim up and face each other. Everything a plan asks for is re-validated; a failure drops the rest of the plan and goes into the fish's memory.
- **Short lives**: each fish lives 3 to 10 minutes (random). About 40 seconds before the end it feels the edge calling and gets a chance at parting words; then it swims out the side of the tank. Its successor is prepared ahead of time and swims in from beyond the edge, carrying some of the teachings it embraced. Fish can also starve or be killed: they bite, and sometimes eat each other. The tank holds 5.
- **Newcomers** (`server/births.js`): a random Wikipedia article (`server/wiki.js`, never more than one request every 2 seconds) becomes a fish through the mind: name, personality, a voice taken from how the article is written (match reports, field guides, liturgy...), a philosophy, a desire, and 2-4 memories of its life beyond the edge built from the article's events and transposed into a fish's world. Those memories are the fresh material each fish brings into the tank's conversations. Its portrait comes from a pool of 600 alien fish (`server/art.js`): while the pool is filling, each newcomer gets a new one drawn on fal from random traits (FLUX.2 klein, about a second and $0.0013, cut out of its background), and after that a random one. The pool lives in `data/fish/pool/`, on the machine only, so filling it costs about $0.80 once (about 27 MB).
- **The Compendium**: when a fish reaches an insight it sets down a teaching in one of twelve chapters (the light, the edge, passing on, kinship, ...), optionally as a reworking of a teaching it carries, which builds a lineage of ideas. Speaking teaches whoever hears. Fish embrace or dispute what they carry, hold at most 8 teachings, and pass the ones they embraced to their successor. The book keeps teachings long after anyone carries them (up to 2000, the least regarded forgotten ones go first). In the browser it opens as a book over the tank: a title page, contents, and chapters in the order things were set down, with reworkings noted in the margin.
- **The mandala**: on the tank's back wall the fish build a sand mandala together (`make_mandala`): a fish swims to one of twelve colored deposits on the floor, carries a grain up, and lays it at a ring and slot of its choosing; every grain is mirrored into all four quadrants. Which colors go where is left entirely to the fish's taste. It is their main source of meaning. When all 133 places are filled the mandala stands for ten minutes, then its sand falls to the floor and a new one begins; finished ones are archived.
- **Urchins**: three glowing sea urchins rest on the sand. A fish can carry one to the surface and let it go (`drop_urchin`); it drifts down for about half a minute, and every fish that watches it settle gains meaning. The one who let it go gains the most and is prompted to reflect on what it saw.
- **Needs**: hunger, energy, social and meaning, plus health. Fish eat the glowing pods that plants regrow, or the remains of the dead.
- **The Codex** (sidebar): every fish in the tank and every one that has swum out, the mandala, and every living plant. Clicking any of them, in the Codex or in the tank, opens its entry.
- **Plants** are procedural (`shared/plants.js`): a genome of form (kelp, coral, sea fan, anemone, lantern, fern, tube, grass, orb string, vine), hues, glow, pulse, shape and food traits. They sprout, grow, fruit, wither and die, and they evolve: dying plants scatter mutated seedlings, fish carry seeds off in their bellies and pollen from one plant to the next (making hybrids that blend both parents), and now and then a single trait leaps somewhere new. Seeds of a form that crowds the tank, or that land among their own kind, often fail to take root, so no form takes over; spores of entirely new plants drift in every so often, and a new plant grows where a fish's remains fall. The client draws each plant from its genome alone (`client/plants.js`).
- **The mind decides** (`mind/main.py`, Pydantic AI): a typed `Decision` per turn (thought, feeling, optional speech, a new teaching, a teaching to pass on, a stance, an impression of another fish, a note to remember, 1-4 actions) and a `Persona` per newcomer. By default it answers directly (10-20 seconds a turn) so conversation flows; `BRAIN_THINKING=1` makes it reason first, streamed live into the fish's profile.
- **Conversation**: the mind keeps nothing between turns, so the sim carries the thread for it. Each fish hears the last 30 lines spoken in earshot and is reminded of the latest 14, of anything said to it that it hasn't answered, of its last few thoughts, and of up to 6 notes it chose to keep (`remember`).
- **Observers** get deltas (`server/delta.js`): 10 times a second, only the fields that changed; the compendium as the teachings that changed; the 12 fish that last swam out. A new observer gets what the others hold, a tab hidden for 30 seconds lets go of the stream, and an observer too slow to keep up is dropped and resyncs.
- **Persistence**: the tank is saved to SQLite every 15 seconds and on shutdown, along with the lineage of every fish, the Compendium and the chronicle, so a restart picks up where it left off. Fish art lives in `data/fish/`.

Config lives in `.env`: `BRAIN_URL`, `BRAIN_KEY`, `BRAIN_MODEL`, optional `BRAIN_CF_ID`/`BRAIN_CF_SECRET` for the Cloudflare endpoint, `BRAIN_THINKING`, `BRAIN_THINK_BUDGET`, `MIND_TOKEN`, `SIM_URL`, `MIND_CONCURRENCY`, `FAL_API_KEY`, and `DATA_DIR` (default `data`).
