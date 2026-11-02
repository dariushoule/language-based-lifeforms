# Language Based Lifeforms

A persistent world simulation where small cuboid lifeforms ("LBLs") come into existence, survive, and look for meaning. The server runs the world authoritatively and streams state over websocket; any number of observers watch in real time in the browser (Phaser) and can hover any entity to read its background.

## Run

```sh
npm install
npm run dev        # sim on :8080, web on :5173
```

## Art pipeline

Sprites are generated with Codex's built-in image tool and then deterministically snapped onto the real pixel grid.

```sh
npm run art [assetId]       # generate raw image via codex, then pixelize
npm run pixelize [assetId]  # re-run only the snap step on art/raw/<id>.png
```

- `art/style.md` – style bible prepended to every prompt
- `art/assets.json` – asset id, canvas size, prompt
- `art/palette.json` – fixed 32-color palette every pixel is snapped to
- `art/preview/` – 8x previews for review
