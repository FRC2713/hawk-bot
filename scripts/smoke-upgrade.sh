#!/usr/bin/env bash
# Upgrade a disposable prior-release database; never mount production data.
set -euo pipefail
name="hawk-upgrade-${RANDOM}-${RANDOM}"
volume="${name}-data"
# shellcheck disable=SC2329
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; }
trap cleanup EXIT
key=$(printf '%s' '{"type":"service_account","client_email":"fixture@example.invalid","private_key":"fixture"}' | base64 | tr -d '\n')
args=(-e SLACK_SIGNING_SECRET=fixture -e SLACK_CLIENT_ID=fixture -e SLACK_CLIENT_SECRET=fixture
      -e SLACK_STATE_SECRET=fixture-state-secret -e PUBLIC_URL=https://fixture.example.org
      -e TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
      -e "GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=$key" -e ONSHAPE_CLIENT_ID=fixture
      -e ONSHAPE_CLIENT_SECRET=fixture -e APP_URL=https://fixture.example.org
      -e ONSHAPE_REDIRECT_URI=https://fixture.example.org/auth/onshape/callback)

wait_ready() {
  for _attempt in $(seq 1 60); do
    state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$name")
    if [[ $state == 'running healthy' ]]; then return 0; fi
    if [[ $state == exited* || $state == dead* ]]; then break; fi
    sleep 2
  done
  docker logs --tail=40 "$name"
  return 1
}
docker pull --platform linux/amd64 "$BASELINE_IMAGE" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --name "$name" --network none -v "$volume:/data" --platform linux/amd64 "${args[@]}" "$BASELINE_IMAGE" >/dev/null
wait_ready
module=better-sqlite3
docker exec "$name" node -e 'const D=require(process.argv[1]);const d=new D("/data/hawk-bot.db");d.exec("CREATE TABLE deployment_smoke (value TEXT); INSERT INTO deployment_smoke VALUES (char(114,101,116,97,105,110,101,100))");d.close()' "$module"
docker rm -f "$name" >/dev/null
docker run -d --name "$name" --network none -v "$volume:/data" "${args[@]}" "$IMAGE" >/dev/null
wait_ready
docker exec "$name" node -e 'const D=require(process.argv[1]);const d=new D("/data/hawk-bot.db",{readonly:true});if(d.prepare("SELECT value FROM deployment_smoke").get().value!=="retained")process.exit(1);if(d.pragma("integrity_check",{simple:true})!=="ok")process.exit(1);d.close()' "$module"
