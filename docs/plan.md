# Plan – nächste Schritte

Stand: 2026-10-21, Version 0.2.2. Grundlage ist die [Zusammenfassung](zusammenfassung.md)
(Abschnitt „Nächster sinnvoller Schritt“). Jede Sitzung soll mit grünem Lint, Typprüfung, Build
und Tests enden.

## Sitzung A – Installation in Agent-PCs (erledigt, 0.1.0)

- `scripts/install.sh`, `update.sh`, `uninstall.sh`, `reset-secrets.sh`, `ensure-secrets.sh`,
  `deploy/compose.yaml`, `.env.example`, `agentpc.json`, Doku in `installation-agent-pc.md`.
- Mehrstufiges Image auf `node:24-alpine`, läuft als `node`, amd64 + arm64, GHCR-Veröffentlichung per Tag.
- CI: Lint, Typen/Build, Backend-Tests, shellcheck, gitleaks (ganze Historie), Multi-Arch-Build mit
  arm64-Starttest unter QEMU, Installationstest in Debian 13 mit systemd.
- Dadurch aus Sitzung 1 schon erledigt: CI, Node-LTS, mehrstufiger Build, Backend standardmäßig an
  127.0.0.1, Fehlermeldungen ohne Interna, erste Tests.

## Sitzung 1 – Fundament: Tests, CI, Laufzeit (erledigt)

- Testrahmen einführen (z. B. Vitest) und das Backend testbar machen
  (Funktionen aus `server/server.mjs` exportieren bzw. in ein Modul auslagern).
- Erste Tests: Schwärzung privater Werte, `sanitizeProfileName` (keine `.local.yaml` ohne Freigabe,
  kein Pfad-Ausbruch), statische Auslieferung nur aus `dist/`, `/api/bootstrap` mit Beispielprofil.
- GitHub Actions: `npm ci`, `npm run lint`, `tsc -b`, `npm run build`, Tests, gitleaks.
- Docker-Basisimage von `node:20-alpine` auf eine noch gepflegte LTS-Version (22 oder 24) heben;
  Build mit `npm ci --omit=dev` im Laufzeit-Image (mehrstufiger Build).
- Backend im Dev-Modus standardmäßig nur an `127.0.0.1` binden; Fehlermeldungen an Clients ohne Interna.
- Vite-Vorlagenreste prüfen (`src/assets/react.svg`, `vite.svg`) und entfernen, falls ungenutzt.

## Sitzung 2 – Profilauswahl im Frontend (erledigt)

- Profilliste aus `/api/profiles` anzeigen, Wechsel lädt `/api/bootstrap?profile=…`.
- Gewähltes Profil im Browser merken; `*.local.yaml` nur, wenn das Backend sie freigibt.
- Kennzeichnung „öffentlich / nur lokal“ in der Oberfläche.

## Sitzung 3 – Profile speichern (erledigt)

- `POST /api/profiles`: Wizard-Ergebnis serverseitig gegen `config/setup-wizard.schema.yaml` prüfen
  und als `profiles/<slug>.local.yaml` speichern (nie als öffentliches Profil überschreiben).
- Schutz: nur von localhost oder mit Token aus `.env`; Dateinamen streng prüfen.
- Tests für Validierung und Dateinamen.

## Sitzung 4 – Hermes-Peer-Status (erledigt)

- Peers aus dem Profil periodisch abfragen (Zeitlimit, Fehler tolerieren) und echten Status statt
  der festen `defaultStatusById`-Werte anzeigen.
- Endpunkte nur aus lokalen Profilen, nie im öffentlichen Repo.

## Sitzung 5 – Obsidian-/Projektindex (MVP erledigt)

- Markdown-Dateien eines konfigurierten Ordners nur lesend indizieren (Titel, Datum, Tags).
- Anzeige im Board; private Pfade bleiben geschwärzt.
- Sicherheitsgrenzen wie beim Profilzugriff: kanonischer Basisordner, keine Symlink-Folge, begrenzte Dateizahl
  und Dateigröße, keine Dateiinhalte oder privaten Pfade in öffentlichen API-Antworten.
