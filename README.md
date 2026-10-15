# Bony's Agents Mission Control

Open-Source-Dashboard („Mission Control“) für frei konfigurierbare Agenten-Teams.

> **Stand:** frühe Entwicklungsversion 0.1.0 – lauffähiges Grundgerüst, noch kein fertiges Produkt.

## Was ist Mission Control?

Mission Control zeigt ein Agenten-Team auf einen Blick: welche Agenten es gibt, welche Rolle sie haben,
woran gerade gearbeitet wird. Das Projekt ist **nicht fest auf Bonys Team verdrahtet** – Agenten, Rollen,
Pfade, Profile und Integrationen kommen aus YAML-Dateien und lassen sich für jedes Team anpassen.
Bonys Team wird als vorkonfiguriertes Beispielprofil mitgeliefert (`profiles/bonys-agents.example.yaml`).

## Die Bony's-Agents-Familie

![Bony's VPN: Tunnelliste, Details, Autostart und Kill-Switch](docs/images/missioncontrol.png)

Mission Control ist ein eigenständiges Projekt neben:

- **[Bony's Agents](https://github.com/zappotex/BonysAgents)** – virtuelle Agent-PCs mit Brave, Telegram und Hermes Agent
- **[Bony's VPN](https://github.com/zappotex/bonys-vpn)** – WireGuard-VPN mit Kill-Switch für Debian, Ubuntu und Linux Mint

Die Projekte teilen Herkunft und Stil, hängen technisch aber nicht voneinander ab.

## Was schon funktioniert

- React + Vite + TypeScript-Frontend im Bonys-Agents-Cyberpunk-Look
- Agenten-Flotte, geladen aus `config/agents.yaml` und dem aktiven Profil
- Node-Backend, liest die YAML-Dateien zur Laufzeit (`/api/health`, `/api/profiles`, `/api/bootstrap`)
- Live-Erreichbarkeit für Hermes-Peers über deren `/health`-Endpunkt (`online`/`offline`); ohne privaten Endpunkt ehrlich `standby`
- Frontend fällt ohne Backend auf veröffentlichungssichere Beispieldaten zurück
- Mission Board (Oberfläche vorhanden, Inhalte noch statisch)
- Setup-Wizard mit Live-YAML-Vorschau, Kopieren und Herunterladen
- Private Werte aus `*.local.yaml`-Profilen werden standardmäßig geschwärzt
- Docker-Image für amd64 und arm64, Installation auf Agent-PCs per Skript (siehe unten)

**Noch nicht:** Profilauswahl im Frontend, Profile auf dem Server speichern, tatsächliche Beschäftigung laufender Hermes-Aufträge,
Obsidian-/Projektindex, dauerhaft gespeicherte Missionen. Siehe [docs/plan.md](docs/plan.md).

## Installation mit Bony's Agents

[Bony's Agents](https://github.com/zappotex/BonysAgents) installiert Mission Control automatisch in
Agent-PCs (Debian 13, amd64 und arm64) – beim Erstellen oder nachträglich. Dabei läuft im Agent-PC als root:

```bash
curl -fsSLo /tmp/mc-install.sh \
  https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.1.0/install.sh
bash /tmp/mc-install.sh --version 0.1.0 --user agent --install-deps
```

Ergebnis: Mission Control läuft als Docker-Container unter **http://127.0.0.1:8787/** (nur lokal), startet
mit dem System (`bonys-mission-control.service`) und hat die Desktop-Verknüpfung **„Mission Control“**,
die die Oberfläche im Standardbrowser (Brave) öffnet. Geheimnisse werden beim ersten Start zufällig erzeugt.

Update, Deinstallation, Vorlagen und alle Optionen: **[docs/installation-agent-pc.md](docs/installation-agent-pc.md)**.
Mindestanforderungen maschinenlesbar: [`agentpc.json`](agentpc.json).

## Manuelle Installation

Auf einem eigenen Debian-/Ubuntu-Rechner mit systemd:

```bash
curl -fsSLO https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.1.0/install.sh
curl -fsSLO https://github.com/zappotex/bonys-agents-mission-control/releases/download/v0.1.0/SHA256SUMS
grep ' install.sh$' SHA256SUMS | sha256sum -c -
sudo bash install.sh --version 0.1.0 --install-deps          # --user NAME für die Desktop-Verknüpfung
```

Ohne `--install-deps` bricht das Skript ab, wenn Docker oder das Compose-Plugin fehlen (Exit-Code 2).
Danach im Browser `http://127.0.0.1:8787/` öffnen.

```bash
sudo /opt/bonys-mission-control/scripts/update.sh --version latest   # aktualisieren, Daten bleiben
sudo /opt/bonys-mission-control/scripts/uninstall.sh                 # entfernen, Daten bleiben
sudo /opt/bonys-mission-control/scripts/uninstall.sh --purge         # alles entfernen
```

Ganz ohne Skript geht es mit `deploy/compose.yaml` und einer `.env` (aus `.env.example`, Geheimnisse
selbst setzen, z. B. mit `openssl rand -hex 32`):

```bash
docker compose -f deploy/compose.yaml --project-directory . --env-file .env up -d
```

## Voraussetzungen (Entwicklung)

- Node.js **20.19+** oder **22.12+** (wegen Vite 8)
- optional Docker mit Compose

## Entwicklung

```bash
npm install
npm run backend                # API auf http://127.0.0.1:8788
npm run dev -- --host 0.0.0.0  # Frontend, leitet /api an das Backend weiter
```

## Build prüfen

```bash
npm run build
npm run lint
npm test
tests/agentpc/run.sh           # Installationstest in frischem Debian 13 (braucht Docker)
MISSION_CONTROL_API_PORT=8790 npm run backend
```

Danach liefert `http://127.0.0.1:8790` das gebaute Frontend und `http://127.0.0.1:8790/api/bootstrap` die Daten.

## Docker

```bash
docker compose up --build
```

Danach: `http://127.0.0.1:8787` (Port nur lokal freigegeben)

## Konfiguration

| Datei | Zweck |
|---|---|
| `config/app.yaml` | App-Einstellungen und Feature-Schalter |
| `config/agents.yaml` | neutrale Standard-Agentenliste (`Atlas`, `Nova`, `Scribe`) |
| `config/peers.example.yaml` | Muster für private Hermes-Peer-Endpunkte |
| `config/paths.example.yaml` | Beispiel für lokale Pfade |
| `config/setup-wizard.schema.yaml` | Felder des Setup-Wizards |
| `profiles/*.yaml` | Teamprofile (`example-team.yaml`, `bonys-agents.example.yaml`) |

Ein Profil kann seine eigene vollständige `agents:`-Liste enthalten. Diese hat Vorrang vor
`config/agents.yaml`. Dadurch bleibt die allgemeine Beispielkonfiguration neutral, während
`bonys-agents.example.yaml` Bonys Team als getrenntes, veröffentlichungssicheres Preset mitliefert.

Umgebungsvariablen des Backends:

| Variable | Standard | Bedeutung |
|---|---|---|
| `MISSION_CONTROL_API_HOST` | `127.0.0.1` | Adresse, auf der das Backend lauscht (im Container `0.0.0.0`) |
| `MISSION_CONTROL_API_PORT` | `8788` | Port |
| `MISSION_CONTROL_PROFILE` | `bonys-agents.example.yaml` | aktives Profil |
| `MISSION_CONTROL_SHOW_PRIVATE` | `false` | `true` zeigt Werte aus `*.local.yaml` ungeschwärzt |
| `MISSION_CONTROL_DATA_DIR` | – (im Container `/app/data`) | Datenordner; eigene Profile in `<Datenordner>/profiles/` |

### Hermes-Peer-Erreichbarkeit

Private Peer-Adressen kommen in `<MISSION_CONTROL_DATA_DIR>/peers.yaml` (im Container `/app/data/peers.yaml`):

```yaml
peers:
  barney:
    endpoint: http://barney.internal:8377
```

Der Schlüssel (`barney`) entspricht `peer:` in `config/agents.yaml`. Mission Control ruft ausschließlich
`GET /health` mit 1,5 Sekunden Zeitlimit ab. Ein erfolgreicher Hermes-Healthcheck ergibt `online`, ein nicht
erreichbarer konfigurierter Peer `offline`; ohne Endpunkt bleibt der Status `standby`. `busy` wird nicht aus
Erreichbarkeit abgeleitet, weil erst eine spätere Auftragsintegration echte Beschäftigung belegen kann.
Peer-Adressen aus `peers.yaml` werden nicht an das Frontend ausgeliefert.

## Datenschutz

Private Pfade, Peer-Adressen, Tokens und andere Geheimnisse gehören **nicht** ins Repository.
Eigene Werte kommen in eine Datei `profiles/<name>.local.yaml` – diese ist per `.gitignore` ausgeschlossen.
Öffentliche Profile verwenden Platzhalter wie `CHANGE_ME_PEER_URL` und `CHANGE_ME_PRIVATE_PATH`.
Private Peer-Adressen für die Live-Prüfung liegen ausschließlich im Daten-Volume als `peers.yaml`.

Der Setup-Wizard schreibt bewusst noch keine Dateien auf den Server, damit private Pfade nicht unbemerkt
gespeichert oder veröffentlicht werden.

## Lizenz

Freie Software unter der **GNU General Public License, Version 3 oder neuer** (GPL-3.0-or-later),
wie Bony's Agents – siehe [LICENSE](LICENSE).

## YouTube

Mehr zu Bony's Agents auf YouTube: **[@BonysAgents](https://www.youtube.com/@BonysAgents)**

---

## English (short)

**Bony's Agents Mission Control** is an open-source dashboard for configurable AI-agent teams. Agents,
roles, paths and integrations are defined in YAML profiles; Bony's own team ships as an example profile.
It is a sibling of [Bony's Agents](https://github.com/zappotex/BonysAgents) and
[Bony's VPN](https://github.com/zappotex/bonys-vpn), but technically independent.

**Status:** development version 0.2.0 – React/Vite/TypeScript frontend, Node backend reading YAML at
runtime, setup wizard, Docker files and live Hermes peer reachability. Not yet: profile switching, saving
profiles, persisted missions or real busy state from running peer jobs.

**Install (Debian/Ubuntu, amd64/arm64):** download `install.sh` from the latest release and run
`sudo bash install.sh --version 0.1.0 --install-deps`, then open `http://127.0.0.1:8787/`.
Details: [docs/installation-agent-pc.md](docs/installation-agent-pc.md).
**Development:** Node.js 20.19+ or 22.12+, then `npm install`, `npm run backend`, `npm run dev`.

**License:** GPL-3.0-or-later. **YouTube:** [@BonysAgents](https://www.youtube.com/@BonysAgents)
