#!/usr/bin/env bash
# Starts the production stack for https://deyslide.bambanggunawan.id with Podman.
# The deploy workflow runs it on the server from the release folder (~/deyslide).
#
#   app     nginx serving the deck on port 3000
#   tunnel  cloudflared, which publishes app:3000 through the Cloudflare tunnel
#
# Both run in one pod. The pod has its own network namespace and publishes no
# port, so port 3000 on the host is untouched.
set -euo pipefail

cd "$(dirname "$0")"
root=$PWD

pod=deyslide
app=deyslide-app
tunnel=deyslide-tunnel
# Fully qualified names: rootless Podman cannot prompt to pick a registry.
app_image=${APP_IMAGE:-docker.io/library/nginx:stable-alpine}
tunnel_image=${TUNNEL_IMAGE:-docker.io/cloudflare/cloudflared:latest}

if [ ! -f "$root/.env" ]; then
  echo "Missing $root/.env with TUNNEL_TOKEN" >&2
  exit 1
fi

for image in "$app_image" "$tunnel_image"; do
  podman pull --quiet "$image" >/dev/null
done

# "app" points at the pod's loopback, so the Cloudflare route http://app:3000
# reaches nginx inside the pod.
if ! podman pod exists "$pod"; then
  podman pod create --name "$pod" --add-host app:127.0.0.1 >/dev/null
fi

podman rm --force --ignore "$app" >/dev/null
podman run --detach --name "$app" --pod "$pod" --restart always \
  --volume "$root/site:/usr/share/nginx/html:ro,z" \
  --volume "$root/nginx.conf:/etc/nginx/conf.d/default.conf:ro,z" \
  "$app_image" >/dev/null

echo "Waiting for app to answer on port 3000"
for attempt in $(seq 1 30); do
  page=$(podman exec "$app" wget -qO- http://127.0.0.1:3000/ 2>/dev/null || true)
  if grep -q '<div id="app">' <<<"$page"; then
    echo "app is serving the deck"
    break
  fi
  if [ "$attempt" = 30 ]; then
    podman ps --all --pod --filter "pod=$pod"
    podman logs --tail 50 "$app"
    exit 1
  fi
  sleep 2
done

podman rm --force --ignore "$tunnel" >/dev/null
podman run --detach --name "$tunnel" --pod "$pod" --restart always \
  --env-file "$root/.env" \
  "$tunnel_image" tunnel --no-autoupdate run >/dev/null

echo "Waiting for the tunnel to connect"
for attempt in $(seq 1 30); do
  logs=$(podman logs "$tunnel" 2>&1 || true)
  if grep -q 'Registered tunnel connection' <<<"$logs"; then
    echo "tunnel is connected"
    break
  fi
  if [ "$attempt" = 30 ]; then
    podman ps --all --pod --filter "pod=$pod"
    tail -n 50 <<<"$logs"
    exit 1
  fi
  sleep 2
done

podman ps --pod --filter "pod=$pod"
