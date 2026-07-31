"""Mirror houses from the live server's public read API into data/housing/.

Terrain is reproducible from the seed, but houses are operator-authored
content that exists only on the server. This pulls the chunks around each
town so villages actually have buildings locally.

    python mirror-housing.py                 # every town in map_labels.csv
    python mirror-housing.py aldermark edra  # just these

On-disk layout mirrors server/src/housing: {base}/r{cx:+03}_{cz:+03}/{id}.json
"""

import csv
import json
import os
import sys
import time
import urllib.request

HOST = os.environ.get("OPENMMO_HOST", "https://openmmo.to.nexus")
REPO = os.environ.get("OPENMMO_REPO", os.getcwd())
HOUSING = os.path.join(REPO, "data", "housing")
LABELS = os.path.join(REPO, "data-src", "map_labels.csv")
CHUNK_M = 64.0
# Chunk radius around each town centre. 12 chunks = 768 m, comfortably past
# the edge of the largest settlement pads.
RADIUS = int(os.environ.get("OPENMMO_RADIUS", "12"))


def chunk_of(v):
    return int(v // CHUNK_M)


def fetch(cx, cz):
    url = f"{HOST}/api/housing/area/{cx}/{cz}"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # transient network / rate limiting
            if attempt == 3:
                print(f"  ! {cx}/{cz}: {e}")
                return []
            time.sleep(2 ** attempt)
    return []


def towns(only):
    with open(LABELS, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["kind"] not in ("capital", "city", "town"):
                continue
            if only and row["id"] not in only:
                continue
            yield row["id"], float(row["x"]), float(row["z"])


def main():
    only = set(a.lower() for a in sys.argv[1:])
    total_houses = 0
    total_chunks = 0
    for name, x, z in towns(only):
        cx0, cz0 = chunk_of(x), chunk_of(z)
        found = 0
        for cx in range(cx0 - RADIUS, cx0 + RADIUS + 1):
            for cz in range(cz0 - RADIUS, cz0 + RADIUS + 1):
                total_chunks += 1
                houses = fetch(cx, cz)
                if not houses:
                    continue
                d = os.path.join(HOUSING, f"r{cx:+03d}_{cz:+03d}")
                os.makedirs(d, exist_ok=True)
                for h in houses:
                    hid = h.get("id")
                    if not hid or "/" in hid or "\\" in hid:
                        continue
                    with open(os.path.join(d, f"{hid}.json"), "w",
                              encoding="utf-8") as fh:
                        json.dump(h, fh, indent=2)
                    found += 1
        total_houses += found
        print(f"{name:12s} chunk ({cx0},{cz0}) -> {found} house(s)")
    print(f"\n{total_houses} houses from {total_chunks} chunks -> {HOUSING}")
    print("Now run:  cargo run --release -p terrain-gen -- apply-houses")


if __name__ == "__main__":
    main()
