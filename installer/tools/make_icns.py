"""Packs PNG files into a macOS .icns icon (modern icns holds PNG images as they are).

Usage: python -I make_icns.py <out.icns> <png-128> <png-256> <png-512> <png-1024>
"""

import struct
import sys

# icns types for PNG images of 128, 256, 512 and 1024 px.
TYPES = [b"ic07", b"ic08", b"ic09", b"ic10"]


def main(out, *pngs):
    chunks = b""
    for kind, png in zip(TYPES, pngs):
        with open(png, "rb") as handle:
            data = handle.read()
        chunks += kind + struct.pack(">I", len(data) + 8) + data
    with open(out, "wb") as handle:
        handle.write(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)


if __name__ == "__main__":
    if len(sys.argv) != 6:
        sys.exit(__doc__)
    main(*sys.argv[1:])
