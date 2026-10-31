"""The composition root: builds the services from the settings, and the app around them: its lifespan (database,
stores, limits, background work), its middleware (security headers, cookies, cache policy, gzip), its routes
(app.routes) and the web app's static files.

Layers, from the outside in: routes (app.routes) -> the survey (app.survey) -> the engine and scoring (app.engine,
app.scoring) -> clients of the outside world (Qloo, Valhalla, Overpass, Nominatim, the AI chain, PayPal: app.services)
and storage (app.db, the disk caches). docs/architecture.md draws them. Walk-in Founders (campaigns, pledges,
settlement and payouts with PayPal) plugs in through app.payments.founders.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, cache_policy
from .answers import AnswerCache
from .catchment import CatchmentService
from .config import ROOT, settings
from .db import AccountStore, Database, KitStore, SurveyStore
from .db.campaigns import CampaignStore
from .db.tables import utcnow
from .geocode import Geocoder
from .keepawake import keep_awake
from .kits import KitBuilder
from .osm import OsmClient
from .payments import founders
from .payments.paypal import PayPalClient
from .providers import build_llm
from .qloo import QlooClient
from .ratelimit import DailyBudget, RateLimiter
from .response_cache import GZIP_LEVEL, GZIP_MIN_BYTES, ResponseCache
from .routes import account, examples, kits, meta, places, surveys
from .routes.meta import PRESETS  # noqa: F401  (scripts read the preset sites from here)
from .services import Services
from .survey import snapshot
from .survey.models import LiveRuns, RunStore

log = logging.getLogger("walkin")

# Per client and hour (app.ratelimit), so one visitor cannot spend the free quotas everyone shares.
RUNS_PER_HOUR = 20
DESIGNS_PER_HOUR = 40
MAP_REQUESTS_PER_HOUR = 200
SIGN_INS_PER_HOUR = 30
KITS_PER_HOUR = 12
# On shutdown, running surveys get this many seconds to finish before they are stopped and saved as failed.
SHUTDOWN_GRACE_S = 10
# create_app's settlement period when none is given: SETTLE_EVERY_S, read when the app starts.
SETTLE_FROM_SETTINGS = -1.0

# Sign in with Google loads its script, button frame and styles from accounts.google.com/gsi
# (developers.google.com/identity/gsi/web/guides/get-google-api-clientid#content_security_policy). PayPal's JavaScript
# SDK (v6) loads its script and checkout frames from paypal.com, the sandbox's or the live one (docs/founders/CONTRACT.md).
# The same policy as frontend/public/_headers (Cloudflare Pages) and vite.config.ts (preview).
GOOGLE_SIGN_IN = "https://accounts.google.com/gsi/"
PAYPAL = "https://www.sandbox.paypal.com https://www.paypal.com"
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    f"script-src 'self' {GOOGLE_SIGN_IN}client {PAYPAL}",
    f"style-src 'self' 'unsafe-inline' {GOOGLE_SIGN_IN}style",
    "img-src 'self' data: https:",
    "font-src 'self'",
    f"connect-src 'self' {GOOGLE_SIGN_IN} {PAYPAL} https://tiles.openfreemap.org",
    "worker-src 'self'",
    f"frame-src {GOOGLE_SIGN_IN} {PAYPAL}",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])
# FastAPI's interactive API docs load Swagger UI and ReDoc from jsDelivr, with one inline bootstrap script.
DOCS_POLICY = "; ".join([
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "worker-src blob:",
    "frame-ancestors 'none'",
])


def default_services() -> Services:
    paypal = None
    if settings.paypal_enabled:
        paypal = PayPalClient(settings.paypal_client_id, settings.paypal_client_secret, settings.paypal_api_base)
    return Services(
        qloo=QlooClient(settings.qloo_api_key, settings.qloo_base_url, settings.cache_dir,
                        max_concurrency=settings.qloo_concurrency),
        walker=CatchmentService(settings.walk_cache_dir),
        llm=build_llm(settings),
        geocoder=Geocoder(),
        answers=AnswerCache(settings.agent_cache_dir, enabled=settings.agent_cache),
        osm=OsmClient(settings.cache_dir.parent / "osm"),
        paypal=paypal,
    )


class RevalidatingStaticFiles(StaticFiles):
    """Static files that browsers must revalidate, so a redeploy is picked up immediately.

    Vite's hashed bundles under assets/ never change, so those are cached for a year.
    """

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        immutable = path.startswith("assets/") and response.status_code == 200
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if immutable else "no-cache"
        return response


WEB_ROOT = ROOT / "frontend" / "dist"  # the React build: npm run build in frontend/


def create_app(
    services_factory: Callable[[], Services] = default_services, database_url: str | None = None,
    web_root: Path | None = None, settle_every: float | None = SETTLE_FROM_SETTINGS,
) -> FastAPI:
    """The app. `database_url` overrides DATABASE_URL; tests give each app a SQLite file of its own. `web_root` overrides
    the React build it serves (WEB_ROOT); without its index.html, the app serves the API only. `settle_every` is the
    settlement loop's period in seconds (SETTLE_EVERY_S unless given); None or 0 turns the loop off."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = Database(database_url or settings.database_url)
        await database.migrate()
        survey_store = SurveyStore(database)
        # A survey behind a campaign stays, with its kit, whoever ran it: the campaign's page links to both.
        backed = await CampaignStore(database).survey_ids()
        await survey_store.purge(settings.survey_retention_days, keep=(*settings.examples, *backed))
        accounts = AccountStore(database)
        await accounts.purge_sessions(utcnow())
        services = services_factory()
        app.state.services = services
        app.state.db = database
        app.state.surveys = survey_store
        app.state.accounts = accounts
        app.state.runs = RunStore(settings.run_store_size, load=partial(snapshot.restore, survey_store))
        app.state.live = LiveRuns()
        app.state.kits = KitStore(database)
        app.state.builder = KitBuilder(app.state.kits, app.state.runs, survey_store, services)
        app.state.run_limiter = RateLimiter(RUNS_PER_HOUR, 3600)
        app.state.design_limiter = RateLimiter(DESIGNS_PER_HOUR, 3600)
        app.state.map_limiter = RateLimiter(MAP_REQUESTS_PER_HOUR, 3600)
        app.state.auth_limiter = RateLimiter(SIGN_INS_PER_HOUR, 3600)
        app.state.kit_limiter = RateLimiter(KITS_PER_HOUR, 3600)
        app.state.kit_budget = DailyBudget(settings.kit_daily_limit)
        app.state.responses = ResponseCache(settings.response_cache_mb * 1024 * 1024)
        await app.state.builder.resume()  # kits a restart cut off are built again
        keeper = asyncio.create_task(keep_awake(settings.keep_awake_url)) if settings.keep_awake_url else None
        # The examples come into memory in the background: the server answers (its health check first) meanwhile.
        app.state.warmup = asyncio.create_task(examples.warm_up(app.state))
        every = settings.settle_every if settle_every == SETTLE_FROM_SETTINGS else settle_every
        try:
            async with founders.running(app, every):
                yield
        finally:
            background = [task for task in (keeper, app.state.warmup, *app.state.examples_reading.values()) if task]
            for task in background:
                task.cancel()
            if background:
                await asyncio.wait(background)
            await app.state.live.stop(SHUTDOWN_GRACE_S)
            await app.state.builder.stop()  # unfinished kits stay "building", and the next start builds them
            await services.aclose()
            await database.dispose()

    app = FastAPI(
        title="Walk-in",
        version="1.0.0",
        description=(
            "Reads Qloo taste data for the area people can reach from the door, on foot or by car, ranks what the block is "
            "missing and designs the business. GET /api/run streams a survey as server-sent events, and GET /api/runs/{id} "
            "returns its events again; the other endpoints are JSON. POST /api/kits builds a concept's launch kit (free). "
            "Signing in with Google keeps surveys and kits in My places. Walk-in Founders: an owner starts a campaign from "
            "a launch kit (POST /api/campaigns), and neighbors back it with PayPal (GET /api/campaigns finds them): PayPal "
            "only holds each pledge, and everyone is charged only if enough neighbors join by the deadline."
        ),
        lifespan=lifespan,
    )
    app.state.now = utcnow  # the app's clock; tests move it
    app.state.examples_cache = {}  # GET /api/examples, by the ids configured
    app.state.examples_reading = {}  # the examples list being read, by the ids configured
    app.state.origin_exempt = frozenset()  # API paths called from elsewhere than a page (founders.CALLBACKS)

    # JSON travels four times smaller from Render to the front door. Added before the security middleware, so it sits
    # inside it and sees each response whole (bodies under GZIP_MIN_BYTES go as they are). Survey streams are never
    # compressed (Starlette leaves text/event-stream alone), so each event still goes out as soon as it is made.
    app.add_middleware(GZipMiddleware, minimum_size=GZIP_MIN_BYTES, compresslevel=GZIP_LEVEL)

    @app.middleware("http")
    async def security(request: Request, call_next):
        """Turns away unsafe API calls from other sites' pages, sets the cookies endpoints queued, and the headers.
        PayPal's webhook and the scheduled settlement are no page's calls: each proves itself otherwise."""
        if request.url.path in app.state.origin_exempt or auth.origin_allowed(request):
            response = await call_next(request)
            auth.apply_cookies(request, response)
        else:
            response = JSONResponse({"detail": "This request came from a page that may not use this API."}, 403)
        docs = request.url.path in ("/docs", "/redoc")
        response.headers.setdefault("Content-Security-Policy", DOCS_POLICY if docs else CONTENT_SECURITY_POLICY)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        private_receipt = request.url.path.startswith(("/r/", "/api/receipts/"))
        response.headers.setdefault("Referrer-Policy", "no-referrer" if private_receipt else "strict-origin-when-cross-origin")
        # Google's sign-in opens a popup when the browser has no FedCM, and the popup must be able to answer this page.
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin-allow-popups")
        cache_policy.guard(request, response)
        return response

    for routes in (meta, surveys, places, account, kits, examples):
        app.include_router(routes.router)
    founders.install(app)
    root = web_root or WEB_ROOT
    if not (root / "index.html").exists():
        log.warning("frontend/dist is missing (npm run build in frontend/): serving the API only")
        return app

    # Shared links to a survey (/s), a launch kit (/k) and its printable dossier, My places (/me), the examples
    # (/examples), the privacy note (/privacy), a campaign (/p), the open campaigns (/founders) and a pledge's private
    # receipt (/r) are pages of the web app.
    @app.get("/s/{key}", include_in_schema=False)
    @app.get("/k/{key}", include_in_schema=False)
    @app.get("/k/{key}/dossier", include_in_schema=False)
    @app.get("/me", include_in_schema=False)
    @app.get("/examples", include_in_schema=False)
    @app.get("/privacy", include_in_schema=False)
    async def shared_page() -> FileResponse:
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    for path in founders.PAGES:
        app.add_api_route(path, shared_page, include_in_schema=False)
    app.mount("/", RevalidatingStaticFiles(directory=root, html=True), name="web")
    return app


app = create_app()
