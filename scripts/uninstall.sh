#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Mission Control stoppen und entfernen.
#   ohne Option: Dienste, Autostart, Verknüpfungen und Programmdateien weg –
#                .env, peers.env (Geheimnisse), hermes-team.conf und das Daten-Volume bleiben für eine spätere
#                Neuinstallation. Die Hermes-Profile selbst bleiben immer unangetastet.
#   --purge:     zusätzlich Daten-Volume, .env, Image und den ganzen Ordner löschen.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
require_root

PURGE=0
case "${1:-}" in
  --purge) PURGE=1 ;;
  "") ;;
  -h|--help) sed -n '3,6p' "$0"; exit 0 ;;
  *) die 1 "Unbekannte Option: $1" ;;
esac

IMAGE=""
if [ -f "$MC_DIR/.env" ]; then
  IMAGE="$(env_get "$MC_DIR/.env" MISSION_CONTROL_IMAGE):$(env_get "$MC_DIR/.env" MISSION_CONTROL_VERSION)"
fi

log "Dienste stoppen"
if has_systemd && [ -f "/etc/systemd/system/$MC_UNIT" ]; then
  systemctl disable --now "$MC_UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$MC_UNIT"
  systemctl daemon-reload
fi
if command -v docker >/dev/null 2>&1; then
  if [ -f "$MC_DIR/compose.yaml" ] && [ -f "$MC_DIR/.env" ]; then
    if [ "$PURGE" -eq 1 ]; then compose down --volumes --remove-orphans || true
    else compose down --remove-orphans || true
    fi
  fi
  docker rm -f "$MC_NAME" >/dev/null 2>&1 || true
fi

if has_systemd && [ -f /etc/systemd/system/bonys-hermes-peer@.service ]; then
  log "Angebundene Hermes-Agenten stoppen"
  while read -r name _; do
    [ -n "$name" ] && systemctl disable --now "bonys-hermes-peer@$name" >/dev/null 2>&1 || true
  done < <(cat "$MC_DIR/hermes-team.conf" 2>/dev/null)
  rm -f /etc/systemd/system/bonys-hermes-peer@.service
  systemctl daemon-reload
fi
if has_systemd && [ -f /etc/systemd/system/bonys-hermes-sprache.service ]; then
  log "Sprachdienst stoppen"
  systemctl disable --now bonys-hermes-sprache.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/bonys-hermes-sprache.service
  systemctl daemon-reload
fi

log "Verknüpfungen entfernen"
remove_desktop_shortcuts

if [ "$PURGE" -eq 1 ]; then
  log "Daten, Einstellungen und Image löschen (--purge)"
  if command -v docker >/dev/null 2>&1; then
    docker volume rm "$MC_VOLUME" >/dev/null 2>&1 || true
    if [ -n "$IMAGE" ]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$MC_DIR"
  log "Mission Control vollständig entfernt."
else
  find "$MC_DIR" -mindepth 1 -maxdepth 1 ! -name .env ! -name .env.example ! -name peers.env ! -name hermes-team.conf ! -name sprachdienst.env \
    -exec rm -rf {} +
  log "Mission Control entfernt. Behalten: $MC_DIR/.env, peers.env und Docker-Volume $MC_VOLUME (löschen mit --purge)."
fi
