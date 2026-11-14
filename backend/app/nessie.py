"""Capital One Nessie v2: every suspect gets a real (sandbox) bank account, and the
money trail behind the mystery is written as real purchases and transfers.
Docs: https://v2.nessieisreal.com (key from https://v2.nessieisreal.com/account)."""
import logging
import os

import httpx

log = logging.getLogger("nessie")
BASE = os.getenv("NESSIE_BASE", "https://v2-prod-api.nessieisreal.com")
CITY_ADDR = {"Houston": ("TX", "77002"), "Los Angeles": ("CA", "90028")}


def enabled() -> bool:
    return bool(os.getenv("NESSIE_API_KEY"))


def _req(method: str, path: str, **kw) -> dict:
    r = httpx.request(method, BASE + path, timeout=20, **kw, headers={
        "Authorization": f"Bearer {os.getenv('NESSIE_API_KEY')}",
        "Content-Type": "application/json"})
    if r.status_code >= 400:
        raise RuntimeError(f"Nessie {method} {path} -> {r.status_code}: {r.text[:300]}")
    return r.json() if r.content else {}


def _address(building: dict) -> dict:
    state, zip_code = CITY_ADDR.get(building.get("city"), ("TX", "77002"))
    return {"street_number": "100", "street_name": "Main Street",
            "city": (building.get("city") or "Houston")[:80], "state": state, "zip": zip_code}


def ensure_account(game, npc_id: str) -> str:
    """Create the suspect's Nessie customer + checking account on first use."""
    npc = game.npcs[npc_id]
    if npc.get("account_id"):
        return npc["account_id"]
    first, _, last = npc["name"].partition(" ")
    cust = _req("POST", "/customers", json={
        "first_name": first[:80] or "Unknown", "last_name": (last or "Suspect")[:80],
        "address": _address(game.building)})
    acct = _req("POST", f"/customers/{cust['id']}/accounts", json={
        "type": "Checking", "nickname": f"{npc['name']} checking"[:40],
        "balance_cents": 5_000_000})
    npc["customer_id"], npc["account_id"] = cust["id"], acct["id"]
    return acct["id"]


def _merchant(game, name: str, category: str) -> str:
    key = name.lower()
    if key not in game.merchants:
        body = {"name": name[:80], "category": (category or "general")[:40]}
        if game.building.get("lat") is not None:
            body["geocode"] = {"lat": game.building["lat"], "lng": game.building["lng"]}
        game.merchants[key] = {"id": _req("POST", "/merchants", json=body)["id"], "name": name}
    return game.merchants[key]["id"]


def record(game, npc_id: str, amount_usd: float, description: str,
           merchant: str = "", category: str = "", to_npc_id: str = "") -> str:
    """Write one real Nessie purchase (to a merchant) or transfer (to another suspect)."""
    if npc_id not in game.npcs:
        return "Unknown npc"
    cents = max(1, int(round(amount_usd * 100)))
    payer = ensure_account(game, npc_id)
    if to_npc_id:
        if to_npc_id not in game.npcs:
            return "Unknown payee npc"
        payee = ensure_account(game, to_npc_id)
        tx = _req("POST", f"/accounts/{payer}/transfers", json={
            "payee_id": payee, "amount_cents": cents, "description": description[:200]})
    else:
        mid = _merchant(game, merchant or "Unknown merchant", category)
        tx = _req("POST", f"/accounts/{payer}/purchases", json={
            "merchant_id": mid, "amount_cents": cents, "description": description[:200]})
    return f"Recorded {tx.get('kind', 'transaction')} {tx.get('id')} ({tx.get('status')})"


def statements(game) -> list[dict]:
    """Pull every suspect's transactions live from Nessie."""
    merchants = {m["id"]: m["name"] for m in game.merchants.values()}
    accounts = {n["account_id"]: n["name"] for n in game.npcs.values() if n.get("account_id")}
    out = []
    for n in game.npcs.values():
        rows = []
        if n.get("account_id"):
            items = _req("GET", f"/accounts/{n['account_id']}/transactions", params={"limit": 50})["items"]
            for t in items:
                incoming = t.get("payee_id") == n["account_id"]
                other = merchants.get(t.get("merchant_id")) or accounts.get(
                    t.get("payer_id") if incoming else t.get("payee_id")) or ""
                rows.append({"kind": t.get("kind"), "status": t.get("status"),
                             "amount": t.get("amount_cents", 0) / 100,
                             "direction": "in" if incoming else "out",
                             "counterparty": other, "description": t.get("description", ""),
                             "date": t.get("created_at", "")[:10]})
        out.append({"npc_id": n["id"], "name": n["name"], "role": n["role"], "transactions": rows})
    return out
