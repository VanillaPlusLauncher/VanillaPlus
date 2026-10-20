"""Makes Amethyx.app for macOS from Electron's macOS zip, without a Mac.

The zip is rewritten entry by entry instead of being unpacked: Electron.app holds symbolic links
and executable files, and Windows would lose both on the way. Every entry keeps its own Unix
attributes; only these change:
  Electron.app/                          -> Amethyx.app/
  Contents/Info.plist (the app's own)    -> name, bundle id and version of Amethyx
  Contents/Resources/electron.icns       -> the Amethyx icon
  Contents/Resources/default_app.asar    -> removed; Contents/Resources/app.asar is added
Files next to the app in Electron's zip (licenses, version) are left out.

Usage: python -I mac_bundle.py <electron-darwin.zip> <app.asar> <icon.icns> <version> <out.zip>
"""

import plistlib
import sys
import time
import zipfile

OLD = "Electron.app/"
NEW = "Amethyx.app/"
BUNDLE_ID = "com.amethyx.launcher"


def new_entry(name, mode=0o100644):
    info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
    info.create_system = 3  # Unix: the attributes below are read on macOS
    info.external_attr = mode << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    return info


def main(electron_zip, asar, icns, version, out):
    with zipfile.ZipFile(electron_zip) as source, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as target:
        for info in source.infolist():
            if not info.filename.startswith(OLD):
                continue
            name = NEW + info.filename[len(OLD):]
            inner = info.filename[len(OLD):]
            if inner == "Contents/Resources/default_app.asar":
                continue
            data = source.read(info)
            if inner == "Contents/Info.plist":
                plist = plistlib.loads(data)
                plist["CFBundleName"] = "Amethyx"
                plist["CFBundleDisplayName"] = "Amethyx Launcher"
                plist["CFBundleIdentifier"] = BUNDLE_ID
                plist["CFBundleShortVersionString"] = version
                plist["CFBundleVersion"] = version
                plist["NSHumanReadableCopyright"] = "GPL-3.0"
                data = plistlib.dumps(plist)
            elif inner == "Contents/Resources/electron.icns":
                with open(icns, "rb") as handle:
                    data = handle.read()
            copy = zipfile.ZipInfo(name, date_time=info.date_time)
            copy.create_system = info.create_system
            copy.external_attr = info.external_attr
            copy.compress_type = info.compress_type
            target.writestr(copy, data)
        with open(asar, "rb") as handle:
            target.writestr(new_entry(NEW + "Contents/Resources/app.asar"), handle.read())


if __name__ == "__main__":
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    main(*sys.argv[1:])
