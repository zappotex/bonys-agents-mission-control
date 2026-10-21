# Bonys Agents Mission Control — Zusammenfassung

Stand: 2026-10-17, lokale Entwicklungsversion 0.2.0

Diese Zusammenfassung beschreibt ausschließlich den im Repository belegbaren lokalen Stand. 0.2.0 ist ein
Vorbereitungs-/Entwicklungsstand und noch kein freigegebener Veröffentlichungsstand.

## Funktionsumfang

- React-/Vite-/TypeScript-Frontend und Node-Backend.
- YAML-basierte Konfiguration mit neutraler Standard-Agentenliste und auswählbaren Teamprofilen.
- Profilwähler im Dashboard; die Auswahl wird lokal im Browser gespeichert und beim Profilwechsel erneut
  vom Backend geladen. Backend-Fallbackdaten bleiben veröffentlichungssicher.
- Setup-Wizard mit Live-YAML-Vorschau, Kopieren, Herunterladen und serverseitigem Speichern eines neuen
  lokalen Profils im konfigurierten Datenordner.
- Profilbezogen gespeicherte Missionen im lokalen Datenordner: anlegen, Agent zuweisen sowie zwischen
  `planned`, `running`, `review` und `done` wechseln; Titel, Beschreibung und Ergebnisnotiz lassen sich
  nachträglich pflegen, fertige Ergebnisse erscheinen zusätzlich in einer kleinen Outbox-Ansicht. Die Mission-Liste
  kann durchsucht und nach Status gefiltert werden; leere Such- und Filterergebnisse werden eindeutig erklärt.
- Hermes-Run-Lifecycle aus einer Mission: serverseitiger Start über den privaten Peer, persistierte Run-
  Metadaten, maximal 25 sichere History-Einträge pro Mission, Statusabfrage und Stoppen eines laufenden Runs.
  Wiederholte Starts derselben Mission sind über einen stabilen Idempotency-Schlüssel abgesichert; ältere
  Versuchsantworten dürfen den aktuellen Versuch nicht überschreiben. Die UI zeigt den Verlauf pro Mission
  in einer zugänglichen Detailansicht.
- Peer-Erreichbarkeit über `health`; mit serverseitig verfügbarem Peer-Schlüssel zusätzlich authentifizierter
  Arbeitsstatus über `health/detailed`.
- Read-only-Markdown-/Obsidian-Projektindex mit begrenzter Ausgabe von Titel, Datum und Tags.
- Docker-/Compose-Dateien und Agent-PC-Installationsskripte sind im Repository vorhanden; diese Dokumentation
  behauptet keine externe Veröffentlichung oder Registry-Verfügbarkeit.

## Sicherheits- und Datenschutzgrenzen

- Entwicklungsserver binden standardmäßig an `127.0.0.1`; weitergeleitete Schreibzugriffe benötigen den
  serverseitig konfigurierten Bearer-Token.
- Der Vite-Proxy setzt die Authentisierung serverseitig für alle geschützten Schreibendpunkte: Profil-
  speichern, Missionen anlegen/ändern sowie Run-Start, Run-Status und Run-Stop. Der Token wird nicht in das
  Browser-Bundle übernommen.
- Peer-Endpunkte und Peer-Credentials bleiben im Backend bzw. in der Serverumgebung. Sie werden nicht an das
  Frontend ausgeliefert.
- Private Profilwerte werden standardmäßig geschwärzt. Lokale Profile werden nur bei ausdrücklicher
  Aktivierung von `MISSION_CONTROL_SHOW_PRIVATE=true` berücksichtigt.
- Profil- und Missionsspeicher öffnen Datenverzeichnisse ohne unsicheres Symlink-Following und schreiben
  persistente Daten atomar mit restriktiven Dateirechten.
- Der Markdown-Index arbeitet read-only mit Grenzen für Dateianzahl, Verzeichnistiefe und Dateigröße; er
  liefert keine Dateiinhalte oder privaten Pfade an das Frontend.

## Lokale Verifikation

Die Release-Vorbereitung prüft lokal:

- `npm test`
- `npm run lint`
- `npm run build`
- `npm audit`
- Node-Syntaxchecks für Backend- und Laufzeitmodule
- `bash -n` für die Shellskripte
- `git diff --check`
- README-Links und referenzierte Repository-Pfade

Die konkreten Ergebnisse gehören zum jeweils zuletzt ausgeführten lokalen Prüfprotokoll in
`docs/release-notes/0.2.0.md`.

## Offene Release-Schritte

- 0.2.0 ist lokal vorbereitet, aber noch nicht veröffentlicht.
- Das lokale Release-Bundle und `SHA256SUMS` wurden erzeugt und geprüft.
- Tag, GitHub-Release, GHCR-Image und externe Release-Kommunikation gehören in einen späteren,
  ausdrücklich freigegebenen Veröffentlichungslauf. Externe Zustände müssen dann erneut geprüft werden.

## Zentrale Dateien

- Frontend: `src/App.tsx`, `src/App.css`, `src/main.tsx`
- Backend: `server/server.mjs`
- Sicherheitslogik: `server/request-security.mjs`, `src/vite-proxy-runtime.mjs`
- Konfiguration: `config/app.yaml`, `config/agents.yaml`, `config/setup-wizard.schema.yaml`
- Öffentliche Profile: `profiles/example-team.yaml`, `profiles/bonys-agents.example.yaml`
- Planung: `docs/plan.md`
- Release-Draft: `docs/release-notes/0.2.0.md`