- Umgesetzt: rekursiver read-only Markdown-Index bis Tiefe 4, maximal 100 Dateien und 256 KiB pro Datei;
  Ausgabe ausschließlich von stabiler ID, Titel, Datum und Tags im Mission Board.

## Sitzung 6 – Missionen dauerhaft speichern (erledigt)

- Mission Board von statischen Daten auf eine profilbezogene JSON-Ablage im lokalen Datenordner umgestellt.
- Missionen lassen sich im Dashboard anlegen, Agenten zuweisen und zwischen `Geplant`, `Aktiv`, `Review` und `Fertig` verschieben.
- `GET /api/missions`, `POST /api/missions` und `PATCH /api/missions/<id>` umgesetzt.
- Frontend lädt beim Profilwechsel die passenden Missionen und verwirft alte Profilansichten während des Ladens.
- Der Vite-Entwicklungsproxy authentifiziert serverseitig sämtliche geschützten Schreibendpunkte: Profil-
  speichern, Missionen anlegen/ändern sowie Run-Start, Run-Status und Run-Stop. `MISSION_CONTROL_API_TOKEN`
  wird ausschließlich serverseitig übernommen und gelangt nicht in das Browser-Bundle.
- Browser-Round-trip für Anlegen, Neuzuweisung, Statuswechsel und persistentes Neuladen erfolgreich geprüft.

## Sitzung 8 – Hermes-Aufträge aus Missionen starten (erledigt)

- `POST /api/missions/<id>/run` startet einen echten asynchronen Hermes-Auftrag über den privaten Peer-Endpunkt `/v1/runs`.
- Peer-Endpunkt und Credential werden ausschließlich serverseitig aus dem privaten Peer-Datensatz aufgelöst.
- Missionen speichern `runId`, `agentId`, normalisierten `runStatus`, Startzeit und stabile Idempotency-ID.
- Wiederholte Startanforderungen für dieselbe Mission erzeugen keinen zweiten Run.
- Das Frontend pollt für laufende Runs den Status über `/api/missions/<id>/run/status` und kann einen laufenden Run über `/api/missions/<id>/run/stop` stoppen.
- Das Backend führt pro Mission eine persistente, sichere History mit maximal 25 Versuchen; Claims sind idempotent, Legacy-Top-Level-Runs werden beim Rerun zurückgeschrieben und Attach/Status-Updates sind gegen ältere Versuche gefencet.
- Die Mission-Details zeigen den Verlauf zugänglich über natives `<details>`; die Frontend-Runtime normalisiert History-Antworten erneut auf erlaubte Felder.
- Regressionstests für 25er-Grenze, Legacy-Backfill, Cross-Attempt-Fence, API-Sanitization und die getesteten Runtime-Helper ergänzt.
- Legacy-Backfill erfindet keine Versuche: ein terminaler Top-Level-Run ohne `runAttempt`/`runId` wird nur dann als eigener Versuch archiviert, wenn eine Start- oder Abschlusszeit belegt ist; reine Status- oder Agentenreste werden nicht zu einem Versuch hochgestuft.
- Bewusste Entscheidung: Der abgeleitete `idempotencyKey` (`mission:<id>:run:v<n>`) ist intern und enthält kein Secret, wird aber an den Browser ausgeliefert, weil das Frontend die Versuchsidentität stabil anzeigen muss.

## Sitzung 10 – StarNet-inspirierte Task-Brief-UX (kleiner Block, erledigt)

- Missionen können im Board nachträglich mit Titel und Beschreibung präzisiert werden.
- Backend validiert die Felder weiterhin serverseitig und persistiert Änderungen profilbezogen.
- Frontend bietet eine begrenzte Inline-Bearbeitung mit Speichern/Abbrechen, ohne neue Laufzeit- oder Agentenarchitektur.
- Regressionstest ergänzt; Abschluss mit `npm test` (130/130) und `npm run build` erfolgreich.
- Bewusste Kostenbegrenzung: kein neuer Peer-Run, keine große Review-Schleife, keine Veröffentlichung.

## Sitzung 11 – Mission-Board-Statusfilter (kleiner Block, erledigt)

