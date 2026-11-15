"""Print your real Capital One Nessie accounts and latest transactions.

    .venv/bin/python scripts/nessie_statement.py [--limit 15]

Shows what the game did at the bank in real time: each run's ghost-hunter wallet,
card and Bounty Office account, with bounty transfers and card purchases.
"""
import argparse
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
BASE = os.getenv("NESSIE_BASE", "https://v2-prod-api.nessieisreal.com")
H = {"Authorization": f"Bearer {os.environ['NESSIE_API_KEY']}"}


def get(path, **params):
    r = httpx.get(BASE + path, headers=H, params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def usd(c):
    return f"${(c or 0) / 100:,.2f}"


def main(limit):
    accounts = {a["id"]: a for a in get("/accounts", limit=100)["items"]}
    merchants = {m["id"]: m["name"] for m in get("/merchants", limit=100)["items"]}
    print(f"\nCAPITAL ONE NESSIE (live) · {len(accounts)} accounts\n")
    for a in sorted(accounts.values(), key=lambda a: a["created_at"], reverse=True)[:9]:
        extra = f" · card limit {usd(a.get('credit_limit_cents'))}" if a["type"] == "Credit Card" else ""
        print(f"  {a['nickname']:<22} {a['type']:<12} balance {usd(a['balance_cents']):>12}"
              f"  available {usd(a['available_cents']):>12}{extra}   {a['id']}")
    print(f"\nLATEST {limit} TRANSACTIONS\n")
    for t in get("/transactions", limit=limit)["items"]:
        payer = accounts.get(t.get("payer_id"), {}).get("nickname", "?")
        to = merchants.get(t.get("merchant_id")) or accounts.get(t.get("payee_id"), {}).get("nickname", "")
        print(f"  {t['created_at'][:19].replace('T', ' ')}  {t['kind']:<9} {usd(t['amount_cents']):>9}  "
              f"{t['status']:<10} {payer} -> {to}  · {t.get('description', '')}")
    print()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=15)
    main(ap.parse_args().limit)
