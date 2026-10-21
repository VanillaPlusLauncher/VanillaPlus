"""Signs Amethyx.app inside the macOS zip ad hoc with rcodesign, without a Mac.

mac_bundle.py changes the app's own Info.plist and resources, which breaks the signature Electron
came with: macOS then calls the app "damaged" and only a Terminal command opens it. Signed ad hoc
(no Apple certificate), the app is merely "from an unidentified developer", and System Settings →
Privacy & Security → "Open Anyway" opens it.

Everything is signed, nested frameworks and helper apps first (Electron ships them with linker
signatures only, which seal no resources). Windows cannot make the symbolic links inside the
frameworks, so the zip is unpacked with each link replaced by a copy of its target, signed there,
and the zip is rewritten taking only the files signing changed or added outside those copies; every
other entry, links included, stays exactly as it was.

Usage: python -I mac_sign.py <rcodesign.exe> <Amethyx-…-mac-….zip> <work folder>
"""

import os
import shutil
import stat
import subprocess
import sys
import zipfile

APP = "Amethyx.app"


def is_link(info):
    return stat.S_ISLNK(info.external_attr >> 16)


def copy_links(done):
    """Makes each link's copy again from what it points to (after signing changed the originals)."""
    for place, pointed in done:
        if os.path.isdir(place):
            shutil.rmtree(place)
        elif os.path.exists(place):
            os.remove(place)
        if os.path.isdir(pointed):
            shutil.copytree(pointed, place)
        else:
            shutil.copyfile(pointed, place)


def unpack(source, work):
    """
    Unpacks the zip into `work`; symbolic links become copies of what they point to. Returns the
    links' names and [(copy, original)] in the order they were made.
    """
    links = []
    done = []
    names = [info.filename.rstrip("/") for info in source.infolist() if is_link(info)]
    for info in source.infolist():
        if is_link(info):
            links.append(info)
            continue
        target = os.path.join(work, *info.filename.rstrip("/").split("/"))
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(source.read(info))
    # A link may point through another link ("Resources" -> "Versions/Current/Resources"): rounds
    # until nothing is left to resolve.
    while links:
        left = []
        for info in links:
            name = info.filename.rstrip("/")
            place = os.path.join(work, *name.split("/"))
            pointed = os.path.normpath(os.path.join(os.path.dirname(place), source.read(info).decode("utf-8")))
            if not os.path.exists(pointed):
                left.append(info)
                continue
            copy_links([(place, pointed)])
            done.append((place, pointed))
        if len(left) == len(links):
            raise SystemExit("unresolved links: " + ", ".join(info.filename for info in left))
        links = left
    return names, done


def sign(rcodesign, *arguments):
    result = subprocess.run([rcodesign, "sign", *arguments], capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit("rcodesign failed")


def main(rcodesign, zip_path, work):
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    with zipfile.ZipFile(zip_path) as source:
        links, done = unpack(source, work)
        inside_link = lambda name: any(name == link or name.startswith(link + "/") for link in links)
        app = os.path.join(work, APP)
        # Nested frameworks and helper apps first; then the copies standing for the links are made
        # again from the signed files, so the app's own seal reads the new signatures through them.
        frameworks = os.path.join(app, "Contents", "Frameworks")
        for name in sorted(os.listdir(frameworks)):
            if name.endswith((".framework", ".app")):
                sign(rcodesign, os.path.join(frameworks, name))
        copy_links(done)
        sign(rcodesign, "--shallow", app)
        signed = zip_path + ".signed"
        known = set()
        changed = 0
        with zipfile.ZipFile(signed, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as target:
            for info in source.infolist():
                known.add(info.filename.rstrip("/"))
                data = source.read(info)
                if not is_link(info) and not info.is_dir():
                    path = os.path.join(work, *info.filename.split("/"))
                    with open(path, "rb") as handle:
                        fresh = handle.read()
                    if fresh != data:
                        data = fresh
                        changed += 1
                target.writestr(info, data)
            # Files signing added: the _CodeSignature/CodeResources of each bundle (not in the link copies).
            for folder, _, files in os.walk(app):
                for file in files:
                    path = os.path.join(folder, file)
                    name = os.path.relpath(path, work).replace(os.sep, "/")
                    if name in known or inside_link(name):
                        continue
                    info = zipfile.ZipInfo(name, date_time=source.infolist()[0].date_time)
                    info.create_system = 3
                    info.external_attr = 0o100644 << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with open(path, "rb") as handle:
                        target.writestr(info, handle.read())
                    changed += 1
    os.replace(signed, zip_path)
    shutil.rmtree(work, ignore_errors=True)
    print(f"signed ad hoc: {changed} files changed")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
