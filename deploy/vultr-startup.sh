#!/bin/bash
# Vultr startup script: paste this into "Startup Script" when you create the
# Cloud Compute instance (or add it under Orchestration > Scripts and pick it).
# It installs Docker, deploys Studio OS from GitHub, and then redeploys by
# itself within 3 minutes of every push to main. No SSH keys or secrets needed.
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl
curl -fsSL https://raw.githubusercontent.com/unaboss/studio-os/main/deploy/remote.sh -o /root/studio-os-deploy.sh
bash /root/studio-os-deploy.sh > /var/log/studio-os-deploy.log 2>&1 || true
cat > /etc/cron.d/studio-os <<'CRON'
*/3 * * * * root cd /opt/studio-os && git fetch -q origin main && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] && bash deploy/remote.sh >> /var/log/studio-os-deploy.log 2>&1
CRON
chmod 644 /etc/cron.d/studio-os
