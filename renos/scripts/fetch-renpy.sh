#!/usr/bin/env bash
# Lädt ein offizielles Ren'Py-SDK samt Web-Paket von renpy.org und entpackt nur, was RenOS braucht:
# renpy.py, renpy/ (Engine), LICENSE.txt, the_question/ (Beispielspiel für Tests) und web/ (Web-Laufzeit).
# Aus dem SDK wird nichts ausgeführt.
#
#   scripts/fetch-renpy.sh <version> <zielordner>    → <zielordner>/renpy-<version>-sdk/
set -euo pipefail
version="${1:?Version fehlt, z. B. 8.6.0}"
target="${2:?Zielordner fehlt}"
sdk="renpy-${version}-sdk"
mkdir -p "$target"
cd "$target"
if [ -f "$sdk/renpy.py" ] && [ -f "$sdk/web/index.html" ]; then
  echo "Ren'Py ${version}: bereits vorhanden"
  exit 0
fi
curl -fsSL --retry 3 -o sdk.tar.bz2 "https://www.renpy.org/dl/${version}/renpy-${version}-sdk.tar.bz2"
curl -fsSL --retry 3 -o web.zip "https://www.renpy.org/dl/${version}/renpy-${version}-web.zip"
tar -xjf sdk.tar.bz2 "$sdk/renpy.py" "$sdk/renpy" "$sdk/LICENSE.txt" "$sdk/the_question"
unzip -q -o web.zip -d "$sdk"
rm -f sdk.tar.bz2 web.zip
echo "Ren'Py ${version}: $(du -sh "$sdk" | cut -f1)"
