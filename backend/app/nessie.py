"""Capital One Nessie v2 as the game's real economy.

At the start of a run we open real sandbox accounts: the player's checking account,
a Capital One credit card, and the "Bounty Office". Every ghost captured is a real
transfer (bounty) into checking; it settles in about a minute, so until then the HUD
shows it as pending. Upgrades at the in-game ATM are real card purchases, which are
approved instantly (the game only lets you charge what your bounties have earned).
Docs: https://v2.nessieisreal.com (key from https://v2.nessieisreal.com/account)."""
import logging
import os

import httpx

log = logging.getLogger("nessie")
BASE = os.getenv("NESSIE_BASE", "https://v2-prod-api.nessieisreal.com")
CITY_ADDR = {"Houston": ("TX", "77002"), "Los Angeles": ("CA", "90028")}


class InsufficientFunds(Exception):
    pass


def enabled() -> bool:
    return bool(os.getenv("NESSIE_API_KEY"))


def _req(method: str, path: str, **kw) -> dict:
    r = httpx.request(method, BASE + path, timeout=15, **kw, headers={
        "Authorization": f"Bearer {os.getenv('NESSIE_API_KEY')}",
        "Content-Type": "application/json"})
    if r.status_code == 422 and ("insufficient" in r.text or "credit_limit" in r.text):
        raise InsufficientFunds(r.text[:200])
    if r.status_code >= 400:
        raise RuntimeError(f"Nessie {method} {path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def _address(building: dict) -> dict:
    state, zip_code = CITY_ADDR.get(building.get("city"), ("TX", "77002"))
    return {"street_number": "100", "street_name": "Main Street",
            "city": (building.get("city") or "Houston")[:80], "state": state, "zip": zip_code}


def _settle(tx: dict) -> dict:
    """Settle right away so the balance updates in real time (else the sandbox sweep does it)."""
    try:
        return _req("POST", f"/transactions/{tx['id']}/settle") or tx
    except Exception as e:
        log.info("settle skipped: %s", e)
        return tx


def open_wallet(run, player_name: str = "Ghost Hunter"):
    first, _, last = player_name.partition(" ")
    addr = _address(run.building)
    player = _req("POST", "/customers", json={"first_name": first[:80] or "Ghost",
                                              "last_name": (last or "Hunter")[:80], "address": addr})
    p_acct = _req("POST", f"/customers/{player['id']}/accounts", json={
        "type": "Checking", "nickname": "Ghost hunter wallet", "balance_cents": 0})
    office = _req("POST", "/customers", json={"first_name": "Bounty", "last_name": "Office", "address": addr})
    o_acct = _req("POST", f"/customers/{office['id']}/accounts", json={
        "type": "Checking", "nickname": "Ghost bounty fund", "balance_cents": 50_000_000})
    card = _req("POST", f"/customers/{player['id']}/accounts", json={
        "type": "Credit Card", "nickname": "Ghost Hunter Card", "balance_cents": 0,
        "credit_limit_cents": 50000})
    merchant = _req("POST", "/merchants", json={"name": "Ghostbusting Supply Co.", "category": "equipment"})
    run.wallet.update(live=True, player_account=p_acct["id"], bank_account=o_acct["id"],
                      card_account=card["id"], merchant=merchant["id"])


def pay_bounty(run, cents: int, description: str) -> dict:
    w = run.wallet
    tx = _req("POST", f"/accounts/{w['bank_account']}/transfers", json={
        "payee_id": w["player_account"], "amount_cents": cents, "description": description[:200]})
    return _settle(tx)


def buy(run, cents: int, description: str) -> dict:
    """A real purchase on the player's Capital One card."""
    w = run.wallet
    tx = _req("POST", f"/accounts/{w['card_account']}/purchases", json={
        "merchant_id": w["merchant"], "amount_cents": cents, "description": description[:200]})
    return _settle(tx)


def refresh(run):
    """Pull the live Capital One balance; whatever has not settled yet shows as pending."""
    bal = balance(run)
    if bal is not None:
        w = run.wallet
        w["balance"] = bal                              # settled bounties in checking
        w["pending"] = max(0, w["earned"] - bal)        # bounties still settling


def balance(run) -> int | None:
    try:
        a = _req("GET", f"/accounts/{run.wallet['player_account']}")
        return a.get("available_cents", a.get("balance_cents"))
    except Exception as e:
        log.info("balance unavailable: %s", e)
        return None
