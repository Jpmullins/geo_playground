#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

TELEMETRY_URL="${TELEMETRY_URL:-http://localhost:18080}"
EXEC_URL="${EXEC_URL:-http://localhost:18081}"
SEARCH_URL="${SEARCH_URL:-http://localhost:18082}"
AGENT_URL="${AGENT_URL:-http://localhost:18090}"
COPILOT_RUNTIME_URL="${COPILOT_RUNTIME_URL:-http://localhost:18091}"
UI_URL="${UI_URL:-http://localhost:3010}"

docker compose up -d --build postgres redis telemetry-gateway exec-broker search-proxy agent-runtime copilot-runtime ui >/dev/null

for i in {1..40}; do
  if curl -fsS "$TELEMETRY_URL/health" >/dev/null; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 40 ]]; then
    echo "FAIL: telemetry-gateway did not become healthy"
    exit 1
  fi
done

health=$(curl -fsS "$TELEMETRY_URL/health")
tracks=$(curl -fsS "$TELEMETRY_URL/tracks/live")
trails=$(curl -fsS "$TELEMETRY_URL/tracks/trails?minutes=30&max_entities=100")
copilot=$(curl -fsS -X POST "$TELEMETRY_URL/copilot/query" -H 'content-type: application/json' -d '{"query":"Summarize current picture"}')
ui_status=$(curl -s -o /dev/null -w "%{http_code}" "$UI_URL/")
exec_health=$(curl -fsS "$EXEC_URL/health")
search_health=$(curl -fsS "$SEARCH_URL/health")
agent_health=$(curl -fsS "$AGENT_URL/health")
copilot_runtime_health=$(curl -fsS "$COPILOT_RUNTIME_URL/health")
exec_result=$(curl -fsS -X POST "$EXEC_URL/tool/exec" -H 'content-type: application/json' -d '{"session_id":"smoke","command":"echo ok"}')
search_result=$(curl -fsS -X POST "$SEARCH_URL/search/query" -H 'content-type: application/json' -d '{"query":"automatic identification system maritime"}')

if [[ "$ui_status" != "200" ]]; then
  echo "FAIL: ui returned HTTP $ui_status"
  exit 1
fi

echo "$health" | grep -q '"service":"telemetry-gateway"' || { echo "FAIL: health payload invalid"; exit 1; }
echo "$tracks" | grep -q '"type":"FeatureCollection"' || { echo "FAIL: tracks payload invalid"; exit 1; }
echo "$trails" | grep -q '"type":"FeatureCollection"' || { echo "FAIL: trails payload invalid"; exit 1; }
echo "$copilot" | grep -q '"answer":"' || { echo "FAIL: copilot payload invalid"; exit 1; }
echo "$exec_health" | grep -q '"service":"exec-broker"' || { echo "FAIL: exec-broker health invalid"; exit 1; }
echo "$search_health" | grep -q '"service":"search-proxy"' || { echo "FAIL: search-proxy health invalid"; exit 1; }
echo "$agent_health" | grep -q '"service":"agent-runtime"' || { echo "FAIL: agent-runtime health invalid"; exit 1; }
echo "$copilot_runtime_health" | grep -q '"service":"copilot-runtime"' || { echo "FAIL: copilot-runtime health invalid"; exit 1; }
echo "$exec_result" | grep -q '"stdout":"ok\\n"' || { echo "FAIL: exec-broker exec contract invalid"; exit 1; }
echo "$search_result" | grep -q '"provider":"duckduckgo"' || { echo "FAIL: search-proxy contract invalid"; exit 1; }

echo "PASS: smoke e2e passed (db/cache/ingest/trails/agent/copilot/api/ui/brokers reachable)"
