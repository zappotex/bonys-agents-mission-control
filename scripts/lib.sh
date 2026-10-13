# shellcheck shell=bash
# Gemeinsame Hilfsfunktionen für die Mission-Control-Skripte auf einem Agent-PC.
# Wird von update.sh, uninstall.sh, reset-secrets.sh, ensure-secrets.sh und install.sh eingebunden.

# shellcheck disable=SC2034  # werden von den einbindenden Skripten benutzt
MC_NAME="bonys-mission-control"
MC_DIR="${MC_DIR:-/opt/bonys-mission-control}"
MC_UNIT="bonys-mission-control.service"
MC_VOLUME="bonys-mission-control-data"
MC_REPO="zappotex/bonys-agents-mission-control"
MC_SECRET_PLACEHOLDER="__GENERATE__"

log() { printf '[mission-control] %s\n' "$*"; }
warn() { printf '[mission-control] WARNUNG: %s\n' "$*" >&2; }
die() {  # $1 = Exit-Code, Rest = Meldung
  local code="$1"; shift
  printf '[mission-control] FEHLER: %s\n' "$*" >&2
  exit "$code"
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die 1 "Bitte als root ausführen (z. B. mit sudo)."
}

has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

compose() { docker compose --project-directory "$MC_DIR" -f "$MC_DIR/compose.yaml" --env-file "$MC_DIR/.env" "$@"; }

# Wert aus einer .env-Datei lesen (ohne die Datei auszuführen)
env_get() {  # $1 = Datei, $2 = Schlüssel
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1
}

# Wert in einer .env-Datei setzen oder anhängen
env_set() {  # $1 = Datei, $2 = Schlüssel, $3 = Wert
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "$file.XXXXXX")"
  if grep -q "^$key=" "$file"; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$file" > "$tmp"
  else
    cat "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Schlüssel, die laut .env.example automatisch erzeugt werden
secret_keys() {
  sed -n "s/^\([A-Z0-9_]*\)=$MC_SECRET_PLACEHOLDER\$/\1/p" "$MC_DIR/.env.example"
}

# .env anlegen, neue Schlüssel aus .env.example ergänzen, Platzhalter durch Zufallswerte ersetzen.
# Gibt nie Werte aus.
ensure_env() {
  local env="$MC_DIR/.env" key line created=0 generated=0
  if [ ! -f "$env" ]; then
    install -m 600 "$MC_DIR/.env.example" "$env"
    created=1
  fi
  chmod 600 "$env"
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    grep -q "^$key=" "$env" || printf '%s\n' "$line" >> "$env"
  done < "$MC_DIR/.env.example"
  for key in $(secret_keys); do
    if [ "$(env_get "$env" "$key")" = "$MC_SECRET_PLACEHOLDER" ] || [ -z "$(env_get "$env" "$key")" ]; then
      env_set "$env" "$key" "$(random_secret)"
      generated=$((generated + 1))
    fi
  done
  [ "$created" -eq 1 ] && log ".env aus .env.example erzeugt."
  [ "$generated" -gt 0 ] && log "$generated Geheimnis(se) neu erzeugt (Werte werden nicht angezeigt)."
  return 0
}

# Antwort von /api/health holen (curl, wget oder python3 – was vorhanden ist)
fetch_health() {  # $1 = Port
  local url="http://127.0.0.1:$1/api/health"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- -T 3 "$url"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.request;print(urllib.request.urlopen(sys.argv[1],timeout=3).read().decode())' "$url"
  else
    docker inspect -f '{{.State.Health.Status}}' "$MC_NAME" 2>/dev/null | grep -qx healthy && echo '"ok": true'
  fi
}

# Wartet, bis die Oberfläche antwortet und der Container "healthy" ist
wait_healthy() {  # $1 = Port, $2 = erwartete Version (optional), $3 = Sekunden (Standard 120)
  local port="$1" version="${2:-}" timeout="${3:-120}" waited=0 body state
  while [ "$waited" -lt "$timeout" ]; do
    body="$(fetch_health "$port" 2>/dev/null || true)"
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$MC_NAME" 2>/dev/null || echo missing)"
    if printf '%s' "$body" | grep -q '"ok": *true' && [ "$state" = healthy ]; then
      if [ -z "$version" ] || printf '%s' "$body" | grep -q "\"version\": *\"$version\""; then
        return 0
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Home- und Schreibtisch-Ordner des Agent-Benutzers
user_home() { getent passwd "$1" | cut -d: -f6; }

user_desktop_dir() {  # $1 = Benutzer
  local user="$1" home dir=""
  home="$(user_home "$user")"
  if [ -f "$home/.config/user-dirs.dirs" ]; then
    dir="$(sed -n 's/^XDG_DESKTOP_DIR="\(.*\)"$/\1/p' "$home/.config/user-dirs.dirs" | sed "s|\$HOME|$home|")"
  fi
  if [ -z "$dir" ]; then
    for candidate in "$home/Schreibtisch" "$home/Desktop"; do
      [ -d "$candidate" ] && dir="$candidate" && break
    done
  fi
  if [ -z "$dir" ]; then
    case "${LANG:-}" in de*) dir="$home/Schreibtisch" ;; *) dir="$home/Desktop" ;; esac
  fi
  printf '%s\n' "$dir"
}

desktop_entry() {  # $1 = Port
  cat <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=Mission Control
Comment=Bony's Agents Mission Control im Browser öffnen
Exec=xdg-open http://127.0.0.1:$1/
Icon=$MC_DIR/share/mission-control.svg
Terminal=false
Categories=Network;Utility;
StartupNotify=false
DESKTOP
}

# Verknüpfung im Anwendungsmenü und auf dem Schreibtisch des Agent-Benutzers
install_desktop_shortcut() {  # $1 = Benutzer, $2 = Port, $3 = Schreibtisch-Ordner (optional)
  local user="$1" port="$2" dir="${3:-}" group file
  install -d -m 755 /usr/share/applications
  desktop_entry "$port" > /usr/share/applications/bonys-mission-control.desktop
  chmod 644 /usr/share/applications/bonys-mission-control.desktop
  [ -n "$user" ] || return 0
  [ -n "$dir" ] || dir="$(user_desktop_dir "$user")"
  group="$(id -gn "$user")"
  if [ ! -d "$dir" ]; then
    install -d -o "$user" -g "$group" "$dir"
  fi
  file="$dir/bonys-mission-control.desktop"
  desktop_entry "$port" > "$file"
  chown "$user:$group" "$file"
  chmod 755 "$file"
  # GNOME (Desktop-Icons-Erweiterung) startet nur vertrauenswürdige Starter; klappt nur mit laufender Sitzung
  runuser -u "$user" -- gio set "$file" metadata::trusted true >/dev/null 2>&1 || true
  printf '%s\n' "$file"
}

remove_desktop_shortcuts() {
  local conf="$MC_DIR/install.conf" dir
  rm -f /usr/share/applications/bonys-mission-control.desktop
  dir="$(env_get "$conf" DESKTOP_DIR)"
  [ -n "$dir" ] && rm -f "$dir/bonys-mission-control.desktop"
  return 0
}
