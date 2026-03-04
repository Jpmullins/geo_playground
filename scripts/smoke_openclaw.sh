#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Auto-load .env if present so callers don't need to export vars manually.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

required=(OPENCLAW_GATEWAY_TOKEN LITELLM_BASE_URL LITELLM_API_KEY LITELLM_MODEL)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "FAIL: missing required env var $name"
    exit 1
  fi
done

docker compose up -d --build openclaw-gateway >/dev/null

for i in {1..80}; do
  code=$(curl -s -o /tmp/openclaw_healthz.json -w "%{http_code}" http://localhost:18789/healthz || true)
  if [[ "$code" == "200" ]]; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 80 ]]; then
    echo "FAIL: openclaw gateway did not become healthy"
    docker compose logs --no-color openclaw-gateway | tail -n 200
    exit 1
  fi
done

agent_output=$(docker compose exec -T openclaw-gateway sh -lc '
  openclaw agent --agent main --message "Respond with EXACTLY: OPENCLAW_OK" --timeout 180 --json
')

echo "$agent_output" | grep -q "OPENCLAW_OK" || {
  echo "FAIL: agent output missing expected marker"
  echo "$agent_output"
  exit 1
}

echo "PASS: OpenClaw gateway + LiteLLM model turn succeeded"
