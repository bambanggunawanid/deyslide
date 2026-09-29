#!/usr/bin/env bash
# Starts the production stack for https://deyslide.bambanggunawan.id with Podman.
# The deploy workflow runs it on the server from the release folder (~/deyslide).
#
#   db      Postgres, with its data in the deyslide-pgdata volume
#   server  the Deyslide API on port 3001 (apps/server, bundled into server/server.mjs)
#   app     nginx on port 3000: the web app at /, the demo deck at /demo/, the API at /api/
#   tunnel  cloudflared, which publishes app:3000 through the Cloudflare tunnel
#
# All four run in one pod. The pod has its own network namespace and
# publishes no port, so they reach each other on 127.0.0.1 and nothing on
# the host is exposed.
#
# Files next to this script:
#   .env          TUNNEL_TOKEN, written by the deploy workflow
#   server.env    optional API settings (email, OAuth), written by the deploy workflow
#   secrets.env   POSTGRES_PASSWORD and BETTER_AUTH_SECRET, created here once and kept
set -euo pipefail

cd "$(dirname "$0")"
root=$PWD

pod=deyslide
db=deyslide-db
server=deyslide-server
app=deyslide-app
tunnel=deyslide-tunnel
db_volume=deyslide-pgdata
# Fully qualified names: rootless Podman cannot prompt to pick a registry.
db_image=${DB_IMAGE:-docker.io/library/postgres:18-alpine}
server_image=${SERVER_IMAGE:-docker.io/library/node:24-alpine}
app_image=${APP_IMAGE:-docker.io/library/nginx:stable-alpine}
tunnel_image=${TUNNEL_IMAGE:-docker.io/cloudflare/cloudflared:latest}

for file in .env server.env; do
  if [ ! -f "$root/$file" ]; then
    echo "Missing $root/$file" >&2
    exit 1
  fi
done

# Generated on the first deploy and never replaced: the database keeps its
# password in the volume, and a new auth secret would sign everyone out.
if [ ! -f "$root/secrets.env" ]; then
  echo "Creating $root/secrets.env"
  random() { head -c 36 /dev/urandom | base64 | tr -dc 'A-Za-z0-9'; }
  (
    umask 077
    printf 'POSTGRES_PASSWORD=%s\nBETTER_AUTH_SECRET=%s\n' "$(random)" "$(random)" >"$root/secrets.env"
  )
fi
# shellcheck disable=SC1091
source "$root/secrets.env"

# Waits until a command succeeds, or prints diagnostics and stops.
wait_for() {
  local label=$1 container=$2
  shift 2
  echo "Waiting for $label"
  for attempt in $(seq 1 30); do
    if "$@" >/dev/null 2>&1; then
      echo "Ready: $label"
      return 0
    fi
    sleep 2
  done
  podman ps --all --pod --filter "pod=$pod"
  podman logs --tail 50 "$container"
  exit 1
}

for image in "$db_image" "$server_image" "$app_image" "$tunnel_image"; do
  podman pull --quiet "$image" >/dev/null
done

# "app" points at the pod's loopback, so the Cloudflare route http://app:3000
# reaches nginx inside the pod.
if ! podman pod exists "$pod"; then
  podman pod create --name "$pod" --add-host app:127.0.0.1 >/dev/null
fi

# The database keeps running across deploys. It is only created when missing.
if [ "$(podman container inspect --format '{{.State.Running}}' "$db" 2>/dev/null || true)" != "true" ]; then
  podman rm --force --ignore "$db" >/dev/null
  podman run --detach --name "$db" --pod "$pod" --restart always \
    --env POSTGRES_USER=deyslide \
    --env POSTGRES_DB=deyslide \
    --env POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    --volume "$db_volume:/var/lib/postgresql" \
    "$db_image" >/dev/null
fi
wait_for "the database" "$db" podman exec "$db" pg_isready --host 127.0.0.1 --username deyslide --dbname deyslide

podman rm --force --ignore "$server" >/dev/null
podman run --detach --name "$server" --pod "$pod" --restart always \
  --env-file "$root/server.env" \
  --env NODE_ENV=production \
  --env HOST=127.0.0.1 \
  --env PORT=3001 \
  --env PGHOST=127.0.0.1 \
  --env PGUSER=deyslide \
  --env PGDATABASE=deyslide \
  --env PGPASSWORD="$POSTGRES_PASSWORD" \
  --env BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  --volume "$root/server:/app:ro,z" \
  "$server_image" node /app/server.mjs >/dev/null
wait_for "the API" "$server" podman exec "$server" wget -qO- http://127.0.0.1:3001/api/health

podman rm --force --ignore "$app" >/dev/null
podman run --detach --name "$app" --pod "$pod" --restart always \
  --volume "$root/site:/usr/share/nginx/html:ro,z" \
  --volume "$root/nginx.conf:/etc/nginx/conf.d/default.conf:ro,z" \
  "$app_image" >/dev/null

# Output goes to a variable first: `grep -q` stops reading early, which
# would fail the pipeline under pipefail.
page() {
  podman exec "$app" wget -qO- "http://127.0.0.1:3000$1" 2>/dev/null || true
}
app_ready() {
  grep -q '<div id="app">' <<<"$(page /)" \
    && grep -q '/demo/assets/' <<<"$(page /demo/)" \
    && grep -q '"ok":true' <<<"$(page /api/health)"
}
wait_for "nginx serving the web app, the demo deck and the API" "$app" app_ready

podman rm --force --ignore "$tunnel" >/dev/null
podman run --detach --name "$tunnel" --pod "$pod" --restart always \
  --env-file "$root/.env" \
  "$tunnel_image" tunnel --no-autoupdate run >/dev/null

tunnel_ready() {
  grep -q 'Registered tunnel connection' <<<"$(podman logs "$tunnel" 2>&1 || true)"
}
wait_for "the tunnel connection" "$tunnel" tunnel_ready

podman ps --pod --filter "pod=$pod"
