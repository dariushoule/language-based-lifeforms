# Agent notes

See README.md for what the aquarium is and how the pieces fit together.

## Deploying to hac.run

Production is one DigitalOcean droplet (`root@165.232.128.96`, which is what `hac.run` resolves to).
It is self-contained: nothing on a dev machine is part of it. Use Windows OpenSSH from PowerShell, not
Git Bash's `ssh`.

What runs where:

- **The sim** runs on the droplet as `lbl.service` (systemd, user `lbl`) from a git checkout in `/opt/lbl`,
  listening on `127.0.0.1:8080`. It serves the built client from `/opt/lbl/dist`.
- **The mind** runs on the droplet as `lbl-mind.service` (user `lbl`, Python from `/opt/lbl/mind/.venv`,
  set up with `uv sync`). It connects to the sim over `ws://127.0.0.1:8080/mind`, and reaches DS4 through
  the Cloudflare tunnel at `https://sparks-a.alturas.ai/v1` with the Access service-token headers
  (`BRAIN_CF_ID` / `BRAIN_CF_SECRET`).
- **Caddy** (`/etc/caddy/Caddyfile`) terminates TLS for `hac.run` (Let's Encrypt, renewed automatically)
  and proxies everything to the sim, including the `/ws` websocket. `/mind` answers 404 from the internet
  (`respond /mind* 404`); the mind reaches the sim over localhost instead.
- **Secrets** live in `/etc/lbl.env` (root-only, loaded by both units' `EnvironmentFile`), not in the
  checkout: `FAL_API_KEY`, `MIND_TOKEN`, `BRAIN_URL`, `BRAIN_KEY`, `BRAIN_MODEL`, `BRAIN_CF_ID`,
  `BRAIN_CF_SECRET`, `SIM_URL`. The droplet's `MIND_TOKEN` exists only there, so no mind on a dev
  machine can connect to hac.run. Don't point a dev mind at `wss://hac.run/mind`.
- **Data** lives in `/var/lib/lbl/data` (SQLite and the fish portrait pool in `fish/pool`). The sim unit can
  only write there.

Cloudflare drops a request that sends nothing back for 100 seconds, so every call the mind makes streams
(see `run_streaming` in `mind/main.py`). Keep it that way when adding calls.

### Steps

1. Commit on `master` and push: `git push origin master`. The droplet pulls from GitHub.
2. Pull, build or sync what changed, and restart. This works from PowerShell (the `sed` strips the BOM
   PowerShell puts in front of piped text, and `tr` the CRs):

   ```powershell
   $script = @'

   set -e
   cd /opt/lbl
   sudo -u lbl git pull -q --ff-only
   sudo -u lbl git log --oneline -1
   # Only when package-lock.json changed:
   # sudo -u lbl npm ci
   # Only when client/ or shared/ changed:
   sudo -u lbl npm run build
   # Only when mind/pyproject.toml or mind/uv.lock changed:
   # sudo -u lbl env HOME=/var/lib/lbl UV_PYTHON_INSTALL_DIR=/var/lib/lbl/python UV_CACHE_DIR=/var/lib/lbl/.cache/uv uv sync -q --project mind --frozen
   systemctl restart lbl.service lbl-mind.service
   sleep 5
   journalctl -u lbl --no-pager -n 5 -o cat
   journalctl -u lbl-mind --no-pager -n 3 -o cat
   '@
   $script | ssh -o BatchMode=yes root@165.232.128.96 "tr -d '\r' | sed '1s/^\xEF\xBB\xBF//' | bash -s"
   ```

   The sim's journal should show `resumed the aquarium at t=...`, `lbl aquarium on :8080` and
   `mind connected from 127.0.0.1`; the mind's, `connected to ws://127.0.0.1:8080/mind`. The tank picks
   up where it left off (it's saved every 15 seconds and on shutdown). While the mind is down, fish act on
   instinct.
3. Check https://hac.run in a browser: fish moving, the Codex filled in, speech bubbles once the mind
   answers.

Server-only changes (`server/`) need just the pull and `systemctl restart lbl.service`; mind-only changes
(`mind/main.py`), just `systemctl restart lbl-mind.service`. Watching the logs:
`ssh root@165.232.128.96 "journalctl -u lbl -u lbl-mind -f -o cat"`.

Starting over (a fresh tank): stop both units, delete `/var/lib/lbl/data/aquarium.db*` (keep `fish/pool`,
a cache of paid-for portraits), and start them again.

## Developing locally

`npm run dev` runs a separate tank on this machine (sim on :8080, web on :5173, mind against the local
sim), with its own `data/` and the `.env` in the repo root. It shares nothing with hac.run except the DS4
endpoint.
