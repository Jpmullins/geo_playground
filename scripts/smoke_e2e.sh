#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose up -d --build postgres redis telemetry-gateway exec-broker search-proxy ui >/dev/null

for i in {1..40}; do
  if curl -fsS "http://localhost:8080/health" >/dev/null; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 40 ]]; then
    echo "FAIL: telemetry-gateway did not become healthy"
    exit 1
  fi
done

health=$(curl -fsS "http://localhost:8080/health")
tracks=$(curl -fsS "http://localhost:8080/tracks/live")
trails=$(curl -fsS "http://localhost:8080/tracks/trails?minutes=30&max_entities=100")
copilot=$(curl -fsS -X POST "http://localhost:8080/copilot/query" -H 'content-type: application/json' -d '{"query":"Summarize current picture"}')
ui_status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000/")
exec_health=$(curl -fsS "http://localhost:8081/health")
search_health=$(curl -fsS "http://localhost:8082/health")
exec_result=$(curl -fsS -X POST "http://localhost:8081/tool/exec" -H 'content-type: application/json' -d '{"session_id":"smoke","command":"echo ok"}')
search_result=$(curl -fsS -X POST "http://localhost:8082/search/query" -H 'content-type: application/json' -d '{"query":"automatic identification system maritime"}')

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
echo "$exec_result" | grep -q '"stdout":"ok\\n"' || { echo "FAIL: exec-broker exec contract invalid"; exit 1; }
echo "$search_result" | grep -q '"provider":"duckduckgo"' || { echo "FAIL: search-proxy contract invalid"; exit 1; }

echo "PASS: smoke e2e passed (db/cache/ingest/trails/copilot/api/ui/brokers reachable)"
