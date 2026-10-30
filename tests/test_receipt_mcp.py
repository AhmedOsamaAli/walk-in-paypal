"""Private receipt tools through the real MCP protocol; every API call uses an in-memory transport."""
from __future__ import annotations

import asyncio

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from mcp_server import walkin_mcp
from tests.test_mcp_server import APPROVE_URL, BASE, CAMPAIGN_ID, campaign, founders

TOKEN = "aB_9" * 8
PATH = f"/api/receipts/{TOKEN}"


def receipt(**changes) -> dict:
    return {
        "state": "Held", "explanation": "PayPal holds your $25.00.", "status": "authorized", "withdrawable": True,
        "campaign": campaign(), **changes,
    }


def test_a_prepared_pledge_hands_over_its_private_receipt_without_sending_it_to_paypal():
    api = founders(**{f"/api/campaigns/{CAMPAIGN_ID}/pledges": lambda request: httpx.Response(
        200, json={"order_id": "order1", "approve_url": APPROVE_URL, "receipt": TOKEN})})
    result = asyncio.run(api.walkin().back(CAMPAIGN_ID))
    assert f"Private receipt: {BASE}/r/{TOKEN}" in result
    assert "Anyone with it can check or withdraw this pledge" in result
    assert TOKEN not in APPROVE_URL
    assert all(TOKEN not in str(request.url) for request in api.requests)


def test_receipt_tools_read_and_withdraw_only_the_pledge_requested(monkeypatch):
    seen = []

    def endpoint(request):
        seen.append((request.method, request.url.path))
        return httpx.Response(200, json=receipt(**(
            {"state": "Withdrawn", "explanation": "PayPal released the hold.", "withdrawable": False}
            if request.method == "POST" else {}
        )))

    api = founders(**{PATH: endpoint, PATH + "/withdraw": endpoint})
    monkeypatch.setattr(walkin_mcp, "connect", api.walkin)

    async def run():
        async with create_connected_server_and_client_session(walkin_mcp.mcp) as client:
            tools = {tool.name: tool for tool in (await client.list_tools()).tools}
            status = await client.call_tool("pledge_status", {"receipt": f"{BASE}/r/{TOKEN}"})
            withdrawn = await client.call_tool("withdraw_pledge", {"receipt": TOKEN})
            return tools, status, withdrawn

    tools, status, withdrawn = asyncio.run(run())
    assert not status.isError and "Your pledge: Held" in status.content[0].text
    assert not withdrawn.isError and "Your pledge: Withdrawn" in withdrawn.content[0].text
    assert seen == [("GET", PATH), ("POST", PATH + "/withdraw")]
    assert tools["pledge_status"].annotations.readOnlyHint is True
    assert tools["withdraw_pledge"].annotations.destructiveHint is True
    assert tools["withdraw_pledge"].annotations.idempotentHint is True
    assert "explicitly asks" in tools["withdraw_pledge"].description
    assert TOKEN not in status.content[0].text + withdrawn.content[0].text


@pytest.mark.parametrize("value", ["", "../campaigns/another/withdraw", "x" * 31, "x" * 33])
def test_invalid_receipts_never_make_a_request(value):
    api = founders()
    with pytest.raises(walkin_mcp.WalkinError, match="whole private receipt"):
        asyncio.run(api.walkin().receipt(value, withdraw=True))
    assert api.requests == []


def test_receipt_error_messages_do_not_repeat_the_private_token():
    api = founders(**{PATH: lambda request: httpx.Response(418)})
    with pytest.raises(walkin_mcp.WalkinError) as failure:
        asyncio.run(api.walkin().receipt(TOKEN))
    assert TOKEN not in str(failure.value)
    assert "/api/receipts/***" in str(failure.value)


def test_an_owner_s_claim_is_never_labelled_as_survey_evidence():
    page = campaign(source="owner", survey_url=None, kit_url=None, evidence=["We would like a cafe on this block."])
    result = walkin_mcp.campaign_summary(page, CAMPAIGN_ID, founders().walkin(), {})
    assert "in the owner's words (not survey-verified)" in result
    assert "from Walk-in's survey of the block" not in result
