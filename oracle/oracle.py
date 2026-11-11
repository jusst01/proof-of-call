#!/usr/bin/env python3
"""Proof of Call — MVP oracle.

Keeps the on-chain call registry (proofofcall.opengraspdev.testnet) honest:

  * calls in `pending_entry`  -> fetch the token's current price from the
    DexScreener public API and write it as the entry price;
  * open/scored calls whose 15m / 1h / 6h / 24h horizons (counted from the
    on-chain registration timestamp) have matured -> fetch the current price,
    compute the return in bps FROM THE CALLER'S PERSPECTIVE (long profits on
    a rise, short on a fall) and append the outcome.

Idempotent: chain state is re-read before every write and the contract itself
rejects duplicate entries/outcomes, so re-running is always safe.

Writes go through near-cli-rs signed by the oracle account
(opengraspdev.testnet, keychain on this VM) — the same route the OpenGrasp
deploy used. Views are plain JSON-RPC against https://test.rpc.fastnear.com
(rpc.testnet.near.org returns empty in this environment).

Run manually:  python3 oracle.py [--dry-run]
Stdlib only.
"""

import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from decimal import Decimal

CONTRACT = "proofofcall.opengraspdev.testnet"
ORACLE_ACCOUNT = "opengraspdev.testnet"
RPC_URL = "https://test.rpc.fastnear.com"
DEX_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens/{}"
DEX_PAIRS_URL = "https://api.dexscreener.com/latest/dex/pairs/{}/{}"
HORIZONS = [("15m", 15 * 60), ("1h", 60 * 60), ("6h", 6 * 60 * 60), ("24h", 24 * 60 * 60)]
MIN_REQUEST_GAP = 1.1  # seconds between DexScreener requests (mirror tg-tracker)
DRY_RUN = "--dry-run" in sys.argv

_last_dex_ts = 0.0


def log(msg):
    print("[oracle] {}".format(msg), flush=True)


# --------------------------------------------------------------------- views

def view(method, args):
    """NEAR view call via JSON-RPC, with retries (shared egress is flaky)."""
    payload = {
        "jsonrpc": "2.0",
        "id": "1",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "account_id": CONTRACT,
            "method_name": method,
            "args_base64": base64.b64encode(json.dumps(args).encode()).decode(),
            "finality": "optimistic",
        },
    }
    last_err = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(
                RPC_URL,
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.load(resp)
            if "error" in body:
                raise RuntimeError(str(body["error"]))
            return json.loads(bytes(body["result"]["result"]))
        except Exception as e:  # noqa: BLE001 - retry any transport/RPC hiccup
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("view {} failed: {}".format(method, last_err))


# -------------------------------------------------------------------- writes

def near_write(method, args, signer=ORACLE_ACCOUNT):
    """One contract write via near-cli-rs. Returns True on on-chain success."""
    if DRY_RUN:
        log("DRY-RUN would write {} {}".format(method, json.dumps(args)))
        return True
    cmd = [
        "near", "contract", "call-function", "as-transaction",
        CONTRACT, method,
        "json-args", json.dumps(args),
        "prepaid-gas", "30 TeraGas",
        "attached-deposit", "0 NEAR",
        "sign-as", signer,
        "network-config", "testnet",
        "sign-with-keychain", "send",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    out = proc.stdout + proc.stderr
    if "succeeded" in out:
        return True
    log("WRITE FAILED {} {} :: {}".format(method, json.dumps(args), out.strip()[-400:]))
    return False


# -------------------------------------------------------------- price source

def dexscreener_price(token_ref, chain=None):
    """Current USD price (verbatim string from DexScreener) or None.

    token_ref is normally a token contract address; if the tokens endpoint
    has nothing, fall back to interpreting it as a pair address on `chain`.
    """
    global _last_dex_ts
    gap = MIN_REQUEST_GAP - (time.time() - _last_dex_ts)
    if gap > 0:
        time.sleep(gap)
    _last_dex_ts = time.time()
    try:
        req = urllib.request.Request(
            DEX_TOKENS_URL.format(token_ref),
            headers={"User-Agent": "proof-of-call-oracle/0.1"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
        pairs = data.get("pairs") or []
        if pairs:
            pairs.sort(key=lambda p: (p.get("liquidity") or {}).get("usd") or 0, reverse=True)
            price = pairs[0].get("priceUsd")
            if price:
                return str(price)
    except (urllib.error.URLError, ValueError) as e:
        log("dexscreener tokens lookup failed for {}: {}".format(token_ref, e))
    if chain:
        try:
            req = urllib.request.Request(
                DEX_PAIRS_URL.format(chain, token_ref),
                headers={"User-Agent": "proof-of-call-oracle/0.1"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            pair = data.get("pair") or {}
            price = pair.get("priceUsd")
            if price:
                return str(price)
        except (urllib.error.URLError, ValueError) as e:
            log("dexscreener pair lookup failed for {}/{}: {}".format(chain, token_ref, e))
    return None


def return_bps(entry_price, exit_price, direction):
    """Signed bps from the caller's perspective. Prices are decimal strings."""
    entry = Decimal(str(entry_price))
    exit_ = Decimal(str(exit_price))
    if entry <= 0:
        raise ValueError("entry price must be positive")
    bps = int(((exit_ / entry) - 1) * 10000)
    if direction == "short":
        bps = -bps
    return bps


# ------------------------------------------------------------------ main run

def run():
    count = view("get_call_count", {})
    log("contract holds {} call(s)".format(count))
    now_ns = int(time.time() * 1e9)
    entries_set = outcomes_written = skipped = 0
    for call_id in range(count):
        call = view("get_call", {"id": call_id})
        if call is None:
            continue
        have = {o["horizon"] for o in call.get("outcomes", [])}
        if call["status"] == "pending_entry":
            price = dexscreener_price(call["token_ref"], call.get("chain"))
            if price is None:
                log("call {}: no DexScreener price for {} — leaving pending_entry".format(call_id, call["token_ref"]))
                skipped += 1
                continue
            if near_write("set_entry_price", {"call_id": call_id, "price": price}):
                log("call {}: entry price set to {}".format(call_id, price))
                entries_set += 1
                call["entry_price"] = price  # horizons cannot be mature yet
            continue
        # entry is set: write any matured, still-missing outcomes
        for horizon, secs in HORIZONS:
            if horizon in have:
                continue
            if now_ns < int(call["registered_at_ns"]) + secs * 10**9:
                continue
            price = dexscreener_price(call["token_ref"], call.get("chain"))
            if price is None:
                log("call {} {}: no price — will retry next run".format(call_id, horizon))
                skipped += 1
                continue
            try:
                bps = return_bps(call["entry_price"], price, call["direction"])
            except ValueError as e:
                log("call {} {}: {}".format(call_id, horizon, e))
                skipped += 1
                continue
            if near_write("record_outcome", {
                "call_id": call_id, "horizon": horizon,
                "exit_price": price, "return_bps": bps,
            }):
                log("call {} {}: exit {} -> {:+d} bps".format(call_id, horizon, price, bps))
                outcomes_written += 1
    log("done: {} entries set, {} outcomes written, {} skipped".format(entries_set, outcomes_written, skipped))


if __name__ == "__main__":
    run()
