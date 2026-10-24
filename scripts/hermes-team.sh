#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Hermes-Agenten (Profile) auf diesem Agent-PC an Mission Control anbinden.
#
#   hermes-team.sh add NAME [--port N] [--description TEXT] [--user BENUTZER]
#   hermes-team.sh remove NAME
#   hermes-team.sh list
#
# add: legt das Hermes-Profil NAME an (falls nötig), schaltet dessen API-Server mit eigenem Schlüssel ein
# (nur an der Docker-Brücke, damit der Mission-Control-Container ihn erreicht), startet den Agenten als
# systemd-Dienst bonys-hermes-peer@NAME und trägt ihn als Peer ein (peers.yaml im Daten-Volume, Schlüssel in
# peers.env). Schlüssel werden nie angezeigt. NAME entspricht "peer:" im Teamprofil (z. B. atlas, nova, scribe).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

PEERS_ENV="$MC_DIR/peers.env"
TEAM_CONF="$MC_DIR/hermes-team.conf"
PEER_UNIT="bonys-hermes-peer@.service"
FIRST_PORT=8641
MARKER="# verwaltet von hermes-team.sh – Änderungen hier werden überschrieben"

usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; }

valid_name() { [[ "$1" =~ ^[a-z0-9]{1,32}$ ]] || die 1 "Ungültiger Name: $1 (nur Kleinbuchstaben und Ziffern)"; }

