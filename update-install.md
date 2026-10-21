# Mission Control aktualisieren

Diese Anleitung erklärt, was nach dem Kopieren des Update-Befehls aus Mission Control zu tun ist.

## Voraussetzungen

- Zugriff auf den Agent-PC, auf dem Mission Control installiert ist
- ein Benutzerkonto mit `sudo`-Berechtigung
- laufender Agent-PC mit Internetzugriff auf GitHub und GHCR
- Mission Control liegt standardmäßig unter `/opt/bonys-mission-control`

Das Webinterface führt das Update **nicht selbst** aus. Es zeigt nur einen geprüften Befehl an. Das eigentliche Update startet der Administrator bewusst im Terminal.

## 1. Befehl aus Mission Control kopieren

Öffne in Mission Control den Bereich **Updates** und klicke auf **Update-Befehl kopieren**.

Der Befehl sieht beispielsweise so aus:

```bash
sudo /opt/bonys-mission-control/scripts/update.sh --version 0.2.5
```

Die Versionsnummer ist nur ein Beispiel. Verwende genau die Version, die Mission Control anzeigt.

## 2. Terminal öffnen

Öffne auf demselben Agent-PC ein Terminal und füge den kopierten Befehl ein.

Beispiel:

```bash
sudo /opt/bonys-mission-control/scripts/update.sh --version 0.2.5
```

Bestätige die `sudo`-Abfrage und warte, bis das Skript mit `FERTIG` endet.

## 3. Was während des Updates passiert

Das Update-Skript:

1. lädt das angeforderte offizielle GitHub-Release,
2. prüft die Prüfsumme von `install.sh` über `SHA256SUMS`,
3. übernimmt die vorhandene Konfiguration,
4. behält die `.env` und die Docker-Daten bei,
5. lädt das passende GHCR-Image,
6. aktualisiert Container und systemd-Dienst,
7. wartet auf einen erfolgreichen Healthcheck.

Eigene Profile, Missionen, Ergebnisse und erzeugte Geheimnisse bleiben dabei erhalten.

## 4. Update prüfen

Nach erfolgreichem Abschluss kannst du den Healthcheck ausführen:

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

Die Antwort muss unter anderem die aktualisierte Version enthalten, zum Beispiel:

```json
{"ok":true,"version":"0.2.5"}
```

Danach kannst du Mission Control wieder im Browser öffnen:

```text
http://127.0.0.1:8787/
```

## Alternative: neueste Version installieren

Wenn bewusst immer das neueste veröffentlichte Release verwendet werden soll:

```bash
sudo /opt/bonys-mission-control/scripts/update.sh --version latest
```

Für reproduzierbare Updates ist eine feste Versionsnummer vorzuziehen.

## Lokales Release-Bundle

Wenn kein Download aus dem Internet möglich ist, kann ein geprüftes Bundle verwendet werden:

```bash
sudo /opt/bonys-mission-control/scripts/update.sh \
  --version 0.2.5 \
  --bundle /pfad/bonys-mission-control-0.2.5.tar.gz
```

Das Bundle muss zur angegebenen Version gehören. Wenn daneben eine `SHA256SUMS`-Datei liegt, wird sie ebenfalls geprüft.

## Wenn das Update fehlschlägt

Zuerst die letzten Dienstmeldungen ansehen:

```bash
sudo systemctl status bonys-mission-control.service --no-pager
sudo docker compose \
  --project-directory /opt/bonys-mission-control \
  --env-file /opt/bonys-mission-control/.env \
  -f /opt/bonys-mission-control/deploy/compose.yaml logs --tail=100
```

Danach den Healthcheck erneut prüfen:

```bash
curl -fsS http://127.0.0.1:8787/api/health
```

Wenn das Update nicht erfolgreich abgeschlossen wurde, keine Daten löschen und insbesondere **nicht** `uninstall.sh --purge` verwenden. Dieser Schalter löscht das Daten-Volume und damit die gespeicherten Missionen und Profile.

## Wichtige Hinweise

- Den Befehl nur auf dem Agent-PC ausführen, auf dem Mission Control installiert ist.
- Die Versionsnummer nicht eigenmächtig verändern.
- `sudo` ist nur für den lokalen Update-Befehl erforderlich.
- Mission Control startet keine Root-Kommandos aus dem Browser.
- Bei produktiven Systemen feste Release-Versionen verwenden und den Healthcheck abwarten.
