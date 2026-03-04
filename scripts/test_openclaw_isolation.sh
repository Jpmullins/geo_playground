#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

service="openclaw-runtime"

docker compose up -d --build "$service" >/dev/null
container_id=$(docker compose ps -q "$service")

if [[ -z "$container_id" ]]; then
  echo "FAIL: openclaw-runtime container not found"
  exit 1
fi

readonly_root=$(docker inspect "$container_id" --format '{{.HostConfig.ReadonlyRootfs}}')
user=$(docker inspect "$container_id" --format '{{.Config.User}}')
nonewpriv=$(docker inspect "$container_id" --format '{{index .HostConfig.SecurityOpt 0}}')
caps=$(docker inspect "$container_id" --format '{{json .HostConfig.CapDrop}}')

fail=0

if [[ "$readonly_root" != "true" ]]; then
  echo "FAIL: ReadonlyRootfs expected true, got $readonly_root"
  fail=1
fi

if [[ "$user" != "10001:10001" ]]; then
  echo "FAIL: User expected 10001:10001, got $user"
  fail=1
fi

if [[ "$nonewpriv" != "no-new-privileges:true" ]]; then
  echo "FAIL: no-new-privileges missing, got $nonewpriv"
  fail=1
fi

if [[ "$caps" != *"ALL"* ]]; then
  echo "FAIL: cap_drop ALL missing, got $caps"
  fail=1
fi

if [[ "$fail" -eq 0 ]]; then
  echo "PASS: openclaw-runtime isolation baseline checks passed"
else
  exit 1
fi
