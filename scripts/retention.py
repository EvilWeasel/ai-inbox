#!/usr/bin/env python3
"""Retain every code version referenced by a retained data snapshot."""
import pathlib
import shutil
import sys


def retain(root, release_keep, backup_keep, previous):
    root = pathlib.Path(root).resolve()
    releases_root = root / 'releases'
    protected = {(root / 'current').resolve()}
    if previous:
        protected.add(pathlib.Path(previous).resolve())
    backups = sorted(
        (p for p in (root / 'backups').iterdir()
         if p.is_dir() and not p.is_symlink() and (p / 'previous-release').is_file()),
        key=lambda p: p.stat().st_mtime, reverse=True)
    for p in backups[backup_keep:]:
        shutil.rmtree(p)
    for p in backups[:backup_keep]:
        reference = (p / 'previous-release').read_text().strip()
        if reference:
            referenced = pathlib.Path(reference).resolve()
            if referenced.parent == releases_root and len(referenced.name) == 40:
                protected.add(referenced)
    releases = sorted(
        (p for p in releases_root.iterdir()
         if p.is_dir() and not p.is_symlink() and len(p.name) == 40
         and all(c in '0123456789abcdef' for c in p.name)),
        key=lambda p: p.stat().st_mtime, reverse=True)
    for p in releases[release_keep:]:
        if p.resolve() not in protected:
            shutil.rmtree(p)


if __name__ == '__main__':
    retain(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4])