- Das Mission Board bietet eine kompakte Filterleiste für `Alle`, `Aktiv`, `Geplant`, `Review` und `Fertig`.
- Die Filterung bleibt rein frontendseitig; Backend, Speicherformat und Hermes-Run-Lifecycle bleiben unverändert.
- Die Filterlogik liegt im getesteten Runtime-Modul und wird von der Oberfläche verwendet.
- Browserprüfung des gebauten Dev-Frontends erfolgreich; keine JavaScript-Fehler. Ohne laufendes Backend zeigt die UI erwartungsgemäß den Fallback-/Fehlerhinweis.
- `npm test` (131/131), `npm run build` und `git diff --check` erfolgreich.
- Bewusste Kostenbegrenzung: kein Peer-Run, keine neue Backend-Route, keine Veröffentlichung.

## Sitzung 12 – Kleine Ergebnis-Outbox (kleiner Block, erledigt)

- Missionen können eine optionale Ergebnis-/Output-Notiz bis 4.000 Zeichen erhalten.
- Fertige Missionen mit Ergebnisnotiz erscheinen in einer kompakten Outbox unter dem Mission Board.
- Es werden keine Dateien verschoben, keine Pfade automatisch gelesen und keine Links als vertrauenswürdig behandelt; dies ist bewusst nur die sichere Ergebnisnotiz-Grundlage.
- Browserprüfung des gebauten Dev-Frontends erfolgreich; Outbox und Leerzustand werden gerendert, keine JavaScript-Fehler.
- `npm test` (131/131), `npm run build` und `git diff --check` erfolgreich.
- Bewusste Kostenbegrenzung: keine neue Agentenaktivität, keine Dateisystem-Automation, keine Veröffentlichung.

## Sitzung 13 – Ergebnisarten (kleiner Block, erledigt)

- Ergebnisnotizen erhalten eine explizite Art: `Notiz`, `Link` oder `Datei-Referenz`.
- Die Art wird serverseitig allowlist-basiert validiert und gemeinsam mit der Ergebnisnotiz gespeichert.
- Die Outbox zeigt die Art sichtbar an, behandelt den Inhalt aber weiterhin nur als Text.
- Keine URL-Prüfung, kein Dateizugriff und keine automatische Dateioperation wurden eingeführt.
- `npm test` (131/131), `npm run build` und `git diff --check` erfolgreich; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: kein Peer-Run, keine neue Agentenlaufzeit, keine Veröffentlichung.

## Sitzung 14 – Mission-Suche (kleiner Block, erledigt)

- Missionen können frontendseitig nach Titel, Beschreibung oder Owner durchsucht werden.
- Die Suche kombiniert sich mit dem vorhandenen Statusfilter und führt keine neue API-Abfrage aus.
- Suche und Statusfilter sind in einer deterministischen Runtime-Funktion getestet.

## Sitzung 15 – Statuszahlen (kleiner Block, erledigt)

- Die Filterbuttons zeigen die aktuelle Anzahl je Status sowie die Gesamtzahl.
- Die Zählung erfolgt lokal aus dem bereits geladenen Missionsbestand.

## Sitzung 16 – Deterministische Ergebnis-Outbox (kleiner Block, erledigt)

- Fertige Ergebnisse werden zentral über eine Runtime-Funktion ermittelt.
- Die Outbox berücksichtigt nur fertige Missionen mit nicht-leerer Ergebnisnotiz und sortiert nach Aktualisierungszeit absteigend.
- Inhalte bleiben reine Textwerte; keine Datei- oder Linkoperationen.

## Sitzung 17 – Ergebnisarten-Validierung (kleiner Block, erledigt)

- Ungültige Ergebnisarten wie `script` werden serverseitig mit HTTP 400 abgewiesen.
- Der Regressionstest schützt die Allowlist `note`, `link`, `file`.
- Abschlussstand: `npm test` 132/132, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichungen, keine Abo-Route außerhalb von `abo-spar` erforderlich.

## Sitzung 18 – Präzise Leerzustände (kleiner Block, erledigt)

