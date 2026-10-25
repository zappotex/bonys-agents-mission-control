#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Startet sprachdienst.py in der Laufzeitumgebung von Hermes (als Agent-Benutzer, aus der systemd-Unit
# bonys-hermes-sprache.service). Hermes verrät mit --print-runtime-command, wie es selbst Python startet;
# statt hermes_cli.main läuft dann der Sprachdienst.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
DIENST="$(dirname "$(readlink -f "$0")")/sprachdienst.py"
command -v hermes >/dev/null || { echo "Hermes fehlt" >&2; exit 2; }
exec python3 - "$DIENST" <<'PY'
import json, os, subprocess, sys
dienst = sys.argv[1]
cmd = json.loads(subprocess.run(["hermes", "--print-runtime-command"], capture_output=True, text=True,
                                check=True).stdout)
start = "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"
if len(cmd) < 4 or start not in cmd[3]:
    sys.exit("Startbefehl von Hermes unbekannt – Sprachdienst startet nicht.")
os.execv(cmd[0], cmd[:3] + [cmd[3].replace(start, f"runpy.run_path({dienst!r}, run_name='__main__')")])
PY
