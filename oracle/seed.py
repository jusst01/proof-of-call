#!/usr/bin/env python3
"""Seed proofofcall.opengraspdev.testnet with the imported historical calls.

Reads seed-data.json (see extract_seed.py for provenance), registers each
call from the dev account (opengraspdev.testnet — it is both the demo caller
and the MVP oracle), then backfills the REAL recorded entry price and
15m/1h/6h/24h outcomes from the tracker file.

Honesty note: on-chain `registered_at` timestamps are import-time; these are
demonstration records of the tracked channel's history, not live calls.
Original timestamps live in seed-data.json (first_seen_ts).

Idempotent: progress is tracked in seed-progress.json AND every write is
preceded by a fresh on-chain read, so re-running skips finished steps.

Run:  python3 seed.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
PROGRESS = os.path.join(HERE, "seed-progress.json")
CALLER = oracle.ORACLE_ACCOUNT  # dev account is caller AND oracle for the MVP


def load_progress():
    if os.path.exists(PROGRESS):
        return json.load(open(PROGRESS))
    # call id 0 was registered manually before this script existed
    # (msg 6602, the BSC token below) — adopt it.
    return {"6602|0x44c72166408e2Dd903CF0775CAa8dbDD77147777": {"call_id": 0}}


def save_progress(p):
    tmp = PROGRESS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(p, f, indent=1)
    os.replace(tmp, PROGRESS)


def main():
    doc = json.load(open(os.path.join(HERE, "seed-data.json")))
    progress = load_progress()
    done = 0
    for entry in doc["calls"]:
        key = "{}|{}".format(entry["msg_id"], entry["token_ref"])
        rec = progress.get(key, {})
        if "call_id" not in rec:
            before = oracle.view("get_call_count", {})
            ok = oracle.near_write("register_call", {
                "chain": entry["chain"],
                "token_ref": entry["token_ref"],
                "direction": entry["direction"],
            }, signer=CALLER)
            if not ok:
                oracle.log("seed {}: register failed, stopping".format(key))
                save_progress(progress)
                return
            call = oracle.view("get_call", {"id": before})
            assert call and call["token_ref"] == entry["token_ref"], \
                "id mismatch after register for {}".format(key)
            rec["call_id"] = before
            progress[key] = rec
            save_progress(progress)
            oracle.log("seed {}: registered as call {}".format(key, before))
        call_id = rec["call_id"]
        state = oracle.view("get_call", {"id": call_id})
        if state["entry_price"] is None:
            if not oracle.near_write("set_entry_price",
                                     {"call_id": call_id, "price": entry["entry_price"]}):
                oracle.log("seed {}: set_entry_price failed, stopping".format(key))
                save_progress(progress)
                return
            oracle.log("seed call {}: entry {}".format(call_id, entry["entry_price"]))
            state = oracle.view("get_call", {"id": call_id})
        have = {o["horizon"] for o in state.get("outcomes", [])}
        for outcome in entry["outcomes"]:
            if outcome["horizon"] in have:
                continue
            if not oracle.near_write("record_outcome", {
                "call_id": call_id,
                "horizon": outcome["horizon"],
                "exit_price": outcome["exit_price"],
                "return_bps": outcome["return_bps"],
            }):
                oracle.log("seed {}: record_outcome {} failed, stopping".format(key, outcome["horizon"]))
                save_progress(progress)
                return
            oracle.log("seed call {}: {} -> {:+d} bps".format(
                call_id, outcome["horizon"], outcome["return_bps"]))
        done += 1
    save_progress(progress)
    oracle.log("seed complete: {}/{} calls fully written".format(done, len(doc["calls"])))


if __name__ == "__main__":
    main()
