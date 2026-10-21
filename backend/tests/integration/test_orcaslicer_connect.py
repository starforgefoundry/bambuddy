"""OrcaSlicer plugin device sign-in: a signed-in user approves, the plugin gets a scoped API key."""

import re
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update

from backend.app.models.api_key import APIKey
from backend.app.models.auth_ephemeral import AuthEphemeralToken, TokenType

BASE_URL = "/api/v1/connect/orcaslicer/device"
TOKEN_URL = f"{BASE_URL}/token"
USER_CODE_PATTERN = r"^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$"


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def admin_token(async_client: AsyncClient) -> str:
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "orcaadmin", "admin_password": "AdminPass1!"},
    )
    login = await async_client.post("/api/v1/auth/login", json={"username": "orcaadmin", "password": "AdminPass1!"})
    return login.json()["access_token"]


async def _user_in_group(async_client: AsyncClient, admin_token: str, group_name: str, username: str) -> dict:
    groups = (await async_client.get("/api/v1/groups/", headers=_auth(admin_token))).json()
    group = next(g for g in groups if g["name"] == group_name)
    user = (
        await async_client.post(
            "/api/v1/users/",
            headers=_auth(admin_token),
            json={"username": username, "password": "Userpass1!", "group_ids": [group["id"]]},
        )
    ).json()
    login = await async_client.post("/api/v1/auth/login", json={"username": username, "password": "Userpass1!"})
    return {"id": user["id"], "token": login.json()["access_token"]}


async def _start(async_client: AsyncClient, device_name: str = "Workshop PC") -> dict:
    response = await async_client.post(BASE_URL, json={"device_name": device_name})
    assert response.status_code == 200, response.text
    return response.json()


async def _poll(async_client: AsyncClient, device_code: str):
    return await async_client.post(TOKEN_URL, json={"device_code": device_code})


async def _key_count(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(APIKey))).scalar_one()


async def _device_rows(db_session) -> list[AuthEphemeralToken]:
    result = await db_session.execute(
        select(AuthEphemeralToken).where(AuthEphemeralToken.token_type == TokenType.ORCASLICER_DEVICE)
    )
    return list(result.scalars().all())


