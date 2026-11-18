#!/usr/bin/env bash
# Pause or wake the live simulation on the droplet, without a commit: run as root,
#   bash /opt/lbl/server/live.sh pause|wake|status
# It sets PAUSED in /etc/lbl.env (which overrides `paused` in sims/live.js), restarts the sim, and
# stops the mind while paused or starts it on waking.
set -euo pipefail
ENV=/etc/lbl.env

set_paused() {
  if grep -q '^PAUSED=' "$ENV"; then sed -i "s/^PAUSED=.*/PAUSED=$1/" "$ENV"; else echo "PAUSED=$1" >> "$ENV"; fi
}

case "${1:-status}" in
  pause)
    set_paused 1
    systemctl disable --now lbl-mind
    systemctl restart lbl.service
    ;;
  wake)
    set_paused 0
    systemctl restart lbl.service
    sleep 2
    systemctl enable --now lbl-mind
    ;;
  status) ;;
  *) echo "usage: $0 pause|wake|status" >&2; exit 2 ;;
esac

[ "${1:-status}" = status ] || sleep 5
echo "PAUSED in $ENV: $(grep '^PAUSED=' "$ENV" | cut -d= -f2 || echo 'unset (sims/live.js decides)')"
echo "sim: $(systemctl is-active lbl.service || true), mind: $(systemctl is-active lbl-mind || true) ($(systemctl is-enabled lbl-mind || true))"
journalctl -u lbl --no-pager -n 3 -o cat
