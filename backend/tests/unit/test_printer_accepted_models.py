"""Per-printer opt-in to another model's queued jobs.

A farm that slices everything for one model still wants the machines that can
run that G-code to pick the jobs up — an X1C set to accept P1S work must be
offered "Any P1S" items. The opt-in is bounded by the G-code interchange
family (#2578), so it can widen who takes a job but never what hardware the
G-code reaches.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401 - populate Base.metadata
from backend.app.core.database import Base
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.utils.printer_models import (
    compatible_models,
    printer_accepts_model,
    validate_accepted_models,
)

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_only_family_siblings_are_offered():
    assert compatible_models("X1C") == ["P1P", "P1S", "X1", "X1E"]
    # Its own model is never in the list — it always takes its own jobs.
    assert "X1C" not in compatible_models("X1C")
    # Models with no interchangeable sibling have nothing to offer.
    assert compatible_models("H2D") == []
    assert compatible_models("A1 Mini") == []
    assert compatible_models(None) == []


def test_validation_canonicalizes_and_deduplicates():
    assert validate_accepted_models("X1C", ["P1S", "Bambu Lab P1P", "p1s"]) == ["P1S", "P1P"]
    assert validate_accepted_models("X1C", ["X1C"]) == []
    assert validate_accepted_models("X1C", None) == []


def test_validation_rejects_a_model_outside_the_family():
    with pytest.raises(ValueError, match="not interchangeable"):
        validate_accepted_models("X1C", ["H2D"])
    with pytest.raises(ValueError, match="not interchangeable"):
        validate_accepted_models("A1", ["A1 Mini"])


def test_validation_needs_the_printer_model_first():
    with pytest.raises(ValueError, match="model"):
        validate_accepted_models(None, ["P1S"])


def test_a_printer_accepts_its_own_model_and_its_opt_ins():
    assert printer_accepts_model("X1C", ["P1S"], "P1S")
    assert printer_accepts_model("X1C", [], "X1C")
    assert printer_accepts_model("X1C", None, "x1c")
    assert not printer_accepts_model("X1C", [], "P1S")
    assert not printer_accepts_model("X1C", ["P1S"], "P1P")


def test_an_out_of_family_opt_in_is_ignored_not_trusted():
    """A row written before the validator existed, or through a direct API
    write, must not widen what the scheduler dispatches."""
    assert not printer_accepts_model("X1C", ["H2D"], "H2D")


# ---------------------------------------------------------------------------
# Scheduler matching
# ---------------------------------------------------------------------------


def _printer(printer_id, name, model, accepted=None, location=None, is_active=True):
    return Printer(
        id=printer_id,
        name=name,
        serial_number=f"SN{printer_id:04d}",
        ip_address=f"10.0.0.{printer_id}",
        access_code="x",
        model=model,
        accepted_models=accepted,
        location=location,
        is_active=is_active,
    )


@pytest.fixture
async def farm():
    """One X1C opted in to P1S jobs, one real P1S, one uninterested X1C, and
    one opted-in X1C in maintenance mode."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_maker = async_sessionmaker(engine, expire_on_commit=False)

    async with session_maker() as db:
        db.add(_printer(1, "X1C-opted-in", "X1C", accepted=["P1S"]))
        db.add(_printer(2, "P1S-1", "P1S"))
        db.add(_printer(3, "X1C-plain", "X1C"))
        db.add(_printer(4, "X1C-in-maintenance", "X1C", accepted=["P1S"], is_active=False))
        await db.commit()

    try:
        yield SimpleNamespace(session_maker=session_maker)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_opted_in_printer_is_matched_for_the_other_models_jobs(farm):
    async with farm.session_maker() as db:
        printers = await PrintScheduler()._printers_for_model(db, "P1S")
    assert [p.name for p in printers] == ["P1S-1", "X1C-opted-in"]


@pytest.mark.asyncio
async def test_a_printer_without_the_opt_in_is_not_matched(farm):
    async with farm.session_maker() as db:
        printers = await PrintScheduler()._printers_for_model(db, "X1C")
    # The opt-in is one-way: accepting P1S work does not stop it being an X1C,
    # but the P1S is not dragged in the other direction.
    assert [p.name for p in printers] == ["X1C-opted-in", "X1C-plain"]


@pytest.mark.asyncio
async def test_the_opt_in_does_not_survive_maintenance_mode_or_a_location_filter(farm):
    async with farm.session_maker() as db:
        assert "X1C-in-maintenance" not in [p.name for p in await PrintScheduler()._printers_for_model(db, "P1S")]
        assert await PrintScheduler()._printers_for_model(db, "P1S", "Garage") == []


@pytest.mark.asyncio
async def test_matcher_offers_the_opted_in_printer_when_it_is_the_only_one(farm):
    """The reporter's farm: everything sliced for P1S, one X1C to run it on."""
    async with farm.session_maker() as db:
        await db.delete(await db.get(Printer, 2))
        await db.commit()

    scheduler = PrintScheduler()
    with (
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch.object(scheduler, "_is_printer_idle", MagicMock(return_value=True)),
    ):
        async with farm.session_maker() as db:
            printer_id, reason = await scheduler._find_idle_printer_for_model(db, "P1S", set())

    assert printer_id == 1
    assert reason is None


@pytest.mark.asyncio
async def test_real_printers_of_the_model_are_taken_before_opted_in_ones(farm):
    scheduler = PrintScheduler()
    with (
        patch("backend.app.services.print_scheduler.printer_manager.is_connected", MagicMock(return_value=True)),
        patch.object(scheduler, "_is_printer_idle", MagicMock(return_value=True)),
    ):
        async with farm.session_maker() as db:
            printer_id, _ = await scheduler._find_idle_printer_for_model(db, "P1S", set())

    assert printer_id == 2


@pytest.mark.asyncio
async def test_no_capable_printer_reads_as_none_configured(farm):
    scheduler = PrintScheduler()
    async with farm.session_maker() as db:
        printer_id, reason = await scheduler._find_idle_printer_for_model(db, "H2D", set())
    assert printer_id is None
    assert reason == "No active H2D printers configured"
