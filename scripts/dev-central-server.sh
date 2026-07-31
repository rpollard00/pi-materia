#!/usr/bin/env bash
# Start the pi-materia central control plane for local testing.
#
# Development auth mode enables the built-in credentials:
#   dev-token-reader (reads) · dev-token-admin (writes) · dev-token-sink (telemetry ingest)
#
# Any variable can be overridden by exporting it first, e.g.:
#   MATERIA_CENTRAL_PORT=4700 ./scripts/dev-central-server.sh
# State persists to MATERIA_CENTRAL_DATABASE_PATH (default ./data/pi-materia-central.sqlite).
export MATERIA_CENTRAL_AUTH_MODE="${MATERIA_CENTRAL_AUTH_MODE:-development}"
export MATERIA_CENTRAL_PORT="${MATERIA_CENTRAL_PORT:-4600}"

cd "$(dirname "$0")/.."
exec npm run start:central
