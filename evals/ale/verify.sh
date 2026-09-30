#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 -m unittest discover -s "$here/fixtures" -p check_gate.py
python3 - "$here" <<'PY'
import ast
from pathlib import Path
import sys
for path in Path(sys.argv[1]).rglob("*.py"):
    ast.parse(path.read_text(), filename=str(path))
PY
