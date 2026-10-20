"""Connect the Bambuddy plugin in OrcaSlicer.

The plugin opens ``/connect/orcaslicer`` in a webview. The user signs in there
as usual, approves, and the page calls ``POST /connect/orcaslicer/token`` for
an API key that it hands to the plugin. The key can read printer status,
upload to the library and queue prints, nothing more.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled, generate_api_key, is_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.api_key import APIKey
from backend.app.models.user import User
from backend.app.schemas.connected_app import OrcaSlicerTokenRequest, OrcaSlicerTokenResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/connect", tags=["connected-apps"])

API_KEY_NAME_PREFIX = "OrcaSlicer - "
API_KEY_NAME_MAX_LENGTH = APIKey.__table__.c.name.type.length


@router.post("/orcaslicer/token", response_model=OrcaSlicerTokenResponse)
async def create_orcaslicer_token(
    data: OrcaSlicerTokenRequest,
    db: AsyncSession = Depends(get_db),
    user: User | None = RequirePermissionIfAuthEnabled(Permission.QUEUE_CREATE),
):
    """Create an API key for the plugin, owned by the signed-in user. Shown once."""
    if not await is_auth_enabled(db):
        return OrcaSlicerTokenResponse(key=None, username=None, auth_enabled=False)
    # The dependency returns no user for API-key callers, and a key must not mint keys.
    if user is None:
        raise HTTPException(403, "API keys cannot create API keys")

    full_key, key_hash, key_prefix = generate_api_key()
    api_key = APIKey(
        name=f"{API_KEY_NAME_PREFIX}{data.device_name}"[:API_KEY_NAME_MAX_LENGTH],
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
    return OrcaSlicerTokenResponse(key=full_key, username=user.username, auth_enabled=True)
