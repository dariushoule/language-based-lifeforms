# Agent notes

See README.md for what the aquarium is and how the pieces fit together.

## Deploying to hac.run

Production is one DigitalOcean droplet (`root@165.232.128.96`, which is what `hac.run` resolves to).
Use Windows OpenSSH from PowerShell, not Git Bash's `ssh`.

What runs where:

- **The sim** runs on the droplet as `lbl.service` (systemd, user `lbl`) from a git checkout in `/opt/lbl`,
  listening on `127.0.0.1:8080`. It serves the built client from `/opt/lbl/dist`.
- **Caddy** (`/etc/caddy/Caddyfile`) terminates TLS for `hac.run` (Let's Encrypt, renewed automatically)
  and proxies everything to the sim, including the `/ws` and `/mind` websockets.
- **Secrets** live in `/etc/lbl.env` (loaded by the unit's `EnvironmentFile`), not in the checkout.
- **Data** lives in `/var/lib/lbl/data` (SQLite and the fish art pool). The unit can only write there.
- **The mind does not run on the droplet.** It runs on the dev machine, next to the LLM, and connects out to
  `wss://hac.run/mind` with the same `MIND_TOKEN` as `/etc/lbl.env`.

### Steps

1. Commit on `master` and push: `git push origin master`. The droplet pulls from GitHub.
2. Pull, build if needed, and restart. This works from PowerShell (the `sed` strips the BOM PowerShell
   puts in front of piped text, and `tr` the CRs):

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
   systemctl restart lbl.service
   sleep 3
   journalctl -u lbl --no-pager -n 5 -o cat
   '@
   $script | ssh -o BatchMode=yes root@165.232.128.96 "tr -d '\r' | sed '1s/^\xEF\xBB\xBF//' | bash -s"
   ```

   The journal should show `resumed the aquarium at t=...` and `lbl aquarium on :8080`. The tank picks
   up where it left off (it's saved every 15 seconds and on shutdown).
3. If `mind/` changed, restart the mind on the dev machine so it picks up the new code:

   ```sh
   SIM_URL=wss://hac.run/mind PYTHONIOENCODING=utf-8 uv run --project mind python mind/main.py
   ```

   The newest mind connection wins, so starting a new one takes over from the old one, which exits. The
   droplet's journal logs `mind connected from ...`. While no mind is connected, fish act on instinct.
4. Check https://hac.run in a browser: fish moving, the Codex filled in, speech bubbles once the mind
   answers.

Server-only changes (`server/`) need just the pull and restart. Watching the logs:
`ssh root@165.232.128.96 "journalctl -u lbl -f -o cat"`.
