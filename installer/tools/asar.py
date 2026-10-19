"""Minimal asar extract/pack. Usage: asar.py extract <archive> <dir> | pack <dir> <archive> [<orig-archive-for-unpacked-list>]"""
import sys, os, json, struct, hashlib

BLOCK = 4 * 1024 * 1024


def read_header(path):
    with open(path, 'rb') as f:
        head = f.read(16)
        _, header_size, _, json_len = struct.unpack('<IIII', head)
        hjson = f.read(json_len).decode('utf-8')
    return json.loads(hjson), 8 + header_size


def extract(archive, out):
    header, base = read_header(archive)
    data = open(archive, 'rb')
    count = 0

    def walk(node, rel):
        nonlocal count
        for name, entry in node['files'].items():
            p = os.path.join(rel, name)
            if 'files' in entry:
                os.makedirs(os.path.join(out, p), exist_ok=True)
                walk(entry, p)
            elif 'link' in entry:
                continue
            else:
                dst = os.path.join(out, p)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if entry.get('unpacked'):
                    src = os.path.join(archive + '.unpacked', p)
                    if os.path.exists(src):
                        open(dst, 'wb').write(open(src, 'rb').read())
                    continue
                data.seek(base + int(entry['offset']))
                open(dst, 'wb').write(data.read(entry['size']))
                count += 1

    walk(header, '')
    print('extracted', count, 'files')


def integrity(buf):
    blocks = [hashlib.sha256(buf[i:i + BLOCK]).hexdigest() for i in range(0, max(len(buf), 1), BLOCK)]
    return {'algorithm': 'SHA256', 'hash': hashlib.sha256(buf).hexdigest(), 'blockSize': BLOCK, 'blocks': blocks}


def pack(src, archive):
    chunks = []
    offset = 0

    def build(d):
        nonlocal offset
        node = {'files': {}}
        for name in sorted(os.listdir(d)):
            p = os.path.join(d, name)
            if os.path.isdir(p):
                node['files'][name] = build(p)
            else:
                buf = open(p, 'rb').read()
                node['files'][name] = {'size': len(buf), 'offset': str(offset), 'integrity': integrity(buf)}
                chunks.append(buf)
                offset += len(buf)
        return node

    header = build(src)
    hjson = json.dumps(header, separators=(',', ':')).encode('utf-8')
    json_len = len(hjson)
    padded = (json_len + 3) & ~3
    payload = struct.pack('<I', json_len) + hjson + b'\0' * (padded - json_len)
    pickle = struct.pack('<I', len(payload)) + payload
    with open(archive, 'wb') as f:
        f.write(struct.pack('<II', 4, len(pickle)))
        f.write(pickle)
        for c in chunks:
            f.write(c)
    # Electron's header hash covers the raw JSON string
    print('header sha256', hashlib.sha256(hjson).hexdigest())


if __name__ == '__main__':
    if sys.argv[1] == 'extract':
        extract(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == 'header':
        h, _ = read_header(sys.argv[2])
        with open(sys.argv[2], 'rb') as f:
            f.seek(12); n = struct.unpack('<I', f.read(4))[0]; raw = f.read(n)
        print('header sha256', hashlib.sha256(raw).hexdigest())
    else:
        pack(sys.argv[2], sys.argv[3])