- Der Mission-Bereich unterscheidet jetzt zwischen einem leeren Profil, einer erfolglosen Suche und einem leeren Statusfilter.
- Bei aktiver Suche oder Statusauswahl kann die Ansicht mit einem Klick zurückgesetzt werden.

## Sitzung 19 – Ergebnisart auf Mission Cards (kleiner Block, erledigt)

- Ergebnisnotizen zeigen ihre Art jetzt auch direkt in der Mission Card.
- Unbekannte oder fehlende Ergebnisarten fallen sicher auf `Notiz` zurück; leere Ergebnisse erhalten kein Badge.

## Sitzung 20 – Ergebnisfeld mit Zeichenzähler (kleiner Block, erledigt)

- Die Inline-Bearbeitung zeigt für das Ergebnisfeld den aktuellen Stand bis zum Limit von 4.000 Zeichen.
- Das Limit bleibt zusätzlich durch `maxLength` im Browser und die serverseitige Validierung geschützt.

## Sitzung 21 – Sauberes Leeren von Ergebnissen (kleiner Block, erledigt)

- Wird eine Ergebnisnotiz gelöscht, entfernt die Persistenz auch die zugehörige `resultKind`-Metadaten.
- Ein Regressionstest prüft API-Antwort und gespeicherten Missionsdatensatz.
- Abschlussstand: `npm test` 134/134, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 22 – Outbox-Zeitstempel (kleiner Block, erledigt)

- Fertige Ergebnisse zeigen neben Art und Inhalt auch den letzten Änderungszeitpunkt.
- Ungültige Zeitstempel werden neutral als `—` dargestellt.

## Sitzung 23 – Zugängliche Statusfilter (kleiner Block, erledigt)

- Aktive Statusfilter melden ihren Zustand zusätzlich über `aria-pressed`.

## Sitzung 24 – Suche direkt leeren (kleiner Block, erledigt)

- Ein sichtbares X leert die Mission-Suche direkt im Suchfeld.
- Die Aktion ist beschriftet und per Tastatur erreichbar.

## Sitzung 25 – Mission-Gesamtzahl (kleiner Block, erledigt)

- Die Kennzahl im Hero-Bereich zeigt jetzt die Gesamtzahl der geladenen Missionen statt nur der aktuell gefilterten Treffer.
- Die gefilterte Liste und ihre Statuszahlen bleiben davon getrennt.
- Abschlussstand: `npm test` 135/135, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 26 – Ergebnisarten im Browser normalisieren (kleiner Block, erledigt)

- Die gemeinsame Browser-Runtime erlaubt nur `note`, `link` und `file` und entfernt die Ergebnisart bei leerem Ergebnis.
- Ein Regressionstest schützt den Fallback auf `note` gegen manipulierte oder alte Backend-Payloads.

## Sitzung 27 – Outbox nutzt sichere Ergebnislabels (kleiner Block, erledigt)

- Die Outbox verwendet dieselbe normalisierte Ergebnisartenlogik wie die Mission Cards.
- Unbekannte Backendwerte können dadurch nicht als leere UI-Labels erscheinen.

## Sitzung 28 – Outbox-Updates zugänglich ankündigen (kleiner Block, erledigt)

- Die Outbox ist als `aria-live="polite"` markiert und kündigt neue oder entfernte Ergebnisse nicht störend an.

## Sitzung 29 – Ergebnisfeld zugänglich verknüpfen (kleiner Block, erledigt)

- Das Ergebnis-Textarea ist jetzt eindeutig mit seinem Zeichenzähler über `aria-describedby` verbunden.
- Abschlussstand: `npm test` 135/135, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 30 – Outbox-Ergebnisse sicher kopierbar machen (kleiner Block, erledigt)

- Die Runtime stellt Ergebniswerte für die Zwischenablage ausschließlich als getrimmten String bereit.
- Die Outbox bietet eine lokale Kopieraktion; Dateien werden dadurch weiterhin weder geöffnet noch verarbeitet.

## Sitzung 31 – Kopierstatus sichtbar machen (kleiner Block, erledigt)

