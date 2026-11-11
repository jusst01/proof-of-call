#!/usr/bin/env python3
"""Extract the on-chain seed set from the tg-tracker's paper.jsonl.

Source (read-only pull, kept next to this script as paper-source.jsonl):
  VPS 100.106.224.75 (Jallu's .102), service tg-tracker.service,
  /root/tg-listener/paper.jsonl — DexScreener snapshots of Pumpfun Callouts
  channel calls at t0 / 15m / 1h / 6h / 24h since 2026-11-03.

Only series with a real t0 price and a complete horizon ladder are used —
every price and outcome below comes verbatim from that file; nothing is
synthesised. Channel callouts are long calls. Selection: the manually
pre-registered series (msg 6602) first, then an even time-spread across the
rest, 24 series total.

Output: seed-data.json (consumed by seed.py).
"""

import json
import collections
from decimal import Decimal

SOURCE = "paper-source.jsonl"
OUT = "seed-data.json"
WANT = 24
FIRST_KEY = (6602, "0x44c72166408e2Dd903CF0775CAa8dbDD77147777")
HORIZON_ORDER = ["15m", "1h", "6h", "24h"]


def price_str(p):
    """Float from the tracker file -> plain decimal string (no exponent)."""
    return format(Decimal(repr(p)), "f")


def bps(entry, exit_):
    return int(round((exit_ / entry - 1.0) * 10000))


def main():
    rows = [json.loads(l) for l in open(SOURCE)]
    groups = collections.defaultdict(dict)
    for r in rows:
        if r.get("priceUsd") is None:
            continue
        groups[(r["msg_id"], r["address"])][r["checkpoint"]] = r
    full = {k: v for k, v in groups.items()
            if all(cp in v for cp in ["t0"] + HORIZON_ORDER)}
    ordered = sorted(full.items(), key=lambda kv: kv[1]["t0"]["first_seen_ts"])
    print("complete series available:", len(ordered))

    picked = []
    first = [kv for kv in ordered if kv[0] == FIRST_KEY]
    if first:
        picked.append(first[0])
        ordered = [kv for kv in ordered if kv[0] != FIRST_KEY]
    step = len(ordered) / float(WANT - len(picked))
    idx = 0.0
    while len(picked) < WANT and int(idx) < len(ordered):
        picked.append(ordered[int(idx)])
        idx += step
    picked.sort(key=lambda kv: kv[1]["t0"]["first_seen_ts"])

    seed = []
    for (msg_id, address), snaps in picked:
        t0 = snaps["t0"]
        entry = t0["priceUsd"]
        outcomes = [{
            "horizon": h,
            "exit_price": price_str(snaps[h]["priceUsd"]),
            "return_bps": bps(entry, snaps[h]["priceUsd"]),
        } for h in HORIZON_ORDER]
        seed.append({
            "msg_id": msg_id,
            "token_ref": address,
            "chain": t0.get("chainId"),
            "direction": "long",
            "first_seen_ts": t0["first_seen_ts"],
            "entry_price": price_str(entry),
            "outcomes": outcomes,
        })

    doc = {
        "provenance": {
            "source": "tg-tracker.service on VPS .102 (100.106.224.75), /root/tg-listener/paper.jsonl",
            "local_copy": "paper-source.jsonl (read-only pull, 2026-11-11)",
            "channel": "Pumpfun Callouts (tracked since 2026-11-03)",
            "note": ("Historical records imported for the demo. On-chain "
                     "registered_at is the import time, not the original call "
                     "time (kept here as first_seen_ts). Prices/outcomes are "
                     "the tracker's real recorded DexScreener snapshots."),
        },
        "calls": seed,
    }
    with open(OUT, "w") as f:
        json.dump(doc, f, indent=1)
    wins = sum(1 for c in seed if c["outcomes"][-1]["return_bps"] > 0)
    print("wrote {} series to {} (24h: {} wins / {} losses)".format(
        len(seed), OUT, wins, len(seed) - wins))
    for c in seed:
        print(" msg {} {:10s} {} 24h {:+d} bps".format(
            c["msg_id"], c["chain"], c["token_ref"][:20], c["outcomes"][-1]["return_bps"]))


if __name__ == "__main__":
    main()
