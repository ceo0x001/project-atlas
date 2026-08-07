#!/usr/bin/env bash
#
# Generates the Flutter platform scaffolding for the Android client.
#
# `flutter create` in-place can overwrite hand-written sources, so this generates
# into a temporary project and copies only the platform directories across. Our
# lib/ and test/ are never touched.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mobile_dir="$repo_root/apps/mobile"

if ! command -v flutter >/dev/null 2>&1; then
  cat >&2 <<'MSG'
error: flutter is not installed.

  brew install --cask flutter
  brew install --cask temurin      # JDK, required for Android builds

Then run this script again.
MSG
  exit 1
fi

if ! command -v java >/dev/null 2>&1; then
  echo "warning: no JDK found. Android builds will fail until you install one:" >&2
  echo "  brew install --cask temurin" >&2
fi

echo "==> Flutter version"
flutter --version

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

echo "==> Generating Android platform scaffolding"
flutter create \
  --project-name atlas \
  --org app.atlas \
  --platforms=android \
  --description "Atlas — AI Financial Operating System" \
  "$staging/atlas" >/dev/null

if [ -d "$mobile_dir/android" ]; then
  echo "==> apps/mobile/android already exists; leaving it untouched"
else
  cp -R "$staging/atlas/android" "$mobile_dir/android"
  echo "==> Copied android/ into apps/mobile"
fi

echo "==> Resolving dependencies"
cd "$mobile_dir"
flutter pub get

cat <<'MSG'

Done. Verify with:

  cd apps/mobile
  flutter analyze
  flutter test

Note: SMS ingestion needs a physical Android device (ADR-006 Amendment 1) —
the emulator cannot receive real bank alerts.
MSG
