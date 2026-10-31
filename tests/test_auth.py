"""Accounts: Google ID tokens checked against Google's keys, sessions and sign-out, the device cookie and surveys it
attaches at sign-in, deleting an account, no personal data sent to Qloo or the model, the development login, the origin
check, public settings and the security headers."""
from __future__ import annotations

import asyncio
import json
import re
from datetime import timedelta

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app import auth
from app.auth import DEVICE_COOKIE, SESSION_COOKIE, GoogleKeys, KeysUnavailable, TokenError, verify_google_token
from app.config import ROOT
from app.db.tables import designs, sessions, surveys, users
from app.main import CONTENT_SECURITY_POLICY, GOOGLE_SIGN_IN, PAYPAL
from tests.account_fakes import (
    CLIENT_ID,
    Clock,
    GoogleSigner,
    configure,
    make_client,
    recording_llm,
    run_survey,
)
from tests.fakes import FakeQloo


@pytest.fixture(scope="module")
def google() -> GoogleSigner:
    return GoogleSigner()


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    return configure(monkeypatch)


def set_cookie_headers(response: httpx.Response, name: str) -> list[str]:
    return [value for value in response.headers.get_list("set-cookie") if value.startswith(f"{name}=")]


def rows(client, table, *where) -> list[dict]:
    async def read() -> list[dict]:
        async with client.app.state.db.engine.connect() as connection:
            return [dict(row) for row in (await connection.execute(select(table).where(*where))).mappings()]

    return client.portal.call(read)


def test_a_google_sign_in_checks_the_token_and_starts_a_session(google):
    google.fetches = 0
    with make_client(google=google) as client:
        assert client.get("/api/me").json() == {"user": None}
        signed = client.post("/api/auth/google", json={"credential": google.token()})
        assert signed.status_code == 200
        user = signed.json()["user"]
        assert user == {"id": user["id"], "email": "owner@example.com", "name": "Olive Owner",
                        "picture": "https://lh3.googleusercontent.com/a/photo"}
        cookie = set_cookie_headers(signed, SESSION_COOKIE)[0].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie and "secure" not in cookie
        assert f"max-age={30 * 86400}" in cookie
        assert client.get("/api/me").json() == {"user": user}

        token = client.cookies.get(SESSION_COOKIE)
        assert len(token) >= 43  # 32 random bytes, base64url
        [stored] = rows(client, sessions)
        assert stored["token_hash"] == auth.token_hash(token) and token not in str(stored)

        # Signing in again is the same user, with a new session; the keys came from Google once.
        again = client.post("/api/auth/google", json={"credential": google.token(name="Olive O.")})
        assert again.json()["user"]["id"] == user["id"] and again.json()["user"]["name"] == "Olive O."
        assert len(rows(client, sessions)) == 1  # the earlier session in this browser ended
        assert google.fetches == 1


@pytest.mark.parametrize(("claims", "reason"), [
    ({"aud": "someone-else.apps.googleusercontent.com"}, "meant for another app"),
    ({"iss": "https://evil.example.com"}, "did not come from Google"),
    ({"exp": 1_000_000_000, "iat": 999_999_000}, "expired"),
    ({"email_verified": False}, "not verified"),
    ({"email_verified": None}, "not verified"),
    ({"email": None}, "not verified"),
])
def test_tokens_that_fail_a_check_are_refused(google, claims, reason):
    with make_client(google=google) as client:
        refused = client.post("/api/auth/google", json={"credential": google.token(**claims)})
        assert refused.status_code == 400 and reason in refused.json()["detail"]
        assert not set_cookie_headers(refused, SESSION_COOKIE)
        assert client.get("/api/me").json() == {"user": None}


