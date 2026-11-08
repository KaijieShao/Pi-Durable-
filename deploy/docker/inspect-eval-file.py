#!/usr/bin/env python3
"""Trusted host observer: pinned directory FDs; no symlink traversal, special-file opens, or app-reported contents."""
import base64
import errno
import json
import os
import stat
import sys


class Refused(Exception):
    def __init__(self, kind):
        self.kind = kind


def child_open(name, flags, directory):
    try:
        return os.open(name, flags, dir_fd=directory)
    except OSError as error:
        if error.errno == errno.ENOENT:
            raise Refused('missing') from None
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise Refused('unsafe') from None
        raise


def inspect(root, relative):
    parts = relative.split('/')
    if not parts or any(p in ('', '.', '..') for p in parts) or '\0' in relative:
        raise Refused('unsafe')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(root, flags)
    try:
        for part in parts[:-1]:
            next_directory = child_open(part, flags, directory)
            os.close(directory)
            directory = next_directory
        file = child_open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, directory)
        try:
            if not stat.S_ISREG(os.fstat(file).st_mode):
                raise Refused('not_regular')
            maximum = 4 * 1024 * 1024
            chunks = []
            total = 0
            while total <= maximum:
                data = os.read(file, min(65536, maximum + 1 - total))
                if not data:
                    return {'ok': True, 'data': base64.b64encode(b''.join(chunks)).decode('ascii')}
                chunks.append(data)
                total += len(data)
            raise ValueError('file evidence exceeds limit')
        finally:
            os.close(file)
    finally:
        os.close(directory)


try:
    result = inspect(sys.argv[1], sys.argv[2])
except Refused as refusal:
    result = {'ok': False, 'kind': refusal.kind}
except Exception:
    result = {'ok': False, 'kind': 'infrastructure'}
sys.stdout.write(json.dumps(result) + '\n')