class TestOrcaSlicerDeviceSignIn:
    async def test_auth_disabled_refuses_to_start(self, async_client, db_session):
        response = await async_client.post(BASE_URL, json={"device_name": "Workshop PC"})
        assert response.status_code == 400
        assert await _device_rows(db_session) == []

    async def test_start_is_public_and_stores_only_the_hash(self, async_client, admin_token, db_session):
        body = await _start(async_client, "  Workshop PC  ")

        assert re.match(USER_CODE_PATTERN, body["user_code"])
        assert body["verification_path"] == f"/connect/orcaslicer?code={body['user_code']}"
        assert body["expires_in"] == 600
        assert body["interval"] == 2

        (row,) = await _device_rows(db_session)
        assert row.token != body["device_code"]
        assert row.nonce == body["user_code"]
        assert row.challenge_id == "Workshop PC"
        assert row.username is None

    async def test_device_name_is_limited(self, async_client, admin_token):
        response = await async_client.post(BASE_URL, json={"device_name": "x" * 101})
        assert response.status_code == 422

    async def test_pending_poll(self, async_client, admin_token):
        body = await _start(async_client)
        response = await _poll(async_client, body["device_code"])
        assert response.status_code == 200
        assert response.json() == {"status": "pending", "key": None, "username": None}

    async def test_consent_info(self, async_client, admin_token):
        body = await _start(async_client)
        response = await async_client.get(f"{BASE_URL}/{body['user_code']}", headers=_auth(admin_token))
        assert response.status_code == 200
        assert response.json() == {"user_code": body["user_code"], "device_name": "Workshop PC"}

        missing = await async_client.get(f"{BASE_URL}/ABCD-EFGH", headers=_auth(admin_token))
        assert missing.status_code == 404

    async def test_approve_then_poll_returns_scoped_key_once(self, async_client, admin_token, db_session):
        operator = await _user_in_group(async_client, admin_token, "Operators", "orcaop")
        body = await _start(async_client)

        approve = await async_client.post(f"{BASE_URL}/{body['user_code']}/approve", headers=_auth(operator["token"]))
        assert approve.status_code == 200, approve.text
        again = await async_client.post(f"{BASE_URL}/{body['user_code']}/approve", headers=_auth(operator["token"]))
        assert again.status_code == 409

        response = await _poll(async_client, body["device_code"])
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["status"] == "approved"
        assert result["key"].startswith("bb_")
        assert result["username"] == "orcaop"
        assert await _device_rows(db_session) == []

        key = (await db_session.execute(select(APIKey))).scalar_one()
        assert key.name == "OrcaSlicer - Workshop PC"
        assert key.user_id == operator["id"]
        assert key.can_read_status and key.can_manage_library and key.can_queue
        assert not any(
            [
                key.can_control_printer,
                key.can_manage_inventory,
                key.can_manage_maintenance,
                key.can_manage_archives,
                key.can_manage_projects,
                key.can_access_cloud,
                key.can_update_energy_cost,
                key.can_send_notifications,
            ]
        )
        assert key.printer_ids is None
        assert key.expires_at is None

        status = await async_client.get("/api/v1/printers/", headers={"X-API-Key": result["key"]})
        assert status.status_code == 200

        second = await _poll(async_client, body["device_code"])
        assert second.status_code == 404
        assert second.json() == {"detail": "expired_or_denied"}

    async def test_deny_ends_the_request(self, async_client, admin_token, db_session):
        body = await _start(async_client)
        deny = await async_client.post(f"{BASE_URL}/{body['user_code']}/deny", headers=_auth(admin_token))
        assert deny.status_code == 200

        response = await _poll(async_client, body["device_code"])
        assert response.status_code == 404
        assert response.json() == {"detail": "expired_or_denied"}
        assert await _key_count(db_session) == 0

        missing = await async_client.post(f"{BASE_URL}/{body['user_code']}/deny", headers=_auth(admin_token))
        assert missing.status_code == 404

    async def test_expired_request(self, async_client, admin_token, db_session):
        body = await _start(async_client)
        await db_session.execute(
            update(AuthEphemeralToken)
            .where(AuthEphemeralToken.token_type == TokenType.ORCASLICER_DEVICE)
            .values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1))
        )
        await db_session.commit()

        approve = await async_client.post(f"{BASE_URL}/{body['user_code']}/approve", headers=_auth(admin_token))
        assert approve.status_code == 404
        response = await _poll(async_client, body["device_code"])
        assert response.status_code == 404
        assert response.json() == {"detail": "expired_or_denied"}

    async def test_unknown_device_code(self, async_client, admin_token):
        response = await _poll(async_client, "not-a-real-code")
        assert response.status_code == 404

    async def test_api_key_cannot_approve(self, async_client, admin_token, db_session):
        key = (
            await async_client.post("/api/v1/api-keys/", headers=_auth(admin_token), json={"name": "script"})
        ).json()["key"]
        body = await _start(async_client)
        for headers in ({"X-API-Key": key}, _auth(key)):
            response = await async_client.post(f"{BASE_URL}/{body['user_code']}/approve", headers=headers)
            assert response.status_code == 403
        (row,) = await _device_rows(db_session)
        assert row.username is None

    async def test_requires_queue_create_permission(self, async_client, admin_token, db_session):
        viewer = await _user_in_group(async_client, admin_token, "Viewers", "orcaviewer")
        body = await _start(async_client)
        response = await async_client.post(f"{BASE_URL}/{body['user_code']}/approve", headers=_auth(viewer["token"]))
        assert response.status_code == 403
        (row,) = await _device_rows(db_session)
        assert row.username is None

    async def test_consent_endpoints_require_sign_in(self, async_client, admin_token):
        body = await _start(async_client)
        code = body["user_code"]
        assert (await async_client.get(f"{BASE_URL}/{code}")).status_code == 401
        assert (await async_client.post(f"{BASE_URL}/{code}/approve")).status_code == 401
        assert (await async_client.post(f"{BASE_URL}/{code}/deny")).status_code == 401
