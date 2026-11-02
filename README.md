# Language Based Lifeforms

A persistent world simulation where small cuboid lifeforms ("LBLs") come into existence, survive, and look for meaning. The server runs the world authoritatively and streams state over websocket; any number of observers watch in real time in the browser (Phaser) and can hover any entity to read its background.

## Run

```sh
npm install
npm run dev        # sim on :8080, web on :5173
```

## Art pipeline

Sprites are generated small and cheap on fal (FLUX.2 klein 4B at 512x512, ~$0.0013/image, ~$0.0026 with a style reference) and then deterministically snapped onto the real pixel grid. Needs `FAL_API_KEY` in `.env`.

```sh
npm run art [assetId] [--force] [--n=4]  # generate via fal, auto-pick the cleanest candidate, pixelize
npm run pixelize [assetId]  # re-run only the snap step on art/raw/<id>.png
```

- `art/style.md` – style bible prepended to every prompt
- `art/assets.json` – asset id, canvas size, prompt
- `art/palette.json` – fixed 32-color palette every pixel is snapped to
- `art/preview/` – 8x previews for review

The LBL body and its emotion faces are drawn procedurally (`npm run lbl`, `tools/lbl-body.js`) rather than generated: a fixed, exact template keeps faces and clothing layers aligned. Generated art is sampled on the grid the model actually drew (art-pixel size from run lengths, phase from edge positions), never resampled.
