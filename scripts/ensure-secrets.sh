#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Legt .env an bzw. ergänzt sie und erzeugt fehlende Geheimnisse ("__GENERATE__") zufällig.
# Läuft bei jedem Start der systemd-Unit (ExecStartPre) – so bekommt ein aus einer Vorlage
# geklonter Agent-PC nach reset-secrets.sh beim ersten Start eigene Geheimnisse.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
require_root
ensure_env
