#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

export PATH="/home/swirhen/.local/bin:${PATH}"

echo "==> Build frontend"
VITE_BASE_PATH=/switchbot_home/ npm run build

echo "==> Restart API"
sudo systemctl restart switchbot-home-api.service
sudo systemctl is-active --quiet switchbot-home-api.service

printf '\nRelease completed.\n'
