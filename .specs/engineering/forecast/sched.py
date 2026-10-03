"""Monte Carlo list scheduler for the stage-1 (J1 + J2) critical path.

python3 s1sched.py params.json
params.json: {
  "start": "2026-10-02T17:00",            # local time work starts
  "lanes": 12,                              # concurrent code lanes
  "design_lanes": 1,                        # concurrent T-UI lanes (design)
  "hours": {"S": [p50, p90], "M": [p50, p90], "L": [p50, p90]},   # claim→landed lane-hours
  "yield": 0.7,                             # first-pass yield
  "rework": [p50, p90],                     # extra hours per rework round
  "done": ["T-..."],                        # already landed
  "remaining": {"T-STK-01": 3.0},           # in-progress tickets: remaining hours (p50)
  "cuts": {"T-INS-08": 0.4},                # fraction of a ticket removed by a minimal version
  "drop_edges": [["T-STK-02","T-STK-06"]],  # dependency edges removed (dependent, dependency)
  "runs": 4000
}
Prints P50/P90 finish times and the most frequent critical chain.
"""
import json, math, os, random, re, sys
from collections import Counter
from datetime import datetime, timedelta

# The spec tree this script lives in (forecast/ sits inside .specs/engineering/).
E = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = json.load(open(sys.argv[1]))
idx = open(f"{E}/tickets/README.md").read()
cidx = open(f"{E}/checks/README.md").read()
T = {}
for m in re.finditer(r"^\| \[(T-[A-Z]+-\d+[a-z]?)\]\(\1\.md\) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$", idx, re.M):
    t, ti, st, sz, dp, ch = m.groups()
    # A staged Depends ("S1: a · S2: b") names the deps each stage of the ticket needs. A stage-1
    # forecast (scope != all) keeps only the segments for W0/S1 and unlabeled ones.
    keep = []
    for seg in dp.split("·"):
        lab = re.match(r"\s*(W0|S\d|R|M)\s*:", seg)
        if P.get("scope") == "all" or not lab or lab.group(1) in ("W0", "S1"):
            keep.append(seg)
    T[t] = dict(stage=st.split(",")[0].strip(), size=sz.strip(), deps=set(re.findall(r"T-[A-Z]+-\d+[a-z]?", " ".join(keep))))
C = {}
for m in re.finditer(r"^\| \[(C-[A-Z0-9]+-\d+)\]\(\1\.md\) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$", cidx, re.M):
    c, pr, ly, st, tx = m.groups()
    C[c] = re.findall(r"T-[A-Z]+-\d+[a-z]?", tx)
for dep, on in P.get("drop_edges", []):
    T[dep]["deps"].discard(on)
if P.get("scope") == "all":
    roots = {t for t in T if T[t]["stage"] in ("W0", "S1", "S2", "S3", "R")}
else:
    # s1_checks narrows stage 1 to named J1/J2 checks (what-if for product's step cuts); s1_check_tickets
    # overrides one check's ticket list (e.g. C-J1-04 trimmed to the day-1 path).
    over = P.get("s1_check_tickets", {})
    chosen = P.get("s1_checks") or [c for c in C if re.match(r"C-J[12]-\d+$", c)]
    roots = {t for c in chosen for t in over.get(c, C.get(c, [])) if T.get(t, {}).get("stage") in ("W0", "S1")}
need, st = set(), list(roots)
while st:
    u = st.pop()
    if u in need or u not in T:
        continue
    need.add(u)
    st.extend(T[u]["deps"])
done = set(P.get("done", []))
work = [t for t in need if t not in done]


def lognorm(p50, p90):
    mu = math.log(p50)
    sigma = max(1e-6, (math.log(p90) - mu) / 1.2816)
    return lambda: random.lognormvariate(mu, sigma)


H = {k: lognorm(*v) for k, v in P["hours"].items()}
RW = lognorm(*P["rework"])
INTEG = lognorm(*P["integration"]) if "integration" in P else None
READY = lognorm(*P["ready_delay"]) if "ready_delay" in P else None
REV = lognorm(*P["review_hours"]) if "review_hours" in P else None
FIX = lognorm(*P["fix_hours"]) if "fix_hours" in P else None


CI = lognorm(*P["ci_hours"]) if "ci_hours" in P else (lambda: 0.0)