key_var() { printf 'HERMES_PEER_%s_KEY' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"; }

agent_user() {
  local user="${OPT_USER:-}"
  [ -n "$user" ] || [ ! -f "$MC_DIR/install.conf" ] || user="$(env_get "$MC_DIR/install.conf" AGENT_USER)"
  [ -n "$user" ] || user=agent
  id "$user" >/dev/null 2>&1 || die 1 "Benutzer nicht gefunden: $user (mit --user angeben)"
  printf '%s\n' "$user"
}

# Adresse der Docker-Brücke: dort erreicht der Container den Agent-PC, das Netz draußen nicht
bridge_ip() {
  local ip
  ip="$(ip -4 -o addr show docker0 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
  printf '%s\n' "${ip:-172.17.0.1}"
}

conf_port() { [ ! -f "$TEAM_CONF" ] || awk -v n="$1" '$1 == n { print $2 }' "$TEAM_CONF"; }

free_port() {
  local port="$FIRST_PORT"
  while awk -v p="$port" '$2 == p { found = 1 } END { exit !found }' "$TEAM_CONF" 2>/dev/null \
      || ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; do
    port=$((port + 1))
  done
  printf '%s\n' "$port"
}

# Wert in der .env eines Hermes-Profils setzen – Datei bleibt beim Agent-Benutzer
profile_env_set() {  # $1 = Benutzer, $2 = Datei, $3 = Schlüssel, $4 = Wert
  [ -f "$2" ] || install -m 600 -o "$1" -g "$(id -gn "$1")" /dev/null "$2"
  env_set "$2" "$3" "$4"
  chown "$1:$(id -gn "$1")" "$2"
}

as_user() {  # $1 = Benutzer, Rest = Befehl
  local user="$1" home; shift
  home="$(user_home "$user")"
  runuser -u "$user" -- env HOME="$home" PATH="$home/.local/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

write_peer_unit() {  # $1 = Benutzer
  local user="$1" home
  home="$(user_home "$user")"
  cat > "/etc/systemd/system/$PEER_UNIT" <<UNIT
[Unit]
Description=Hermes-Agent %i für Mission Control
Documentation=https://github.com/$MC_REPO
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$home
Environment=HOME=$home PATH=$home/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$home/.local/bin/hermes -p %i gateway run
# Mehrere Profile starten gleichzeitig – wer zu früh kommt, versucht es kurz darauf erneut
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
}

# peers.yaml im Daten-Volume aus hermes-team.conf neu schreiben
write_peers_yaml() {
  local dir file name port host
  dir="$(docker volume inspect -f '{{.Mountpoint}}' "$MC_VOLUME" 2>/dev/null)" \
    || die 1 "Daten-Volume $MC_VOLUME fehlt – ist Mission Control installiert?"
  file="$dir/peers.yaml"
  if [ -f "$file" ] && ! grep -qxF "$MARKER" "$file"; then
    die 1 "$file wurde von Hand angelegt – bitte sichern und entfernen, dann erneut aufrufen."
  fi
  host="$(bridge_ip)"
  {
    printf '%s\n' "$MARKER"
    if [ -s "$TEAM_CONF" ]; then
      printf 'peers:\n'
      while read -r name port; do
        [ -n "$name" ] || continue
        printf '  %s:\n    endpoint: http://%s:%s\n    api_key_env: %s\n' "$name" "$host" "$port" "$(key_var "$name")"
      done < "$TEAM_CONF"
    else
      printf 'peers: {}\n'
    fi
  } > "$file.tmp"
  chown "$(stat -c %u:%g "$dir")" "$file.tmp"
  chmod 600 "$file.tmp"
  mv "$file.tmp" "$file"
}

restart_mission_control() {
  local port
  port="$(env_get "$MC_DIR/.env" MISSION_CONTROL_PORT)"
  if has_systemd && [ -f "/etc/systemd/system/$MC_UNIT" ]; then
    systemctl restart "$MC_UNIT"
  else
    compose up -d --remove-orphans >/dev/null
  fi
  wait_healthy "${port:-8787}" "" 120 || die 4 "Mission Control antwortet nach dem Neustart nicht."
}

peer_health() {  # $1 = Port → ok / –
  curl -fsS --max-time 3 "http://$(bridge_ip):$1/health" >/dev/null 2>&1 && echo erreichbar || echo "nicht erreichbar"
}

cmd_add() {
  local name="$1" user home profile env port key
  valid_name "$name"
  [ "$name" != default ] || die 1 'Bitte ein eigenes Profil verwenden, nicht „default“.'
  user="$(agent_user)"
  home="$(user_home "$user")"
  [ -x "$home/.local/bin/hermes" ] || die 2 "Hermes ist für $user nicht installiert ($home/.local/bin/hermes fehlt)."
  command -v docker >/dev/null 2>&1 && [ -f "$MC_DIR/.env" ] || die 2 "Mission Control ist nicht installiert."

  profile="$home/.hermes/profiles/$name"
  if [ ! -d "$profile" ]; then
    log "Hermes-Profil $name anlegen"
    if [ -n "${OPT_DESCRIPTION:-}" ]; then
      as_user "$user" hermes profile create "$name" --no-alias --description "$OPT_DESCRIPTION" >/dev/null
    else
      as_user "$user" hermes profile create "$name" --no-alias >/dev/null
    fi
  fi
  [ -d "$profile" ] || die 1 "Hermes-Profil $name konnte nicht angelegt werden."

  port="${OPT_PORT:-$(conf_port "$name")}"
  [ -n "$port" ] || port="$(free_port)"
  case "$port" in ''|*[!0-9]*) die 1 "Ungültiger Port: $port" ;; esac

  env="$profile/.env"
  key=""
  [ ! -f "$env" ] || key="$(env_get "$env" API_SERVER_KEY)"
  [ -n "$key" ] || key="$(random_secret)"
  log "API-Server für $name einschalten ($(bridge_ip):$port, nur für Mission Control)"
  profile_env_set "$user" "$env" API_SERVER_ENABLED true
  profile_env_set "$user" "$env" API_SERVER_HOST "$(bridge_ip)"
  profile_env_set "$user" "$env" API_SERVER_PORT "$port"
  profile_env_set "$user" "$env" API_SERVER_KEY "$key"
  # eigener Gateway je Profil (Hermes bündelt sonst alle Profile, startet deren API-Server aber nicht)
  as_user "$user" hermes -p "$name" config set gateway.standalone true >/dev/null 2>&1 \
    || die 1 "Hermes-Einstellung gateway.standalone für $name konnte nicht gesetzt werden."

  [ -f "$PEERS_ENV" ] || install -m 600 /dev/null "$PEERS_ENV"
  env_set "$PEERS_ENV" "$(key_var "$name")" "$key"
  touch "$TEAM_CONF"
  awk -v n="$name" '$1 != n' "$TEAM_CONF" > "$TEAM_CONF.tmp"
  printf '%s %s\n' "$name" "$port" >> "$TEAM_CONF.tmp"
  mv "$TEAM_CONF.tmp" "$TEAM_CONF"
  chmod 644 "$TEAM_CONF"
  write_peers_yaml

  log "Agent $name starten (bonys-hermes-peer@$name)"
  write_peer_unit "$user"
  systemctl enable "bonys-hermes-peer@$name" >/dev/null 2>&1
  systemctl restart "bonys-hermes-peer@$name"
  restart_mission_control
  log "Fertig: $name ist in Mission Control angebunden (Status erscheint nach dem Start des Agenten)."
}

cmd_remove() {
  local name="$1" user env
  valid_name "$name"
  [ -n "$(conf_port "$name")" ] || die 1 "$name ist nicht angebunden."
  systemctl disable --now "bonys-hermes-peer@$name" >/dev/null 2>&1 || true
  user="$(agent_user)"
  env="$(user_home "$user")/.hermes/profiles/$name/.env"
  [ -f "$env" ] && profile_env_set "$user" "$env" API_SERVER_ENABLED false
  awk -v n="$name" '$1 != n' "$TEAM_CONF" > "$TEAM_CONF.tmp" && mv "$TEAM_CONF.tmp" "$TEAM_CONF"
  if [ -f "$PEERS_ENV" ]; then
    grep -v "^$(key_var "$name")=" "$PEERS_ENV" > "$PEERS_ENV.tmp" || true
    chmod 600 "$PEERS_ENV.tmp" && mv "$PEERS_ENV.tmp" "$PEERS_ENV"
  fi
  write_peers_yaml
  restart_mission_control
  log "$name ist nicht mehr angebunden (Hermes-Profil und seine Daten bleiben)."
}

cmd_list() {
  local name port
  if [ ! -s "$TEAM_CONF" ]; then
    log "Noch keine Hermes-Agenten angebunden (hermes-team.sh add NAME)."
    return 0
  fi
  printf '%-12s %-6s %-10s %s\n' NAME PORT DIENST API
  while read -r name port; do
    [ -n "$name" ] || continue
    printf '%-12s %-6s %-10s %s\n' "$name" "$port" \
      "$(systemctl is-active "bonys-hermes-peer@$name" 2>/dev/null || true)" "$(peer_health "$port")"
  done < "$TEAM_CONF"
}

[ $# -gt 0 ] || { usage >&2; exit 1; }
case "$1" in -h|--help) usage; exit 0 ;; esac
require_root
has_systemd || die 2 "systemd wird gebraucht (Agenten laufen als Dienste)."
CMD="$1"; shift
NAME=""
OPT_PORT="" OPT_DESCRIPTION="" OPT_USER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) OPT_PORT="${2:?}"; shift 2 ;;
    --description) OPT_DESCRIPTION="${2:?}"; shift 2 ;;
    --user) OPT_USER="${2:?}"; shift 2 ;;
    -*) die 1 "Unbekannte Option: $1" ;;
    *) [ -z "$NAME" ] || die 1 "Nur ein Name erlaubt."; NAME="$1"; shift ;;
  esac
done
case "$CMD" in
  add) [ -n "$NAME" ] || die 1 "Name fehlt (z. B. hermes-team.sh add atlas)."; cmd_add "$NAME" ;;
  remove) [ -n "$NAME" ] || die 1 "Name fehlt."; cmd_remove "$NAME" ;;
  list) cmd_list ;;
  *) usage >&2; die 1 "Unbekannter Befehl: $CMD" ;;
esac
