#!/usr/bin/env bash
# Daily key touch: push a fresh personal Riot API key to forge's env file.
# The collectors notice the change within 30s and resume on their own.
#
#   ./push-key.sh RGAPI-xxxxxxxx-....
set -euo pipefail

KEY="${1:?usage: push-key.sh RGAPI-...}"
HOST="${2:-forge}"

if [[ ! "$KEY" =~ ^RGAPI-[A-Za-z0-9-]+$ ]]; then
  echo "push-key: that does not look like a Riot API key (RGAPI-...)" >&2
  exit 1
fi

ssh "$HOST" "sudo sed -i 's/^RIOT_API_KEY=.*/RIOT_API_KEY=$KEY/' /etc/firstpick-collector/env"
echo "push-key: key updated on $HOST; collectors resume within 30s"