def duration(t):
    if t in P.get("remaining", {}):
        base = P["remaining"][t] * random.lognormvariate(0, 0.35)
    elif t in P.get("inflight", {}):
        # censored: full duration conditioned on exceeding the elapsed hours
        el = P["inflight"][t]
        for _ in range(200):
            full = H.get(T[t]["size"], H["M"])()
            if full > el:
                break
        else:
            full = el * 1.5
        base = full - el
    else:
        base = H.get(T[t]["size"], H["M"])() * (1 - P.get("cuts", {}).get(t, 0))
        if "ready_delay" in P:
            base += READY()
    while random.random() > P["yield"]:
        base += RW()
    return base + CI()


# priority: longest remaining path (by size p50)
w = {k: v[0] for k, v in P["hours"].items()}
succ = {t: [u for u in work if t in T[u]["deps"]] for t in work}
memo = {}


def tail(t):
    if t not in memo:
        memo[t] = w.get(T[t]["size"], w["M"]) + max([tail(s) for s in succ[t]] or [0])
    return memo[t]


def sim():
    dur = {t: duration(t) for t in work}
    fin, start = {}, {}
    code = [0.0] * P["lanes"] + [float(o) for o, n in P.get("extra_lanes", []) for _ in range(n)]
    free = {"code": code, "design": [float(P.get("design_start_h", 0))] * P.get("design_lanes", 1)}
    remaining = set(work)
    s1_done = None
    s1set = set(P.get("_s1set", []))
    rev = [0.0] * P.get("review_lanes", 1)
    clock_ready = {}
    while remaining:
        ready = [t for t in remaining if all(d in fin or d in done or d not in need for d in T[t]["deps"])]
        ready.sort(key=lambda t: -tail(t))
        t = ready[0]
        pool = "design" if t.startswith("T-UI-") else "code"
        # M-37 (revised 2026-10-02): after stage 1 every ticket runs as a TODO on the install unless it is a
        # named exception (owner, reason, expiry recorded on the ticket), listed here in post_exceptions.
        if "post_lanes" in P and s1_done is not None and pool == "code" and t not in P.get("post_exceptions", []):
            pool = "post"
        er = max([fin.get(d, 0.0) for d in T[t]["deps"] if d in need and d not in done] or [0.0])
        lane = min(range(len(free[pool])), key=lambda i: max(free[pool][i], er))
        s = max(free[pool][lane], er)
        work_end = s + dur[t]
        free[pool][lane] = work_end
        if "review_lanes" in P:
            rounds = 1
            yv = P["review_yield"]
            for until, yy in P.get("review_yield_schedule", []):
                if work_end < until:
                    yv = yy
                    break
            while random.random() > yv:
                rounds += 1
            r_end = work_end
            for k in range(rounds):
                rl = min(range(len(rev)), key=lambda i: max(rev[i], r_end))
                rs = max(rev[rl], r_end)
                rv = REV()
                rev[rl] = rs + rv
                r_end = rs + rv + (FIX() if k < rounds - 1 else 0.0)
            work_end = r_end
        start[t], fin[t] = s, work_end
        remaining.discard(t)
        if "post_lanes" in P and s1_done is None and s1set and s1set <= set(fin) | done:
            s1_done = max(fin[x] for x in s1set if x in fin) + (INTEG() if INTEG else 0.0)
            free["post"] = [s1_done] * P["post_lanes"]
    end = (max(fin.values()) if fin else 0.0) + (P.get("final_stage_h", 0.0)) + (INTEG() if INTEG and "post_lanes" not in P else 0.0)
    # critical chain: walk back from the last finisher through the latest-finishing dep
    t = max(fin, key=fin.get)
    chain = [t]
    while True:
        ds = [d for d in T[t]["deps"] if d in fin]
        if not ds:
            break
        t = max(ds, key=fin.get)
        if fin[t] < start[chain[-1]] - 1e-9 and fin[t] < start[chain[-1]] - 6:
            break
        chain.append(t)
    return end, tuple(reversed(chain))


random.seed(7)
res = [sim() for _ in range(P.get("runs", 4000))]
ends = sorted(r[0] for r in res)
t0 = datetime.fromisoformat(P["start"])
p = lambda q: ends[min(len(ends) - 1, int(q * len(ends)))]
print(f"tickets in J1/J2 closure: {len(need)}; done: {len(done & need)}; to do: {len(work)}")
for q in (0.5, 0.9):
    print(f"P{int(q*100)}: {p(q):.0f} wall-hours -> {(t0 + timedelta(hours=p(q))).strftime('%a %b %d %H:%M')}")
chain, n = Counter(r[1] for r in res).most_common(1)[0]
print(f"most frequent critical chain ({n}/{len(res)}): " + " -> ".join(f"{t}({T[t]['size']})" for t in chain))
