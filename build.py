#!/usr/bin/env python3
"""Builds the release ZIP for YouTrack / JetBrains Marketplace.

The source keeps a preview mode with sample data (open widgets/planner/index.html outside YouTrack).
The release build removes everything between /* @preview-start */ and /* @preview-end */ in app.js.
Usage: python3 build.py  ->  dist/  and  post-grid-planner.zip
"""
import pathlib, re, shutil, sys, zipfile

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / 'dist'
OUT = ROOT / 'post-grid-planner.zip'
FILES = ['manifest.json', 'icon.png', 'README.md',
         'widgets/planner/index.html', 'widgets/planner/app.css', 'widgets/planner/app.js', 'widgets/planner/icon.svg',
         'widgets/setup/index.html', 'widgets/setup/setup.css', 'widgets/setup/setup.js', 'widgets/setup/icon.svg']
MOCKS = {'widgets/planner/app.js': 'createMockHost', 'widgets/setup/setup.js': 'createSetupMock'}

shutil.rmtree(DIST, ignore_errors=True)
for f in FILES:
    (DIST / f).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / f, DIST / f)

for rel_path, mock in MOCKS.items():
    js = DIST / rel_path
    src = js.read_text()
    rel, n = re.subn(r'[ \t]*/\* @preview-start.*?/\* @preview-end \*/\n?', '', src, flags=re.S)
    if n < 1:
        sys.exit(f'{rel_path}: preview markers not found')
    check = rel.replace(f"typeof {mock} === 'function' ? {mock}() : null", '')
    for bad in (f'{mock}(', '__attach(', 'Preview mode', '__setupCalls'):
        if bad in check:
            sys.exit(f'{rel_path}: release build still contains {bad}')
    js.write_text(rel)
    print(f'{rel_path}: {len(src)//1024} KB -> {len(rel)//1024} KB')

OUT.unlink(missing_ok=True)
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(DIST / f, f)
print(f'{OUT}  ({OUT.stat().st_size // 1024} KB)')