- Die Kopieraktion zeigt kurzzeitig `Kopiert` oder bei einem Fehler eine verständliche Rückmeldung.

## Sitzung 32 – Outbox-Kontext ergänzen (kleiner Block, erledigt)

- Fertige Ergebnisse zeigen zusätzlich den zuständigen Owner neben der Ergebnisart.

## Sitzung 33 – Outbox-Zähler zugänglich beschriften (kleiner Block, erledigt)

- Die Ergebnisanzahl besitzt jetzt eine sprechende `aria-label`-Beschriftung.
- Abschlussstand: `npm test` 136/136, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 34 – Filterzusammenfassung anzeigen (kleiner Block, erledigt)

- Das Mission Board zeigt jetzt sichtbar, wie viele Missionen nach Suche und Statusfilter sichtbar sind.
- Suchtext und gewählter Status werden in derselben Zusammenfassung verständlich benannt.

## Sitzung 35 – Outbox-Zeitstempel fail-closed sortieren (kleiner Block, erledigt)

- Gültige `updatedAt`-Werte werden chronologisch absteigend sortiert.
- Ungültige Zeitstempel landen deterministisch am Ende und können keine aktuelle Mission überlagern.

## Sitzung 36 – Filterbereich mit Missionsliste verknüpfen (kleiner Block, erledigt)

- Der Filterbereich verweist jetzt über `aria-controls` auf die konkrete Missionsliste.

## Sitzung 37 – Kopierstatus zugänglich ankündigen (kleiner Block, erledigt)

- Der Outbox-Kopierbutton kündigt Statusänderungen mit `aria-live="polite"` und `aria-atomic="true"` an.
- Abschlussstand: `npm test` 138/138, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 38 – Filterzusammenfassung als Runtime-Funktion (kleiner Block, erledigt)

- Die Filterzusammenfassung wird zentral aus Gesamtzahl, sichtbarer Zahl, Suche und Status erzeugt und ist damit testbar.

## Sitzung 39 – Ungültige Outbox-Zeitstempel sicher behandeln (kleiner Block, erledigt)

- Die Sortierung verwendet echte Datumswerte statt Stringvergleich; ungültige Werte werden fail-closed nach hinten sortiert.

## Sitzung 40 – Filtersteuerung semantisch anbinden (kleiner Block, erledigt)

- `aria-controls="mission-list"` verbindet die Statusfilter mit dem tatsächlich gefilterten Bereich.

## Sitzung 41 – Kopierfeedback atomar ankündigen (kleiner Block, erledigt)

- Der Ergebnis-Kopierbutton meldet Zustandswechsel mit `aria-live="polite"` und `aria-atomic="true"`.
- Abschlussstand: `npm test` 138/138, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 42 – Unbekannte Missionsstatus sicher anzeigen (kleiner Block, erledigt)

- Die Runtime liefert für unbekannte Statuswerte die neutrale Anzeige `Unbekannt`.

## Sitzung 43 – Status-Badge gegen unbekannte CSS-Klassen absichern (kleiner Block, erledigt)

- Das Mission-Card-Badge verwendet für unbekannte Statuswerte eine sichere `unknown`-Klasse statt Backenddaten direkt als CSS-Suffix zu verwenden.

## Sitzung 44 – Suche mit Filterzusammenfassung verknüpfen (kleiner Block, erledigt)

- Das Suchfeld referenziert die dynamische Filterzusammenfassung über `aria-describedby`.

## Sitzung 45 – Outbox-Liste zugänglich benennen (kleiner Block, erledigt)

- Die Liste fertiger Missionsergebnisse besitzt jetzt die zugängliche Bezeichnung `Fertige Missionsergebnisse`.
- Abschlussstand: `npm test` 139/139, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 46 – Sichere Statusklassen zentralisieren (kleiner Block, erledigt)

- Die Runtime liefert nur bekannte Statusklassen oder `unknown`.

## Sitzung 47 – Missionstitel sicher darstellen (kleiner Block, erledigt)

- Leere oder nur aus Leerzeichen bestehende Titel werden in der Anzeige neutral als `Unbenannte Mission` dargestellt.

