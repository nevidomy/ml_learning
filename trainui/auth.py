"""Optional authentication for trainui.

Enabled by setting TRAINUI_GOOGLE_CLIENT_ID (a Google OAuth "Web application"
client ID). When enabled, every /api/* request must carry either:

  - `Authorization: Bearer <google id token>` from a whitelisted Google account
    (TRAINUI_ALLOWED_EMAILS, comma-separated), used by the web UI, or
  - `Authorization: Bearer <TRAINUI_API_TOKEN>`, a shared secret used by the
    python client on training machines.

When TRAINUI_GOOGLE_CLIENT_ID is unset, auth is disabled entirely (local dev).
"""
from __future__ import annotations

import os

from fastapi import HTTPException, Request

GOOGLE_CLIENT_ID = os.environ.get("TRAINUI_GOOGLE_CLIENT_ID", "")
ALLOWED_EMAILS = {
    e.strip().lower()
    for e in os.environ.get(
        "TRAINUI_ALLOWED_EMAILS", "nevidomy.vitaliy@gmail.com"
    ).split(",")
    if e.strip()
}
API_TOKEN = os.environ.get("TRAINUI_API_TOKEN", "")

# google-auth is only required when auth is enabled
if GOOGLE_CLIENT_ID:
    from google.auth.transport import requests as _g_requests
    from google.oauth2 import id_token as _g_id_token

    _g_request = _g_requests.Request()


def auth_enabled() -> bool:
    return bool(GOOGLE_CLIENT_ID)


def config() -> dict:
    """Public (unauthenticated) settings for the UI boot sequence."""
    return {
        "auth_enabled": auth_enabled(),
        "google_client_id": GOOGLE_CLIENT_ID or None,
    }


def _google_email(token: str) -> str | None:
    try:
        info = _g_id_token.verify_oauth2_token(token, _g_request, GOOGLE_CLIENT_ID)
    except Exception:
        return None
    email = (info.get("email") or "").lower()
    if info.get("email_verified") and email in ALLOWED_EMAILS:
        return email
    return None


async def require_auth(request: Request) -> None:
    if not auth_enabled():
        return
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    if token:
        if API_TOKEN and token == API_TOKEN:
            return
        if _google_email(token):
            return
    raise HTTPException(status_code=401, detail="unauthorized")
