#!/usr/bin/env bash
# Run a command (default: pi) connected to a local development central server.
#
# Usage from the project you want to work in:
#   cd /path/to/your-project
#   /path/to/pi-materia/scripts/dev-central-connect.sh                      # launches pi
#   /path/to/pi-materia/scripts/dev-central-connect.sh pi -e /path/to/pi-materia/src/index.ts
#
# MATERIA_CENTRAL_API_URL here only provides a default; a `central.apiUrl`
# set in the project's .pi/pi-materia.json is overridden by it, so export a
# different URL first if your server is not on the default port.
export MATERIA_CENTRAL_API_URL="${MATERIA_CENTRAL_API_URL:-http://127.0.0.1:4600}"
export MATERIA_CENTRAL_READ_TOKEN="${MATERIA_CENTRAL_READ_TOKEN:-dev-token-reader}"
export MATERIA_CENTRAL_TELEMETRY_TOKEN="${MATERIA_CENTRAL_TELEMETRY_TOKEN:-dev-token-sink}"

exec "${@:-pi}"