def test_a_token_signed_by_another_key_or_not_by_google_is_refused(google):
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = {
        "another key, same key id": google.token(key=stranger),
        "a key Google does not have": google.token(kid="unknown-key"),
        "a shared secret": google.token(key="secret" * 8, algorithm="HS256"),
        "not a token at all": "not.a.token",
    }
    with make_client(google=google) as client:
        for case, credential in forged.items():
            refused = client.post("/api/auth/google", json={"credential": credential})
            assert refused.status_code == 400, case
        assert client.get("/api/me").json() == {"user": None}


def test_google_sign_in_needs_a_client_id_and_google_s_keys(monkeypatch, google):
    configure(monkeypatch, google_client_id="")
    with make_client(google=google) as client:
        assert client.post("/api/auth/google", json={"credential": google.token()}).status_code == 503
        assert client.get("/api/config").json()["google_client_id"] is None

    def down(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    keys = GoogleKeys(http_client=httpx.AsyncClient(transport=httpx.MockTransport(down)))
    with pytest.raises(KeysUnavailable):
        asyncio.run(verify_google_token(google.token(), CLIENT_ID, keys))


def test_google_s_keys_are_kept_as_long_as_cache_control_says():
    signer = GoogleSigner(max_age=600)
    now = [1000.0]
    keys = signer.keys(clock=lambda: now[0])

    async def check(**claims) -> dict:
        return await verify_google_token(signer.token(**claims), CLIENT_ID, keys)

    async def scenario() -> None:
        assert (await check())["email"] == "owner@example.com"
        now[0] += 599
        await check()
        assert signer.fetches == 1
        now[0] += 2  # past max-age: fetched again
        await check()
        assert signer.fetches == 2
        # A key id Google never published is looked up at most once a minute.
        for _ in range(3):
            with pytest.raises(TokenError):
                await check(kid="rotated-key")
        assert signer.fetches == 2
        now[0] += 61
        with pytest.raises(TokenError):
            await check(kid="rotated-key")
        assert signer.fetches == 3

    asyncio.run(scenario())
    assert auth.cache_seconds(httpx.Headers({"cache-control": "public, max-age=100", "age": "30"})) == 70
    assert auth.cache_seconds(httpx.Headers({})) == auth.DEFAULT_KEY_AGE


def test_sign_out_ends_the_session_for_good(google):
    with make_client(google=google) as client:
        client.post("/api/auth/google", json={"credential": google.token()})
        token = client.cookies.get(SESSION_COOKIE)
        out = client.post("/api/auth/logout")
        assert out.status_code == 204
        cleared = set_cookie_headers(out, SESSION_COOKIE)[0].lower()
        assert 'walkin_session=""' in cleared or "max-age=0" in cleared
        assert rows(client, sessions) == []
        client.cookies.set(SESSION_COOKIE, token)  # the old cookie, replayed
        assert client.get("/api/me").json() == {"user": None}
        assert client.get("/api/me/places").status_code == 401
        assert client.post("/api/auth/logout").status_code == 204  # signed out already: still fine


def test_a_session_renews_at_most_once_a_day_and_ends_after_30_idle_days(google):
    clock = Clock()
    with make_client(google=google, clock=clock) as client:
        client.post("/api/auth/google", json={"credential": google.token()})
        [first] = rows(client, sessions)
        assert first["expires_at"] == clock.now + timedelta(days=30)

        clock.advance(hours=20)
        same_day = client.get("/api/me")
        assert same_day.json()["user"] and not set_cookie_headers(same_day, SESSION_COOKIE)
        assert rows(client, sessions)[0]["expires_at"] == first["expires_at"]

        clock.advance(hours=5)  # over a day since the cookie was set
        renewed = client.get("/api/me")
        assert f"max-age={30 * 86400}" in set_cookie_headers(renewed, SESSION_COOKIE)[0].lower()
        assert rows(client, sessions)[0]["expires_at"] == clock.now + timedelta(days=30)

        clock.advance(days=31)
        expired = client.get("/api/me")
        assert expired.json() == {"user": None}
        assert set_cookie_headers(expired, SESSION_COOKIE) and rows(client, sessions) == []


def test_surveys_run_in_this_browser_are_kept_at_sign_in(google):
    with make_client(google=google) as client:
        first = client.get("/api/run", params={"lat": 40.0, "lon": -73.0, "label": "Before signing in"})
        cookie = set_cookie_headers(first, DEVICE_COOKIE)[0].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie and f"max-age={400 * 86400}" in cookie
        device = client.cookies.get(DEVICE_COOKIE)
        assert len(device) == 32 and int(device, 16) >= 0
        before = rows(client, surveys)
        assert [(row["device_id"], row["user_id"]) for row in before] == [(device, None)]

        # Another browser's survey is not this user's.
        with make_client(google=google) as other:
            run_survey(other)

        user = client.post("/api/auth/google", json={"credential": google.token()}).json()["user"]
        signed_in = client.get("/api/run", params={"lat": 40.0, "lon": -73.0, "label": "Signed in"})
        assert not set_cookie_headers(signed_in, DEVICE_COOKIE)  # the browser keeps its id
        places = client.get("/api/me/places").json()
        assert [survey["label"] for survey in places["surveys"]] == ["Signed in", "Before signing in"]
        newest = places["surveys"][0]
        assert newest == {
            "id": newest["id"], "label": "Signed in", "intent": "explore", "status": "complete",
            "created_at": newest["created_at"], "headline": newest["headline"], "url": f"/s/{newest['id']}",
        }
        assert newest["headline"] and newest["created_at"].endswith("Z")
        assert places["kits"] == []
        owners = [row["user_id"] for row in rows(client, surveys)]
        assert owners.count(user["id"]) == 2 and owners.count(None) == 1


def test_deleting_an_account_removes_the_user_their_sessions_and_their_surveys(google):
    with make_client(google=google) as client:
        before = run_survey(client, label="Before signing in")
        with make_client(google=google) as other:  # someone else, in another browser
            theirs = run_survey(other, label="Someone else")
        user = client.post("/api/auth/google", json={"credential": google.token()}).json()["user"]
        mine = run_survey(client, label="Signed in")
        assert client.post("/api/design", json={"run_id": mine, "index": 0}).status_code == 200
        with make_client(google=google) as phone:  # the same person, signed in on another device
            assert phone.post("/api/auth/google", json={"credential": google.token()}).json()["user"] == user
            assert len(rows(client, sessions)) == 2 and rows(client, designs)

            refused = client.delete("/api/me", headers={"origin": "https://evil.example.com"})
            assert refused.status_code == 403 and len(rows(client, users)) == 1
            deleted = client.delete("/api/me")
            assert deleted.status_code == 204 and deleted.content == b""
            for name in (SESSION_COOKIE, DEVICE_COOKIE):  # this browser forgets both
                cleared = set_cookie_headers(deleted, name)[0].lower()
                assert f'{name}=""' in cleared or "max-age=0" in cleared
            assert phone.get("/api/me").json() == {"user": None}  # signed out everywhere

        assert rows(client, users) == [] and rows(client, sessions) == [] and rows(client, designs) == []
        assert [row["id"] for row in rows(client, surveys)] == [theirs]
        for run_id in (before, mine):
            assert client.get(f"/api/runs/{run_id}").status_code == 404
            assert client.post("/api/design", json={"run_id": run_id, "index": 0}).status_code == 404  # not in memory
        assert client.get("/api/me").json() == {"user": None}
        assert client.delete("/api/me").status_code == 401

        # Signing in again starts a new, empty account.
        again = client.post("/api/auth/google", json={"credential": google.token()}).json()["user"]
        assert again["id"] != user["id"] and client.get("/api/me/places").json()["surveys"] == []


def test_a_user_is_only_what_sign_in_needs(google):
    with make_client(google=google) as client:
        client.post("/api/auth/google", json={"credential": google.token(locale="en", hd="example.com")})
        [user] = rows(client, users)
        assert set(user) == {"id", "subject", "email", "name", "picture", "created_at", "updated_at"}
        assert user["subject"] == "google:1000001"
        [session] = rows(client, sessions)
        assert set(session) == {"token_hash", "user_id", "created_at", "expires_at"}


def test_no_personal_data_reaches_qloo_or_the_model(google):
    qloo, sent = FakeQloo(), []
    private = {"email": "zebulon.quill@example.org", "name": "Zebulon Quill", "sub": "777000111"}
    with make_client(google=google, llm=recording_llm(sent), qloo=qloo) as client:
        user = client.post("/api/auth/google", json={"credential": google.token(**private)}).json()["user"]
        run_id = run_survey(client, label="Signed-in corner", notes="no alcohol")
        assert client.post("/api/design", json={"run_id": run_id, "index": 0}).status_code == 200
        assert [row["user_id"] for row in rows(client, surveys)] == [user["id"]]
    assert sent and qloo.requests  # the survey did ask both
    outgoing = json.dumps(sent) + json.dumps(qloo.requests, default=str)
    for value in (*private.values(), "Zebulon", "Quill", "zebulon", user["id"]):
        assert value not in outgoing


def test_the_development_login_exists_only_in_development(monkeypatch):
    with make_client() as client:
        signed = client.post("/api/auth/dev", json={"email": "Tester@Example.com", "name": "Tester"})
        assert signed.status_code == 200 and signed.json()["user"]["email"] == "tester@example.com"
        assert client.get("/api/config").json()["dev_login"] is True
        assert client.post("/api/auth/dev", json={"email": "not an email", "name": ""}).status_code == 400

    for changes in ({"auth_dev_login": False}, {"public_url": "https://walk-in.example.com"}):
        configure(monkeypatch, **changes)
        with make_client(base_url="https://testserver") as client:
            assert client.post("/api/auth/dev", json={"email": "tester@example.com"}).status_code == 404
            assert client.get("/api/config").json()["dev_login"] is False


def test_cookies_are_secure_on_https(monkeypatch, google):
    configure(monkeypatch, public_url="https://walk-in.example.com")
    with make_client(google=google, base_url="https://walk-in.example.com") as client:
        signed = client.post("/api/auth/google", json={"credential": google.token()})
        assert "secure" in set_cookie_headers(signed, SESSION_COOKIE)[0].lower()
        assert client.get("/api/me").json()["user"]
    configure(monkeypatch)
    with make_client() as client:
        behind_proxy = client.post("/api/auth/dev", json={"email": "a@example.com"}, headers={"x-forwarded-proto": "https"})
        assert "secure" in set_cookie_headers(behind_proxy, SESSION_COOKIE)[0].lower()


def test_unsafe_api_calls_from_other_sites_are_refused(monkeypatch):
    configure(monkeypatch, public_url="https://walk-in.example.com", allowed_origins=("https://preview.example.com",),
              auth_dev_login=False)
    with make_client() as client:
        def post(origin: str | None, path: str = "/api/auth/logout") -> httpx.Response:
            return client.post(path, headers={"origin": origin} if origin else {})

        refusal = "This request came from a page that may not use this API."
        assert post("https://evil.example.com").status_code == 403
        assert post("https://evil.example.com").json() == {"detail": refusal}
        assert post("null").status_code == 403
        assert post("http://localhost:5173").status_code == 403  # the hosted site trusts no dev server
        assert post("https://walk-in.example.com").status_code == 204
        assert post("https://Walk-In.example.com/").status_code == 204
        assert post("https://preview.example.com").status_code == 204
        assert post("http://testserver").status_code == 204  # the server's own origin
        assert post(None).status_code == 204
        assert client.get("/api/me", headers={"origin": "https://evil.example.com"}).status_code == 200
        assert "Content-Security-Policy" in post("https://evil.example.com").headers
        assert client.delete("/api/me", headers={"origin": "https://evil.example.com"}).json() == {"detail": refusal}

    configure(monkeypatch)  # development: the Vite dev server may call the API
    with make_client() as client:
        for origin in ("http://localhost:5173", "http://127.0.0.1:5173"):
            assert client.post("/api/auth/logout", headers={"origin": origin}).status_code == 204


def test_config_tells_the_page_how_to_sign_in(monkeypatch):
    with make_client() as client:
        config = client.get("/api/config").json()
        assert (config["google_client_id"], config["dev_login"]) == (CLIENT_ID, True)
    configure(monkeypatch, google_client_id="", auth_dev_login=False)
    with make_client() as client:
        config = client.get("/api/config").json()
        assert (config["google_client_id"], config["dev_login"]) == (None, False)


def test_sign_ins_are_rate_limited():
    with make_client() as client:
        client.app.state.auth_limiter.limit = 2
        assert [client.post("/api/auth/dev", json={"email": "a@example.com"}).status_code for _ in range(3)] == [200, 200, 429]


def test_pages_get_the_security_headers_google_sign_in_needs():
    with make_client() as client:
        for path in ("/", "/me", "/privacy", "/s/some-survey", "/api/health"):
            response = client.get(path)
            assert response.status_code == 200, path
            assert response.headers["cross-origin-opener-policy"] == "same-origin-allow-popups"
            policy = dict(part.strip().split(" ", 1) for part in response.headers["content-security-policy"].split(";"))
            assert "https://accounts.google.com/gsi/client" in policy["script-src"]
            assert "https://accounts.google.com/gsi/style" in policy["style-src"]
            for directive in ("connect-src", "frame-src"):
                assert "https://accounts.google.com/gsi/" in policy[directive]
            assert policy["frame-ancestors"] == "'none'" and "'unsafe-inline'" not in policy["script-src"]
        assert client.get("/me").headers["content-type"].startswith("text/html")
        assert client.get("/privacy").headers["content-type"].startswith("text/html")


def test_the_app_gets_one_policy_wherever_it_is_served():
    """The server, Cloudflare Pages (public/_headers) and vite preview send the same policy: no remote scripts or fonts
    beyond Google's sign-in and PayPal's JavaScript SDK (docs/founders/CONTRACT.md)."""
    frontend = ROOT / "frontend"
    headers = (frontend / "public" / "_headers").read_text(encoding="utf-8").splitlines()
    pages = next(line.split(":", 1)[1].strip() for line in headers if line.strip().startswith("Content-Security-Policy:"))
    vite = (frontend / "vite.config.ts").read_text(encoding="utf-8")
    listed = re.search(r"const CONTENT_SECURITY_POLICY = \[(.*?)\]\.join", vite, re.DOTALL)
    constants = dict(re.findall(r'const (\w+) = ["`]([^"`]*)["`];', vite))

    def expand(item: str) -> str:
        return re.sub(r"\$\{(\w+)\}", lambda name: constants.get(name[1], name[0]), item)

    preview = "; ".join(expand(item) for item in re.findall(r'["`](.+?)["`],', listed[1]))
    assert pages == preview == CONTENT_SECURITY_POLICY
    policy = dict(part.strip().split(" ", 1) for part in CONTENT_SECURITY_POLICY.split(";"))
    assert policy["script-src"] == f"'self' {GOOGLE_SIGN_IN}client {PAYPAL}" and policy["font-src"] == "'self'"
    assert policy["connect-src"] == f"'self' {GOOGLE_SIGN_IN} {PAYPAL} https://tiles.openfreemap.org"
    assert policy["frame-src"] == f"{GOOGLE_SIGN_IN} {PAYPAL}"
    assert policy["worker-src"] == "'self'"  # The optional map's worker is a local hashed asset, never a blob or remote script.
    assert PAYPAL == "https://www.sandbox.paypal.com https://www.paypal.com"
