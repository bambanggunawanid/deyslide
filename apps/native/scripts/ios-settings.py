#!/usr/bin/env python3
"""Applies Deyslide's settings to the Info.plist of the generated Xcode project.

    python3 ios-settings.py apps/native/src-tauri/gen/apple/<name>_iOS/Info.plist

`tauri ios init` writes the project from Tauri's template, so the release
workflow runs this after it, and again on a committed project, which keeps
the settings in one place:

- The app's own link scheme, through which the browser hands a sign in back
  (id.bambanggunawan.deyslide:/oauth/callback, as on Android).
- The name under the icon.
- No encryption beyond what iOS itself provides (HTTPS), which answers App
  Store Connect's export question for every TestFlight build.
- Every orientation on an iPad and the three usual ones on an iPhone, so a
  deck presents in landscape.

Running it twice changes nothing more. Other entries are kept.
"""

import plistlib
import sys

SCHEME = "id.bambanggunawan.deyslide"

PHONE_ORIENTATIONS = [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
]

TABLET_ORIENTATIONS = [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
]


def apply_settings(info):
    """Returns `info` with Deyslide's settings in it."""
    url_types = [
        entry
        for entry in info.get("CFBundleURLTypes", [])
        if SCHEME not in entry.get("CFBundleURLSchemes", [])
    ]
    url_types.append({"CFBundleURLName": SCHEME, "CFBundleURLSchemes": [SCHEME]})
    info["CFBundleURLTypes"] = url_types
    info["CFBundleDisplayName"] = "Deyslide"
    info["ITSAppUsesNonExemptEncryption"] = False
    info["UISupportedInterfaceOrientations"] = PHONE_ORIENTATIONS
    info["UISupportedInterfaceOrientations~ipad"] = TABLET_ORIENTATIONS
    return info


def main(args):
    if len(args) != 1:
        print("Usage: python3 ios-settings.py <Info.plist>", file=sys.stderr)
        return 2
    path = args[0]
    with open(path, "rb") as file:
        info = plistlib.load(file)
    with open(path, "wb") as file:
        plistlib.dump(apply_settings(info), file)
    print(f"Applied the Deyslide settings to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
