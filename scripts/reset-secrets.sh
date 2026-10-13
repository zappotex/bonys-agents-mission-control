#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Für Vorlagen ("frische" Agent-PCs): Geheimnisse und Benutzerdaten von Mission Control entfernen.
# Danach erzeugt der nächste Start (systemd-Unit → ensure-secrets.sh) neue Zufallswerte und ein
# leeres Daten-Volume. Programm, Image, Autostart und Einstellungen wie Port bleiben.
#
# Aufruf: reset-secrets.sh [--keep-data] [--restart]
#   --keep-data  Daten-Volume behalten, nur Geheimnisse zurücksetzen
#   --restart    sofort wieder starten (sonst erst beim nächsten Systemstart)
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
require_root

KEEP_DATA=0 RESTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-data) KEEP_DATA=1 ;;
    --restart) RESTART=1 ;;
    -h|--help) sed -n '3,10p' "$0"; exit 0 ;;
    *) die 1 "Unbekannte Option: $1" ;;
  esac
  shift
done
[ -f "$MC_DIR/.env" ] || die 1 "Keine Installation unter $MC_DIR gefunden."

log "Dienste stoppen und Container entfernen"
if has_systemd; then systemctl stop "$MC_UNIT" >/dev/null 2>&1 || true; fi
compose down --remove-orphans >/dev/null 2>&1 || true
docker rm -f "$MC_NAME" >/dev/null 2>&1 || true

count=0
for key in $(secret_keys); do
  env_set "$MC_DIR/.env" "$key" "$MC_SECRET_PLACEHOLDER"
  count=$((count + 1))
done
log "$count Geheimnis(se) zurückgesetzt – werden beim nächsten Start neu erzeugt."

if [ "$KEEP_DATA" -eq 0 ]; then
  docker volume rm "$MC_VOLUME" >/dev/null 2>&1 || true
  log "Benutzerdaten (Docker-Volume $MC_VOLUME) gelöscht."
fi

if [ "$RESTART" -eq 1 ]; then
  if has_systemd; then systemctl start "$MC_UNIT"; else ensure_env; compose up -d; fi
  log "Neu gestartet."
else
  log "Mission Control bleibt gestoppt bis zum nächsten Systemstart (oder: systemctl start $MC_UNIT)."
fi
