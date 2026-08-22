"""Invite-only email/password authentication for trainui.

Enabled with `--global` on the server (sets TRAINUI_AUTH=1) or by setting
TRAINUI_AUTH=1 directly. No Google Cloud project needed. Flow:

  signup(email)            -- allowlist-gated (TRAINUI_ALLOWED_EMAILS);
                              emails a one-time password-setup link
  set_password(token, pw)  -- consumes the invite, creates the user
  login(email, pw)         -- returns a 30-day session token (Bearer)

Every /api/* request then needs one of:
  - `Authorization: Bearer <session token>` from the login flow (web UI)
  - `Authorization: Bearer <TRAINUI_API_TOKEN>` -- shared secret used by the
    python client on training machines
  - nothing at all from DIRECT loopback connections (local tools keep
    working; see the proxy-header note below)

Security ground rules:
  * passwords are NEVER stored or logged in plaintext -- only salted
    PBKDF2-HMAC-SHA256 hashes (260k iterations, constant-time compare);
  * invite + session tokens are 256-bit random and stored only as SHA-256
    digests, with expiries; invites are single-use (24h);
  * transport is the one thing this file can't do: serve --global behind
    HTTPS (any tunnel / reverse proxy that terminates TLS is fine) so
    passwords aren't sent in the clear.

Env:
  TRAINUI_AUTH=1               enable auth (server --global sets this)
  TRAINUI_ALLOWED_EMAILS       comma list (default: owner email)
  TRAINUI_API_TOKEN            shared-secret bearer for the python client
  TRAINUI_ALLOW_LOCALHOST=0    disable the loopback exemption
  TRAINUI_SMTP_HOST/PORT/USER/PASS/FROM   outbound mail; without them the
                               invite link is printed to the server log
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import smtplib
import time
from email.message import EmailMessage

from fastapi import HTTPException, Request

ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get(
        "TRAINUI_ALLOWED_EMAILS", "nevidomy.vitaliy@gmail.com"
    ).split(",")
    if e.strip()
}
def api_token() -> str:
    """Current client bearer token. Env override wins; otherwise the value
    persisted in the DB (minted on first start if neither is set)."""
    env = os.environ.get("TRAINUI_API_TOKEN", "").strip()
    if env:
        return env
    try:
        from .server import db
        return db.get_setting("api_token") or ""
    except Exception:
        return ""

_PBKDF2_ITERATIONS = 260_000
INVITE_TTL_S = 24 * 3600
SESSION_TTL_S = 30 * 24 * 3600

# outbound mail (invite links). Without SMTP configured the link is printed
# to the server log instead -- fine for inviting yourself, useless otherwise.
SMTP_HOST = os.environ.get("TRAINUI_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("TRAINUI_SMTP_PORT", "587"))
SMTP_USER = os.environ.get("TRAINUI_SMTP_USER", "")
SMTP_PASS = os.environ.get("TRAINUI_SMTP_PASS", "")
SMTP_FROM = os.environ.get("TRAINUI_SMTP_FROM", SMTP_USER)

# loopback exemption: direct connections from this machine skip auth.
# "Direct" matters -- a reverse proxy on the same host also connects from
# 127.0.0.1, so the exemption is void whenever proxy headers are present
# (caddy/nginx set X-Forwarded-For by default; if yours doesn't, fix that
# or set TRAINUI_ALLOW_LOCALHOST=0).
ALLOW_LOCALHOST = os.environ.get("TRAINUI_ALLOW_LOCALHOST", "1") == "1"
LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded")


def auth_enabled() -> bool:
    # read lazily so `python -m trainui.server --global` (which sets the env
    # var in main(), after this module is imported) still takes effect
    return os.environ.get("TRAINUI_AUTH", "") == "1"


def config() -> dict:
    """Public (unauthenticated) settings for the UI boot sequence."""
    return {"auth_enabled": auth_enabled()}


# ------------------------------------------------------------- passwords
def hash_password(pw: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, iters, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(),
                                 bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


# --------------------------------------------------------------- tokens
def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_invite(db, email: str) -> str:
    """One-time, 24h invite; returns the plaintext token (emailed once)."""
    token = secrets.token_urlsafe(32)
    db.token_create(_digest(token), email, "invite", INVITE_TTL_S)
    return token


def peek_invite(db, token: str):
    """-> email if the invite is valid, WITHOUT consuming it."""
    return db.token_peek(_digest(token), "invite")


def consume_invite(db, token: str):
    """-> email if the invite is valid, marking it used (single-use)."""
    return db.invite_consume(_digest(token))


def create_session(db, email: str) -> str:
    token = secrets.token_urlsafe(32)
    db.token_create(_digest(token), email, "session", SESSION_TTL_S)
    return token


def session_email(db, token: str):
    return db.token_peek(_digest(token), "session")


def drop_session(db, token: str):
    db.session_drop(_digest(token))


# ---------------------------------------------------------------- email
def send_invite(email: str, url: str) -> bool:
    """Email the invite link via SMTP; without SMTP config, log it instead
    (returns False so the caller can note the fallback)."""
    if not SMTP_HOST:
        print(f"[trainui] SMTP not configured; invite link for {email}: {url}",
              flush=True)
        return False
    msg = EmailMessage()
    msg["Subject"] = "trainui invite"
    msg["From"] = SMTP_FROM
    msg["To"] = email
    msg.set_content(
        "You've been invited to a trainui server.\n\n"
        f"Set your password (link valid for 24h, single use):\n{url}\n\n"
        "If you didn't request this, ignore it.\n")
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            if SMTP_USER:
                s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as s:
            s.ehlo()
            s.starttls()
            if SMTP_USER:
                s.login(SMTP_USER, SMTP_PASS)
            s.send_message(msg)
    return True


# -------------------------------------------------------------- gateway
async def require_auth(request: Request) -> None:
    if not auth_enabled():
        return
    if (ALLOW_LOCALHOST and request.client
            and request.client.host in LOOPBACK_HOSTS
            and not any(h in request.headers for h in PROXY_HEADERS)):
        return
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if token:
        expected = api_token()
        if (expected and len(token) == len(expected)
                and hmac.compare_digest(token, expected)):
            return
        # local import avoids a circular import at module load; the server
        # owns the Database singleton
        from .server import db
        if session_email(db, token):
            return
    raise HTTPException(status_code=401, detail="unauthorized")
