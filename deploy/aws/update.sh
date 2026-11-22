#!/usr/bin/env bash
# Deploy the newest code:  sudo bash /opt/lifelink/deploy/aws/update.sh
set -euo pipefail
cd /opt/lifelink && sudo -u lifelink git pull --ff-only
sudo -u lifelink bash -c 'cd server && npm ci --omit=dev'
systemctl restart lifelink && sleep 2 && curl -fsS http://127.0.0.1:8787/api/health && echo
