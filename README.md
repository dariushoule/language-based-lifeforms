# Language Based Lifeforms

A persistent world simulation where small cuboid lifeforms ("LBLs") come into existence, survive, and look for meaning. The server runs the world authoritatively and streams state over websocket; any number of observers watch in real time in the browser (Phaser) and can hover any entity to read its background.

## Run

```sh
npm install
cp .env.example .env   # then fill it in
npm run dev            # sim on :8080, web on :5173, mind connected to the sim
```

The mind needs [uv](https://docs.astral.sh/uv/) and an OpenAI-compatible endpoint. Without a mind (or when it is slow or down), LBLs act on a simple instinct.

## How it fits together

```
 sim (Node, server/)   ── /ws: snapshots at 10Hz ──>  observers (Phaser, client/)
   │  /mind: perception out, plans in (bearer MIND_TOKEN)
 mind (Python, mind/)  ──>  LLM (DS4 on the Sparks, via vLLM)
```

- **The sim owns the world** (`server/sim.js`, 20Hz). LBLs carry out a queue of high-level actions: `walk_to`, `chop_tree`, `place_block`, `take_block`, `rest`. The sim walks them there, chops, stacks, and runs AABB physics against the block grid: they can step up one block but not climb walls. Every action from a plan is re-validated, and a failure drops the rest of the plan and goes into the LBL's memory.
- **The mind decides** (`mind/main.py`, Pydantic AI). When an LBL runs out of plan, the sim sends what it perceives (needs, carried wood, trees, structures, recent memory). The mind answers with a typed `Plan`: a thought, a feeling, and 1-5 actions. Bad output is sent back to the model to fix. The mind never waits on the world, and the world never waits on the mind: after 45s, or on an empty plan, instinct takes over.
- **Minds are clients**, so a mind can run anywhere it can reach the model (on the Sparks themselves, or a laptop) while the sim stays on a small box. The newest mind connection takes over.

Mind config lives in `.env`: `BRAIN_URL`, `BRAIN_KEY`, `BRAIN_MODEL`, optional `BRAIN_CF_ID`/`BRAIN_CF_SECRET` for the Cloudflare endpoint, `BRAIN_THINKING=1` to let the model reason first, `MIND_TOKEN`, `SIM_URL`, `MIND_CONCURRENCY`.

## Art pipeline

Sprites are generated small and cheap on fal (FLUX.2 klein 4B at 512x512, ~$0.0013/image, ~$0.0026 with a style reference) and then deterministically snapped onto the real pixel grid. Needs `FAL_API_KEY` in `.env`.

```sh
npm run art [assetId] [--force] [--n=4]  # generate via fal, auto-pick the cleanest candidate, pixelize
npm run pixelize [assetId]               # re-run only the snap step on art/raw/<id>.png
npm run sprites                          # redraw the procedural sprites
```

- `art/style.md` – style bible prepended to every prompt
- `art/assets.json` – asset id, canvas size, prompt
- `art/palette.json` – fixed 32-color palette every pixel is snapped to
- `art/preview/` – 8x previews for review

Generated art is sampled on the grid the model actually drew (art-pixel size from run lengths, phase from edge positions), never resampled. Sprites that must be exact are drawn procedurally by `tools/draw-sprites.js`: the LBL body and emotion faces (a fixed template keeps faces and clothing layers aligned), the 8x8 wood block, and the stump, which is cut from the generated tree's own trunk so the two always match.
