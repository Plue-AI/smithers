"""Build-user-only archive writer; normalizes metadata without extracting input tar files."""
import gzip
import os
import sys
import tarfile

source, destination, kind = sys.argv[1:]


def add(output, info, data=None):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ''
    info.pax_headers = {}
    output.addfile(info, data)


with open(destination, 'wb') as raw:
    if kind == 'tar':
        with tarfile.open(source, 'r:') as original, tarfile.open(fileobj=raw, mode='w|', format=tarfile.PAX_FORMAT) as output:
            for info in sorted(original.getmembers(), key=lambda member: member.name):
                data = original.extractfile(info) if info.isfile() else None
                try:
                    add(output, info, data)
                finally:
                    if data:
                        data.close()
    else:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=1) as compressed, tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as output:
            paths = []
            for directory, dirs, files in os.walk(source):
                paths.extend(os.path.join(directory, name) for name in files + [d for d in dirs if os.path.islink(os.path.join(directory, d))])
            for path in sorted(paths, key=lambda path: os.path.relpath(path, source)):
                info = output.gettarinfo(path, os.path.relpath(path, source))
                if info.isfile():
                    with open(path, 'rb') as data:
                        add(output, info, data)
                else:
                    add(output, info)