## Sitzung 48 – Ergebnisarten zentral beschriften (kleiner Block, erledigt)

- Die sichtbaren Ergebnisarten werden zentral aus der sicheren Ergebnisarten-Allowlist beschriftet.

## Sitzung 49 – Mission-Board-Bereich semantisch auszeichnen (kleiner Block, erledigt)

- Die Missionsliste ist als Region mit der Überschrift `Mission Board` verbunden.

## Sitzung 50 – Filteraktion zugänglich benennen (kleiner Block, erledigt)

- `Filter zurücksetzen` besitzt eine eindeutige zugängliche Beschriftung.

## Sitzung 51 – Missionsliste explizit referenzieren (kleiner Block, erledigt)

- Die Filtersteuerung referenziert weiterhin den semantisch benannten Missionsbereich.

## Sitzung 52 – Mission-Card-Status zentral verwenden (kleiner Block, erledigt)

- Mission Cards verwenden die zentrale Statusklassenfunktion statt eigener Inline-Allowlist.

## Sitzung 53 – Mission-Card-Titel zentral verwenden (kleiner Block, erledigt)

- Mission Cards und Outbox verwenden dieselbe sichere Titelanzeige.

## Sitzung 54 – Ergebnis-Badge zugänglich beschreiben (kleiner Block, erledigt)

- Ergebnis-Badges geben ihre Art zusätzlich als zugängliches Label aus.

## Sitzung 55 – Outbox-Einträge eindeutig benennen (kleiner Block, erledigt)

- Jeder Outbox-Eintrag erhält eine sprechende zugängliche Bezeichnung aus Missionstitel und Ergebnisart.
- Abschlussstand: `npm test` 140/140, `npm run build` erfolgreich, `git diff --check` sauber; Browserprüfung ohne JavaScript-Fehler.
- Bewusste Kostenbegrenzung: keine Peer-Runs, keine Veröffentlichung und keine zusätzliche Agentenlaufzeit.

## Sitzung 56 – Beschreibung zentral normalisieren (kleiner Block, erledigt)

- Leere oder ungültige Beschreibungen erhalten den neutralen Fallback `Keine Beschreibung hinterlegt.`.

## Sitzung 57 – Besitzeranzeige zentral normalisieren (kleiner Block, erledigt)

- Leere oder ungültige Besitzerwerte werden als `Nicht zugewiesen` angezeigt.

## Sitzung 58 – Mission Card und Outbox angleichen (kleiner Block, erledigt)

- Beschreibung und Besitzer greifen auf dieselben zentralen Anzeige-Helfer zurück.

## Sitzung 59 – Abschlussprüfung der Anzeige-Helfer (kleiner Block, erledigt)

- Fokustest, Volltest, Build, Diff-Prüfung und Browserprüfung erfolgreich abgeschlossen.
- Abschlussstand: `npm test` 140/140, Browser-Konsole ohne JavaScript-Fehler.

## Sitzung 60 – Release 0.2.0 veröffentlicht (erledigt)

- Versionsmetadaten, Installer und Dokumentation auf 0.2.0 synchronisiert.
- Debian-13-Installationstest, Tests, Lint, Build und Audit erfolgreich.
- Commit `0a263a7` und Tag `v0.2.0` veröffentlicht.
- GitHub-Release mit Bundle, Installer, `agentpc.json` und `SHA256SUMS` erstellt.
- GHCR-Multi-Architektur-Image für amd64 und arm64 veröffentlicht.

## Sitzung 9 – Veröffentlichung (noch nicht freigegeben)

- Dieser Block ist ausschließlich vorbereitet, aber noch nicht freigegeben.
- Repo öffentlich schalten, ersten Tag/Release anlegen und externe Verweise ergänzen (nur nach ausdrücklicher Rückfrage).
- Optional Docker-Image über GitHub Container Registry bereitstellen.
- Verweise in den READMEs von Bony's Agents und Bony's VPN ergänzen.
- Vor einer Veröffentlichung: finalen Release-Stand, Artefakte, Checksummen, Installationspfad und externe Release-Kommunikation manuell prüfen.
