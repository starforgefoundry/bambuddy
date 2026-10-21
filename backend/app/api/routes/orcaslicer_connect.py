"""Connect the Bambuddy plugin in OrcaSlicer with a device-code sign-in.

The plugin calls ``POST /device`` and opens the returned verification page in
the user's browser, showing the user code in OrcaSlicer. The user signs in
there, types the code and approves. Meanwhile the plugin polls ``POST /device/token`` with its device
code and, once approved, receives an API key that can read printer status,
upload to the library and queue prints, nothing more.
"""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.routes.connected_apps import require_signed_in_user
from backend.app.core.auth import (
    RequirePermissionIfAuthEnabled,
    generate_api_key,
    get_user_by_username,
    is_auth_enabled,
)
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.api_key import APIKey
from backend.app.models.auth_ephemeral import AuthEphemeralToken, EventType, TokenType
from backend.app.models.user import User
from backend.app.schemas.connected_app import (
    OrcaSlicerDeviceInfo,
    OrcaSlicerDeviceRequest,
    OrcaSlicerDeviceResponse,
    OrcaSlicerDeviceTokenRequest,
    OrcaSlicerDeviceTokenResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/connect", tags=["connected-apps"])

API_KEY_NAME_PREFIX = "OrcaSlicer - "
API_KEY_NAME_MAX_LENGTH = APIKey.__table__.c.name.type.length

DEVICE_CODE_TTL = timedelta(minutes=10)
POLL_INTERVAL_SECONDS = 2
# Sign-in requests per IP in the rate-limit window (mfa.LOCKOUT_WINDOW).
MAX_DEVICE_REQUESTS = 20

# No 0/O or 1/I, so the code reads back the same from either screen.
USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
USER_CODE_GROUP_LENGTH = 4
USER_CODE_GROUPS = 2

USER_CODE_SEPARATOR = "-"

VERIFICATION_PATH = "/connect"
EXPIRED_OR_DENIED = "expired_or_denied"


def _hash_device_code(device_code: str) -> str:
    return hashlib.sha256(device_code.encode()).hexdigest()


def _format_user_code(characters: str) -> str:
    return USER_CODE_SEPARATOR.join(
        characters[start : start + USER_CODE_GROUP_LENGTH]
        for start in range(0, len(characters), USER_CODE_GROUP_LENGTH)
    )


def _new_user_code() -> str:
    return _format_user_code(
        "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(USER_CODE_GROUP_LENGTH * USER_CODE_GROUPS))
    )


def _normalize_user_code(typed: str) -> str:
    """Accept the code as a person types it: any case, with or without the dash or spaces."""
    return _format_user_code("".join(c for c in typed.upper() if c.isalnum()))


def _live_request_filter(user_code: str):
    return (
        AuthEphemeralToken.token_type == TokenType.ORCASLICER_DEVICE,
        AuthEphemeralToken.nonce == _normalize_user_code(user_code),
        AuthEphemeralToken.expires_at > datetime.now(timezone.utc),
    )


async def _live_request(db: AsyncSession, user_code: str) -> AuthEphemeralToken | None:
    result = await db.execute(select(AuthEphemeralToken).where(*_live_request_filter(user_code)))
    return result.scalar_one_or_none()


async def _live_request_or_404(db: AsyncSession, user_code: str) -> AuthEphemeralToken:
    pending = await _live_request(db, user_code)
    if pending is None:
        raise HTTPException(404, "Sign-in request not found or expired")
    return pending


@router.post("/device", response_model=OrcaSlicerDeviceResponse)
async def start_device_sign_in(
    request: Request,
    data: OrcaSlicerDeviceRequest,
    db: AsyncSession = Depends(get_db),
):
    """Start a sign-in. Public: the plugin has no credentials yet."""
    from backend.app.api.routes.auth import _get_client_ip
    from backend.app.api.routes.mfa import check_rate_limit, record_failed_attempt

    if not await is_auth_enabled(db):
        raise HTTPException(400, "Authentication is not enabled")

    client_ip = _get_client_ip(request)
    await check_rate_limit(db, client_ip, event_type=EventType.ORCASLICER_DEVICE_IP, max_attempts=MAX_DEVICE_REQUESTS)
    await record_failed_attempt(db, client_ip, event_type=EventType.ORCASLICER_DEVICE_IP)

    now = datetime.now(timezone.utc)
    await db.execute(
        delete(AuthEphemeralToken).where(
            AuthEphemeralToken.token_type == TokenType.ORCASLICER_DEVICE,
            AuthEphemeralToken.expires_at < now,
        )
    )

    user_code = _new_user_code()
    while await _live_request(db, user_code) is not None:
        user_code = _new_user_code()

    device_code = secrets.token_urlsafe(32)
    db.add(
        AuthEphemeralToken.new_orcaslicer_device(
            device_code_hash=_hash_device_code(device_code),
            user_code=user_code,
            device_name=data.device_name,
            expires_at=now + DEVICE_CODE_TTL,
        )
    )
    await db.commit()

    return OrcaSlicerDeviceResponse(
        device_code=device_code,
        user_code=user_code,
        verification_path=VERIFICATION_PATH,
        expires_in=int(DEVICE_CODE_TTL.total_seconds()),
        interval=POLL_INTERVAL_SECONDS,
    )


@router.get("/device/{user_code}", response_model=OrcaSlicerDeviceInfo)
async def get_device_sign_in(
    user_code: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_signed_in_user),
):
    """What the consent screen shows."""
    pending = await _live_request_or_404(db, user_code)
    return OrcaSlicerDeviceInfo(user_code=pending.nonce, device_name=pending.challenge_id)


