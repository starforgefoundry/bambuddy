"""OrcaSlicer plugin connect: a signed-in user mints a narrowly scoped API key."""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.models.api_key import APIKey

TOKEN_URL = "/api/v1/connect/orcaslicer/token"


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


async def _key_count(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(APIKey))).scalar_one()


class TestOrcaSlicerToken:
    async def test_auth_disabled_returns_no_key(self, async_client, db_session):
        response = await async_client.post(TOKEN_URL, json={"device_name": "Workshop PC"})
        assert response.status_code == 200
        assert response.json() == {"key": None, "username": None, "auth_enabled": False}
        assert await _key_count(db_session) == 0

    async def test_creates_scoped_key_owned_by_user(self, async_client, admin_token, db_session):
        operator = await _user_in_group(async_client, admin_token, "Operators", "orcaop")
        response = await async_client.post(
            TOKEN_URL, headers=_auth(operator["token"]), json={"device_name": "  Workshop PC  "}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["key"].startswith("bb_")
        assert body["username"] == "orcaop"
        assert body["auth_enabled"] is True

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

        status = await async_client.get("/api/v1/printers/", headers={"X-API-Key": body["key"]})
        assert status.status_code == 200

    async def test_device_name_is_limited(self, async_client, admin_token):
        response = await async_client.post(TOKEN_URL, headers=_auth(admin_token), json={"device_name": "x" * 101})
        assert response.status_code == 422

    async def test_api_key_cannot_mint_keys(self, async_client, admin_token, db_session):
        key = (
            await async_client.post("/api/v1/api-keys/", headers=_auth(admin_token), json={"name": "script"})
        ).json()["key"]
        before = await _key_count(db_session)
        for headers in ({"X-API-Key": key}, _auth(key)):
            response = await async_client.post(TOKEN_URL, headers=headers, json={"device_name": "x"})
            assert response.status_code == 403
        assert await _key_count(db_session) == before

    async def test_requires_queue_create_permission(self, async_client, admin_token, db_session):
        viewer = await _user_in_group(async_client, admin_token, "Viewers", "orcaviewer")
        response = await async_client.post(TOKEN_URL, headers=_auth(viewer["token"]), json={"device_name": "x"})
        assert response.status_code == 403
        assert await _key_count(db_session) == 0

    async def test_unauthenticated_is_refused(self, async_client, admin_token, db_session):
        response = await async_client.post(TOKEN_URL, json={"device_name": "x"})
        assert response.status_code == 401
        assert await _key_count(db_session) == 0
