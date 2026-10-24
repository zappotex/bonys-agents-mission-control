#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Ersatz für Hermes im Installationstest: Profile anlegen, Einstellung setzen und als "Gateway" nur /health beantworten.
set -euo pipefail
if [ "${1:-}" = profile ] && [ "${2:-}" = create ]; then
  mkdir -p "$HOME/.hermes/profiles/$3"
  exit 0
fi
[ "${1:-}" = -p ] || exit 1
profile="$HOME/.hermes/profiles/$2"
shift 2
case "$1 ${2:-}" in
  "config set") printf '%s: %s\n' "$3" "$4" >> "$profile/config.yaml" ;;
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
