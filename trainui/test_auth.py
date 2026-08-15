"""End-to-end test of trainui's invite-only email/password auth.

Run:  python -m trainui.test_auth   (from the repo root, or
      python trainui/test_auth.py)

Spins a throwaway uvicorn server (temp DB) with TRAINUI_AUTH=1 and the
loopback exemption OFF (requests come from 127.0.0.1, so it must be off to
actually exercise the auth checks).
"""
import os
import sys
import tempfile
import threading
import time

_TMP = tempfile.mkdtemp(prefix="trainui_auth_test_")
os.environ["TRAINUI_DB"] = os.path.join(_TMP, "test.db")
os.environ["TRAINUI_AUTH"] = "1"
os.environ["TRAINUI_ALLOW_LOCALHOST"] = "0"   # test client is on loopback
os.environ["TRAINUI_ALLOWED_EMAILS"] = "alice@example.com"
os.environ["TRAINUI_API_TOKEN"] = "apitest123"
os.environ["TRAINUI_PUBLIC_URL"] = "http://tui.example.com"

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import requests  # noqa: E402
import uvicorn  # noqa: E402

from trainui import auth as _auth  # noqa: E402

PORT = 8595
BASE = f"http://127.0.0.1:{PORT}"
invite_link = {}


def fake_send_invite(email, url):
    invite_link[email] = url
    return True


_auth.send_invite = fake_send_invite  # capture links instead of emailing


def serve():
    from trainui.server import app
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="error")


t = threading.Thread(target=serve, daemon=True)
t.start()
for _ in range(100):
    try:
        requests.get(BASE + "/", timeout=1)
        break
    except Exception:
        time.sleep(0.1)
else:
    sys.exit("server did not come up")

ok = 0


def check(name, cond):
    global ok
    assert cond, name
    ok += 1
    print(f"  ok: {name}")


# -- config + auth gate --
cfg = requests.get(BASE + "/api/config").json()
check("config: auth on, no google", cfg == {"auth_enabled": True})
check("unauthenticated API call -> 401",
      requests.get(BASE + "/api/models").status_code == 401)

# -- python client shared-secret token still works --
r = requests.post(BASE + "/api/init",
                  json={"model_id": "m1", "description": "d"},
                  headers={"Authorization": "Bearer apitest123"})
check("API token accepted", r.status_code == 200)
check("wrong API token -> 401",
      requests.post(BASE + "/api/init", json={"model_id": "m2", "description": "d"},
                    headers={"Authorization": "Bearer nope"}).status_code == 401)

# -- signup: allowlist gating is non-enumerating --
r = requests.post(BASE + "/api/auth/signup", json={"email": "mallory@example.com"})
check("non-allowlisted signup still 200 (non-enumerating)", r.status_code == 200)
check("no invite sent to non-allowlisted email",
      "mallory@example.com" not in invite_link)
r = requests.post(BASE + "/api/auth/signup", json={"email": " ALICE@Example.com "})
check("allowlisted signup ok", r.status_code == 200)
url = invite_link["alice@example.com"]
check("invite link uses TRAINUI_PUBLIC_URL",
      url.startswith("http://tui.example.com/#/setpw/"))
token = url.split("#/setpw/")[1]

# -- invite landing page --
r = requests.get(f"{BASE}/api/auth/invite/{token}")
check("invite peek returns email", r.json() == {"email": "alice@example.com"})
check("bogus invite -> 410",
      requests.get(BASE + "/api/auth/invite/deadbeef").status_code == 410)

# -- set password --
r = requests.post(f"{BASE}/api/auth/invite/{token}",
                  json={"password": "hunter2aa", "password2": "hunter2ab"})
check("mismatched passwords -> 400", r.status_code == 400)
r = requests.post(f"{BASE}/api/auth/invite/{token}",
                  json={"password": "short", "password2": "short"})
check("short password -> 400", r.status_code == 400)
r = requests.post(f"{BASE}/api/auth/invite/{token}",
                  json={"password": "hunter2secret", "password2": "hunter2secret"})
check("set password ok", r.status_code == 200)
session = r.json()["token"]
check("invite consumed (single use)",
      requests.get(f"{BASE}/api/auth/invite/{token}").status_code == 410)

# -- no plaintext anywhere in the DB --
import sqlite3  # noqa: E402
raw = sqlite3.connect(os.environ["TRAINUI_DB"]).execute(
    "SELECT pw_hash FROM users").fetchall()
check("stored password is salted pbkdf2, not plaintext",
      len(raw) == 1 and raw[0][0].startswith("pbkdf2$")
      and "hunter2secret" not in raw[0][0])

# -- session token works --
H = {"Authorization": f"Bearer {session}"}
check("session token accepted",
      requests.get(BASE + "/api/models", headers=H).status_code == 200)

# -- login --
check("wrong password -> 401",
      requests.post(BASE + "/api/auth/login",
                    json={"email": "alice@example.com",
                          "password": "wrong"}).status_code == 401)
r = requests.post(BASE + "/api/auth/login",
                  json={"email": "Alice@Example.com",  # case-insensitive
                        "password": "hunter2secret"})
check("login ok", r.status_code == 200)
session2 = r.json()["token"]
check("login session works",
      requests.get(BASE + "/api/models",
                   headers={"Authorization": f"Bearer {session2}"}).status_code == 200)

# -- existing user can request a new invite only if not yet registered? no:
#    already-registered emails get nothing (keeps signup non-enumerating) --
invite_link.pop("alice@example.com", None)
requests.post(BASE + "/api/auth/signup", json={"email": "alice@example.com"})
check("no re-invite for registered user", "alice@example.com" not in invite_link)

# -- logout kills the session --
requests.post(BASE + "/api/auth/logout",
              headers={"Authorization": f"Bearer {session2}"})
check("logged-out session rejected",
      requests.get(BASE + "/api/models",
                   headers={"Authorization": f"Bearer {session2}"}).status_code == 401)

# -- loopback bypass logic (unit-style, no live request possible here since
#    we disabled it above) --
import asyncio  # noqa: E402
from unittest.mock import MagicMock  # noqa: E402


def req(host, headers=None):
    r = MagicMock()
    r.client.host = host
    r.headers = headers or {}
    return r


async def _bypass_checks():
    _auth.ALLOW_LOCALHOST = True
    os.environ["TRAINUI_AUTH"] = "1"
    # direct loopback -> exempt
    await _auth.require_auth(req("127.0.0.1"))
    await _auth.require_auth(req("::1"))
    # loopback but proxied -> NOT exempt
    for fn, kwargs in [
        (_auth.require_auth, {}),
    ]:
        pass
    try:
        await _auth.require_auth(req("127.0.0.1", {"x-forwarded-for": "1.2.3.4"}))
        return False
    except Exception as e:
        assert getattr(e, "status_code", None) == 401
    # remote host -> NOT exempt
    try:
        await _auth.require_auth(req("8.8.8.8"))
        return False
    except Exception as e:
        assert getattr(e, "status_code", None) == 401
    return True


check("loopback bypass: direct in, proxied/remote out",
      asyncio.run(_bypass_checks()))

print(f"\n{ok} checks passed")
