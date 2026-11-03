#!/usr/bin/env bash
# Runs on the Vultr VM (as root) for every deploy. Safe to run again:
# installs Docker once, keeps generated secrets, updates the code and
# restarts only what changed.
set -euo pipefail

REPO="${REPO:-https://github.com/unaboss/studio-os.git}"
DIR=/opt/studio-os
CI_ENV=/root/studio-os.env.ci

if ! command -v docker >/dev/null 2>&1; then
    echo "Installing Docker"
    curl -fsSL https://get.docker.com | sh
fi

if command -v ufw >/dev/null 2>&1; then
    ufw allow 22/tcp >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw --force enable >/dev/null
fi

if [ ! -d "$DIR/.git" ]; then
    git clone "$REPO" "$DIR"
fi
cd "$DIR"
git fetch --quiet origin main
git reset --quiet --hard origin/main

touch .env
chmod 600 .env
setkey() {
    local key="$1" value="$2"
    grep -v "^${key}=" .env > .env.tmp || true
    printf '%s=%s\n' "$key" "$value" >> .env.tmp
    mv .env.tmp .env
    chmod 600 .env
}

# Generated once, then kept.
grep -q '^SESSION_SECRET=' .env || setkey SESSION_SECRET "$(openssl rand -hex 32)"
grep -q '^POSTGRES_PASSWORD=' .env || setkey POSTGRES_PASSWORD "$(openssl rand -hex 24)"
grep -q '^DEMO=' .env || setkey DEMO 1
grep -q '^SEED_DEMO=' .env || setkey SEED_DEMO 1

# Values GitHub Actions sent (only the ones that are set).
if [ -f "$CI_ENV" ]; then
    while IFS='=' read -r key value; do
        [ -n "$key" ] && [ -n "$value" ] && setkey "$key" "$value"
    done < "$CI_ENV"
    rm -f "$CI_ENV"
fi

# Secure cookies need HTTPS, which needs the domain.
if grep -q '^STUDIO_DOMAIN=.\+' .env; then setkey COOKIE_SECURE 1; else setkey COOKIE_SECURE 0; fi

export $(grep -E '^(POSTGRES_PASSWORD|STUDIO_DOMAIN)=' .env | xargs)
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null

for i in $(seq 1 30); do
    if docker compose exec -T app node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        echo "Studio OS is up"
        exit 0
    fi
    sleep 3
done
echo "Studio OS did not report healthy; recent logs:"
docker compose logs --tail 60 app
exit 1
