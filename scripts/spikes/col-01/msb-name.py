#!/usr/bin/env python3
"""Only change disposable VM names; execute the unmodified backend adapter.

The real adapter derives smthrs-ws-* names. This spike maps those names to
spike-col01-* so other lanes can recognize them. No per-frame invocation.
"""
import json
import os
import subprocess
import sys

real = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "msb-real"))
args = [a.replace("smthrs-ws-", "spike-col01-", 1)
        if a.startswith("smthrs-ws-") else a for a in sys.argv[1:]]
if args and args[0] == "list":
    result = subprocess.run([real, *args], stdout=subprocess.PIPE)
    if result.returncode == 0 and "json" in args:
        rows = json.loads(result.stdout)
        for row in rows:
            name = row.get("name", "")
            if name.startswith("spike-col01-"):
                row["name"] = name.replace("spike-col01-", "smthrs-ws-", 1)
        sys.stdout.write(json.dumps(rows))
    else:
        sys.stdout.buffer.write(result.stdout)
    sys.exit(result.returncode)
os.execv(real, [real, *args])