@router.post("/device/{user_code}/approve")
async def approve_device_sign_in(
    user_code: str,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.API_KEYS_CREATE, Permission.QUEUE_CREATE),
):
    if not await is_auth_enabled(db):
        raise HTTPException(400, "Authentication is not enabled")
    # The dependency returns no user for API-key callers, and a key must not mint keys.
    if user is None:
        raise HTTPException(403, "API keys cannot create API keys")

    await _live_request_or_404(db, user_code)
    claimed = await db.execute(
        update(AuthEphemeralToken)
        .where(*_live_request_filter(user_code), AuthEphemeralToken.username.is_(None))
        .values(username=user.username)
    )
    await db.commit()
    if claimed.rowcount == 0:
        raise HTTPException(409, "Sign-in request already approved")
    return {"message": "Sign-in approved"}


@router.post("/device/{user_code}/deny")
async def deny_device_sign_in(
    user_code: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_signed_in_user),
):
    pending = await _live_request_or_404(db, user_code)
    await db.delete(pending)
    await db.commit()
    return {"message": "Sign-in denied"}


@router.post("/device/token", response_model=OrcaSlicerDeviceTokenResponse)
async def poll_device_sign_in(
    data: OrcaSlicerDeviceTokenRequest,
    db: AsyncSession = Depends(get_db),
):
    """Polled by the plugin. Public: the device code is the credential."""
    now = datetime.now(timezone.utc)
    device_code_hash = _hash_device_code(data.device_code)
    result = await db.execute(
        select(AuthEphemeralToken.username).where(
            AuthEphemeralToken.token == device_code_hash,
            AuthEphemeralToken.token_type == TokenType.ORCASLICER_DEVICE,
            AuthEphemeralToken.expires_at > now,
        )
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(404, EXPIRED_OR_DENIED)
    if row.username is None:
        return OrcaSlicerDeviceTokenResponse(status="pending")

    # DELETE ... RETURNING makes the approval single use even under concurrent polls.
    consumed = await db.execute(
        delete(AuthEphemeralToken)
        .where(
            AuthEphemeralToken.token == device_code_hash,
            AuthEphemeralToken.token_type == TokenType.ORCASLICER_DEVICE,
            AuthEphemeralToken.username.is_not(None),
        )
        .returning(AuthEphemeralToken.username, AuthEphemeralToken.challenge_id)
    )
    approved = consumed.one_or_none()
    await db.commit()
    if approved is None:
        raise HTTPException(404, EXPIRED_OR_DENIED)
    username, device_name = approved

    user = await get_user_by_username(db, username)
    if user is None or not user.is_active:
        raise HTTPException(404, EXPIRED_OR_DENIED)

    full_key, key_hash, key_prefix = generate_api_key()
    api_key = APIKey(
        name=f"{API_KEY_NAME_PREFIX}{device_name}"[:API_KEY_NAME_MAX_LENGTH],
        key_hash=key_hash,
        key_prefix=key_prefix,
        user_id=user.id,
        can_queue=True,
        can_control_printer=False,
        can_read_status=True,
        can_manage_library=True,
        can_manage_inventory=False,
        can_manage_maintenance=False,
        can_manage_archives=False,
        can_manage_projects=False,
        can_access_cloud=False,
        can_update_energy_cost=False,
        can_send_notifications=False,
        printer_ids=None,
        expires_at=None,
    )
    db.add(api_key)
    await db.commit()
    await db.refresh(api_key)

    logger.info("OrcaSlicer API key %s created for user %s", api_key.id, user.id)
    return OrcaSlicerDeviceTokenResponse(status="approved", key=full_key, username=user.username)
