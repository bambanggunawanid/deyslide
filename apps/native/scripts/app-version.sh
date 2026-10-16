#!/usr/bin/env bash
# Picks the app version for a release build and writes it to $GITHUB_OUTPUT:
# - version: the tag without its "v" (v1.2.3 gives 1.2.3). A run by hand
#   from a branch gets 0.0.<run number>: Android refuses 0.0.0.
# - config: a Tauri config file that sets that version, for `tauri build --config`.
#   A file, not inline JSON, so no shell on Windows mangles the quotes.
# - msi: whether Windows Installer takes the version, by the rules of
#   tauri-bundler: major and minor at most 255, patch at most 65535, and a
#   build number or pre-release that is a number up to 65535. So
#   1.2.3-beta.1 gets the NSIS installer alone.
# A tag that is not a semantic version stops here, before any build starts.
set -euo pipefail

if [ "${GITHUB_REF_TYPE:-}" = tag ]; then
  version="${GITHUB_REF_NAME#v}"
else
  version="0.0.${GITHUB_RUN_NUMBER:-1}"
fi

# https://semver.org, in the extended regular expressions bash understands.
number='(0|[1-9][0-9]*)'
identifier='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
semver="^${number}\.${number}\.${number}(-${identifier}(\.${identifier})*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$"
if ! [[ "$version" =~ $semver ]]; then
  echo "The version \"$version\" is not a semantic version such as 1.2.3. Tag releases like v1.2.3." >&2
  exit 1
fi
if [ "$version" = 0.0.0 ]; then
  echo "The version 0.0.0 cannot be released: Android needs at least 0.0.1." >&2
  exit 1
fi

config="${RUNNER_TEMP:-/tmp}/deyslide-version.json"
printf '{"version":"%s"}\n' "$version" > "$config"

# Whether $1 is a number from 0 to $2.
at_most() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$1))" -le "$2" ]
}

core="${version%%[-+]*}"
IFS=. read -r major minor patch <<< "$core"
build=
if [[ "$version" == *+* ]]; then build="${version#*+}"; fi
pre="${version%%+*}"
if [[ "$pre" == *-* ]]; then pre="${pre#*-}"; else pre=; fi

msi=true
if ! at_most "$major" 255 || ! at_most "$minor" 255 || ! at_most "$patch" 65535; then
  msi=false
elif [ -n "$build" ]; then
  # Windows Installer uses the build number and ignores any pre-release.
  at_most "$build" 65535 || msi=false
elif [ -n "$pre" ]; then
  at_most "$pre" 65535 || msi=false
fi

echo "Version $version (MSI: $msi)"
{
  echo "version=$version"
  echo "config=$config"
  echo "msi=$msi"
} >> "${GITHUB_OUTPUT:-/dev/stdout}"
