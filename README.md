# Language Based Lifeforms

Small persistent worlds of creatures ("LBLs") who live a few minutes each and spend them talking, arguing and putting what they learn into words. Every creature's personality, voice and memories grow out of a random Wikipedia article (or, now and then, a poem), and what they work out is handed down the generations in a book that keeps evolving as newcomers rework, embrace and dispute what came before. The server runs the world authoritatively and streams it over websocket; any number of observers watch in the browser (Phaser), read the conversation as it happens, and open the book.

There are two so far:

- **The night garden** (`sims/garden/`): fireflies in a walled garden, each alive for one night or less, trying to work out what the moon is. It changes shape from night to night and none of them lives to see it go round, so they compare what they saw, tend a spiral of flowers that open and shut with the moonlight, and write the **Book of the Moon**, a book of myths.
- **The aquarium** (`sims/aquarium/`): alien, bioluminescent fish who build a sand mandala and write the **Compendium**, a book of fish philosophy.

## Run

```sh
npm install
cp .env.example .env   # then fill it in
npm run dev            # sim on :8080, web on :5173, mind connected to the sim
```

`npm run dev` runs whichever simulation `sims/live.js` names (`SIM=aquarium` in `.env` picks the other). While that one is paused (see below) it's shown frozen; put `PAUSED=0` in `.env` to run it.

The mind needs [uv](https://docs.astral.sh/uv/) and an OpenAI-compatible endpoint; the aquarium's fish art needs `FAL_API_KEY` (the garden draws everything itself). Without a mind (or when it is slow or down) the creatures act on a simple instinct, and newcomers arrive with a plain stand-in personality.

## Simulations

hac.run runs one simulation at a time, and they can be swapped in and out. Each lives in `sims/<name>/`
with its own server, client and (optionally) mind. The host
(`server/index.js`) runs whichever one `sims/live.js` names: it serves its built client and files,
streams it to observers on `/ws`, and hands its mind over on `/mind`. `sims/live.js` also says what a
simulation has to provide.

A simulation can be **paused**: it's loaded as it was left and shown frozen, under its note ("the fish are
sleeping… check back soon"), and it doesn't step, save or take a mind. `paused` in `sims/live.js` sets it
for production; `SIM` and `PAUSED` in `.env` override it locally (`PAUSED=0` to run a paused one). Pausing
or waking only needs a restart; switching simulations also needs `npm run build`.

## How the night garden fits together

Code paths below are in `sims/garden/`; `data/` is at the repo root.

```
 sim (Node, server/)   ── /ws: deltas at 10Hz, the book, the risen ──>  observers (Phaser, client/)
   │  /mind: perception and births out, decisions and personas in (bearer MIND_TOKEN)
   │  Wikipedia and PoetryDB (1 request per 2s at most) · SQLite (data/garden.db)
 mind (Python, mind/)  ──>  LLM (DS4 on the Sparks, via vLLM)
```

- **The sky is a function of time** (`shared/garden.js`), so the sim and every observer compute the same one. A night lasts ten minutes and ends in the pale: the day, squeezed into under a minute, when the sky washes out and every flower shuts. The moon goes from new to new in eight nights and keeps the real moon's habits: a young moon is a thin curve already sinking at dusk, a full one crosses the whole night, an old one rises just before the pale, and around the new moon there is none. Clouds, wind, gusts, rain and a ring around the moon come and go, and now and then a full moon is eclipsed (a new garden's first always is).
- **Fireflies live one night or less** (4 to 9 minutes). They kindle in the grass, and when the height calls them they rise out of the garden; a successor, prepared ahead of time, kindles carrying some of the myths its predecessor embraced. The garden holds 5. None of them can see the moon's cycle, only one shape in one part of the sky, or no moon at all; what each has seen with its own eyes is kept (`witnessed`) and shown to it each turn. They have no clocks and keep no records: times reach the mind only roughly ("a little while ago"), and a line a firefly has already said is not said again.
- **Newcomers** (`server/births.js`): a random Wikipedia article, or about one time in three a random poem (`server/texts.js`), becomes a firefly through the mind: name, personality, a voice taken from how the text is written, a rhythm for its light, a **hunch** about what the moon is that grows out of the text's subject, and 2-4 memories of its long time as a grub under the soil.
- **The Book of the Moon**: when a firefly arrives at an explanation it sets down a myth in one of twelve chapters (what the moon is, why it changes, where it goes, the moon in the water, the pale, ...), optionally as a reworking of a myth it carries. Each is signed with the moon it was set down under, and whether its teller ever saw the moon. Speaking tells whoever hears. Fireflies embrace or dispute what they carry, hold at most 8 myths, and pass on the ones they embraced. The book keeps up to 2000.
- **Plants live fast** (`shared/flora.js`): a genome of form (bells, stars, trumpets, spires, umbels, ferns, grasses, clockflowers, bushes, glowing caps, vines on the wall, lilies on the pond), colors, shape and a **window of moonlight** in which its flowers stand open: some want a bright moon, some only the dark, some the dimness between. They sprout, flower, go to seed and die within a night or two. Seeds ride the wind and take root where they land; fireflies carry pollen from flower to flower, making hybrids; a plant that never meets its moon dies without seed, so the garden's flowers shift with the month. Rain speeds growth and brings up caps; new seeds blow in over the wall. Flowers turn to follow the moon. The client draws each plant from its genome alone (`client/flora.js`), growing it out joint by joint.
- **The spiral** is the shared work: a bed of nineteen plots. A firefly takes a seed from a wild plant that is in seed and sows it in a plot (`sow`), pulls up what doesn't belong (`uproot`), or glows on a shut flower until it opens for a while (`wake`). When every plot stands open at the same moment the spiral flowers for two and a half minutes and pours its light upward, then goes to seed, and a few plots sprout again from its own seed. Since flowers open under different moons, what they sow decides under which moon it can ever flower. The sim works out which light the bed as sown could flower in (`bedLight`): fireflies are told which plants in seed suit it, and which plots hold flowers that would keep it from ever flowering.
- **Watching and touching**: `watch_sky` takes a firefly up into open air, and it comes back knowing exactly what the moon did meanwhile; `touch_pond` breaks the moon in the water into rings.
- **Needs**: nectar (sipped from open flowers), rest, company and wonder. Nothing here dies of them, and nothing bites.
- **The mind decides** (`mind/main.py`, Pydantic AI): a typed `Decision` per turn (thought, feeling, optional speech, a new myth, a myth to pass on, a stance, an impression, a note to remember, 1-4 actions) and a `Persona` per newcomer.
- Conversation, observers' deltas and persistence work as in the aquarium (below); the garden is saved to `data/garden.db`.

## How the aquarium fits together

Code paths below are in `sims/aquarium/`; `data/` is at the repo root.

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

Config lives in `.env` at the repo root: `SIM`, `PAUSED`, `BRAIN_URL`, `BRAIN_KEY`, `BRAIN_MODEL`, optional `BRAIN_CF_ID`/`BRAIN_CF_SECRET` for the Cloudflare endpoint, `BRAIN_THINKING`, `BRAIN_THINK_BUDGET`, `MIND_TOKEN`, `SIM_URL`, `MIND_CONCURRENCY`, `FAL_API_KEY`, and `DATA_DIR` (default `data`).
