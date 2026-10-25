#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Ersatz für Hermes im Installationstest: Profile anlegen, Einstellung setzen und als "Gateway" nur /health beantworten.
set -euo pipefail
# Laufzeit wie bei Hermes: python3 mit der Startzeile, die sprachdienst-start.sh ersetzt
if [ "${1:-}" = --print-runtime-command ]; then
  printf '%s\n' '["/usr/bin/python3", "-I", "-c", "import os, sys, runpy; runpy.run_module('"'"'hermes_cli.main'"'"', run_name='"'"'__main__'"'"', alter_sys=True)"]'
  exit 0
fi
# Standardprofil: keine Spracheinstellungen gesetzt
if [ "${1:-}" = config ] && [ "${2:-}" = get ]; then exit 0; fi
if [ "${1:-}" = profile ] && [ "${2:-}" = create ]; then
  mkdir -p "$HOME/.hermes/profiles/$3"
  exit 0
fi
[ "${1:-}" = -p ] || exit 1
profile="$HOME/.hermes/profiles/$2"
shift 2
case "$1 ${2:-}" in
  "config set") printf '%s: %s\n' "$3" "$4" >> "$profile/config.yaml" ;;
  "config get") ;;
  "gateway run")
    set -a
    # shellcheck disable=SC1091
    . "$profile/.env"
    set +a
    exec python3 -c '
import http.server, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path == "/health"
        self.send_response(200 if ok else 404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if ok:
            self.wfile.write(b"{\"status\": \"ok\", \"platform\": \"hermes-agent\"}")
    def log_message(self, *args):
        pass
http.server.HTTPServer((os.environ["API_SERVER_HOST"], int(os.environ["API_SERVER_PORT"])), H).serve_forever()
' ;;
  *) exit 1 ;;
esac
