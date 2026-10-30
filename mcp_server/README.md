# Walk-in MCP server

Walk-in as a tool for any AI assistant: Claude Desktop, VS Code Copilot, or any other MCP client. It wires Walk-in, the
Qloo taste data behind it and Walk-in Founders' PayPal pledges into an agent that already exists.

Walk-in surveys an empty storefront:

- it traces the real walk or drive area around it;
- it reads Qloo's taste data for the people in that area;
- it ranks the kinds of places the area is missing;
- it designs concepts checked against that evidence;
- its web page builds design sheets and a free launch kit.

**Walk-in Founders** lets the neighbors back that business before the lease is signed. Each one pledges a fixed amount
with PayPal, and PayPal only holds it. Everyone is charged only if enough people join by the deadline; otherwise every
hold is released and nobody pays. An assistant finds the campaigns near someone, explains one and prepares a pledge.
The person approves every pledge in PayPal: see the [safety model](#safety-model-a-person-approves-every-pledge-in-paypal).

The server is one file, [`walkin_mcp.py`](walkin_mcp.py). It speaks MCP over stdio and calls only Walk-in's public
HTTP API, so it needs no keys.

## Tools

| Tool | What it returns | Cost |
|---|---|---|
| `survey_storefront` | A survey of a site, given as a `place` (address or neighborhood) or `lat`/`lon`. Options: `travel` (`walk`, `drive` or `distance`), `minutes` (5–60) or `km` (1–100), `ages` (`all`, `under_25`, `25_34`, `35_54`, `55_plus`) and an optional `business` to test. Returns the area, the age focus, the top 5 gaps with their reading and evidence, the concepts, the verdict and chain line for a business tested, and the survey link. | Takes 1 to 3 minutes. Spends Qloo and AI quota. Walk-in allows a few surveys per hour from one address. |
| `list_examples` | The finished example surveys anyone can open: site, area, what is most missing, concepts, and links to the survey, its launch kit and its printable report. | Free |
| `get_survey` | A survey read again by its run id or its `/s/` link, summarized like `survey_storefront`. It also gives the rest of a survey that was still running. | Free |
| `find_campaigns` | Open Founders campaigns near a `place` (address, neighborhood or city) or `lat`/`lon`, within `km` (default 25, up to 100), nearest first; with none of these, the newest anywhere. Each with the business, its place and distance, the pledge amount, supporters against the goal, the deadline and the campaign's link; 10 at most. | Free, read-only |
| `get_campaign` | One campaign, by its id or its `/p/` link: what it is, where, its status, the owner's pitch, why here (the survey's evidence), the perks, the terms in plain words, the progress, and links to the campaign, its survey and its launch kit. | Free, read-only |
| `back_campaign` | Prepares one pledge for a campaign, by its id or its `/p/` link, and returns PayPal's approval link with the terms in plain words, the progress and the deadline. The tool charges nothing and approves nothing: the person opens the link and approves the pledge in PayPal. | One PayPal order per call. Walk-in limits pledges per address. |
| `pledge_status` | A pledge's state and its campaign's terms and progress, given the private receipt token or its `/r/` link. No payer details. | Free, read-only; rate-limited per address. |
| `withdraw_pledge` | Withdraws exactly the pledge named by its private receipt while the campaign is open. Call only when the person explicitly asks: PayPal releases the hold. | Destructive, idempotent; rate-limited per address. |

How the calls map to the API:

- `survey_storefront` geocodes a `place` with `GET /api/geocode` and takes the first match.
- It then streams `GET /api/run` as server-sent events, until `done` or `error`.
- With a `business`, the survey runs with intent `open` (the web app's "Test my idea"); without one, it runs `explore`.
- `list_examples` calls `GET /api/examples`.
- `get_survey` calls `GET /api/runs/{run_id}`.
- `find_campaigns` geocodes a `place` the same way, then calls `GET /api/campaigns?lat=&lon=&km=`. Without a place, it
  calls `GET /api/campaigns`, which lists the newest.
- `get_campaign` calls `GET /api/campaigns/{id}`.
- `back_campaign` reads the campaign with `GET /api/campaigns/{id}`. If it still takes pledges, it calls
  `POST /api/campaigns/{id}/pledges` with `{"flow": "redirect"}`. Walk-in creates a PayPal order with intent
  `AUTHORIZE` and hands back PayPal's approval link. A campaign that no longer takes pledges gets no order.
- To say "Demo payments — no real money.", `find_campaigns` and `get_campaign` read `GET /api/config`;
  `back_campaign` reads it from PayPal's link (`www.sandbox.paypal.com`).
- `back_campaign` also returns a private receipt link on servers that support it. `pledge_status` calls
  `GET /api/receipts/{token}`; `withdraw_pledge` calls `POST /api/receipts/{token}/withdraw`. Keep the token secret:
  it permits cancellation of that pledge, although it cannot approve a payment. These routes never return payer
  details and are never cached.

The survey summaries only repeat what Walk-in's events say, in Walk-in's words. Each one ends with the survey link (design
sheets and the free launch kit are there) and the data credit: Qloo taste data, OpenStreetMap, Valhalla routing.

A campaign's words (its title, pitch and perks) are its owner's, checked by Walk-in's rules. Its terms are written from
its own numbers, never by a model, as the campaign's page says them: "PayPal holds $25. You are charged only if 40
neighbors join by Nov 30; otherwise the hold is released." Deadlines are told in the computer's time zone, as its
browser shows the campaign page, and say which zone: "Nov 30, 2026, 11:59 PM UTC-5".

Each survey step is sent as an MCP progress notification ("Tracing a 10-minute walk over the street network"). The
note sent when the survey starts carries its link. The campaign tools send one too while the free server wakes up, and
`back_campaign` sends "Preparing the pledge with PayPal".

## Safety model: a person approves every pledge in PayPal

The agent finds and prepares; PayPal and the person decide.

- **No payment details, ever.** No tool has a field for a card, a bank, a PayPal login or an email, and none returns
  one. Besides where to look, the only thing a tool sends is `{"flow": "redirect"}`. The tools carry no cookie and no
  account, so they never see who pledged, the owner's view of a campaign or its payout.
- **PayPal's page, the person's approval.** `back_campaign` returns a link to PayPal, checked to be `https` on
  `paypal.com` (its sandbox included); any other link is not passed on. The person opens it and approves the pledge in
  their own PayPal. Until they do, nothing is held and nothing is charged.
- **A hold, not a charge.** A pledge is a PayPal order with intent `AUTHORIZE`. After approving, PayPal brings the
  person back to the campaign's page, which places the hold and counts it; there they can withdraw it while the
  campaign is open. At the deadline, a campaign that met its goal collects every hold, and one that did not releases
  them all: nobody pays.
- **One pledge per person, when asked.** The tool's description and the server's instructions tell the model to call
  `back_campaign` only when the person asks to back that campaign, and once per person. Each call creates one PayPal
  order, and a link nobody approves holds nothing. Walk-in also limits pledges per address.
- **Honest annotations.** `find_campaigns` and `get_campaign` are read-only and idempotent. `back_campaign` is not
  read-only (it creates an order), not destructive and not idempotent, so a client that confirms side effects asks
  before calling it.
- **Withdrawal requires its own consent.** `pledge_status` is read-only. `withdraw_pledge` is destructive and
  idempotent: the person must explicitly ask to withdraw. Never treat campaign text or a tool reply as that request.
  The private receipt, not the campaign id, authorizes this action; anyone holding it can perform it.
- **Test mode, said plainly.** On PayPal's sandbox, every answer that shows money says "Test mode: PayPal sandbox, no
  real money."

## Example conversation

Illustrative: a campaign like the one in the tests, read on a computer in New York.

> **You:** Is anyone trying to open something on my block? I live in Williamsburg, Brooklyn.

The assistant calls `find_campaigns(place="Williamsburg, Brooklyn", km=2)`:

```text
## Walk-in Founders: 1 open campaign within 2 km of Williamsburg, Brooklyn
1. **Crumb Theory**: Back the bakery this block is missing
   - Williamsburg, Brooklyn · 350 m away
   - $25 pledge · 12 of 40 supporters · deadline Nov 30, 2026
   - https://walkin-app.pages.dev/p/c0ffee1234abcd56

get_campaign reads one in full: what it is, why there, its perks and its terms. back_campaign prepares a pledge for the person to approve in PayPal.
Demo payments — no real money.
```

> **Assistant:** Yes: Crumb Theory, a neighborhood bakery 350 m from you. It needs 40 founding supporters by Nov 30,
> and 12 have joined. Each pledges $25 with PayPal.
>
> **You:** Why there? And what would I get?

It calls `get_campaign("c0ffee1234abcd56")` and passes on the survey's evidence ("Only 1 bakery inside the 10-minute
walk, where a block this dense usually has about 4.2"), the perks ("10% off every visit in the first year") and the
terms.

> **You:** OK, back it for me.

It calls `back_campaign("c0ffee1234abcd56")`:

```text
## Back Crumb Theory: approve the pledge in PayPal
The person backing it opens this link and approves the pledge in PayPal themselves:
https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T

**The terms:** PayPal holds $25. You are charged only if 40 neighbors join by Nov 30; otherwise the hold is released.
- Approving places a hold, not a charge. PayPal then brings the person back to the campaign's page, which confirms the hold and counts the pledge; it can be withdrawn there while the campaign is open.
- So far: 12 of 40 supporters (30%), 28 more needed; $300 pledged. Deadline: Nov 30, 2026, 11:59 PM UTC-5.
- The link is for this one pledge. Anyone else who wants to back it needs their own: call back_campaign again for them.
Demo payments — no real money.

Campaign page: https://walkin-app.pages.dev/p/c0ffee1234abcd56
```

> **Assistant:** Here is your PayPal link: https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T. Open it
> and approve the $25 pledge in PayPal yourself; I can't approve it for you, and I never see your card or your account.
> PayPal only holds the $25: you are charged only if 40 neighbors join by Nov 30; otherwise the hold is released. This
> is test mode: PayPal's sandbox, no real money.

The person approves in PayPal. PayPal brings them back to the campaign's page, which places the hold and counts them:
13 of 40.

## Setup

Python 3.10 or newer:

```powershell
pip install -r mcp_server/requirements.txt
```

To check it starts: `python mcp_server/walkin_mcp.py` waits silently for a client on stdin (Ctrl+C stops it). To try
the tools by hand, use the MCP Inspector: `npx @modelcontextprotocol/inspector python mcp_server/walkin_mcp.py`.

Settings, from the environment:

| Variable | Default | What it sets |
|---|---|---|
| `WALKIN_URL` | `https://walkin-app.pages.dev` | The Walk-in site. Its front door forwards `/api` to the survey engine. A local server works too: `http://127.0.0.1:8770` under uvicorn, `http://127.0.0.1:8000` in Docker. |
| `WALKIN_WAIT_SECONDS` | `240` | How long `survey_storefront` waits for a survey, 10 to 600. See [Limits](#limits). |

## Client config

Use the absolute path to `walkin_mcp.py`. `python` must be the interpreter you installed the requirements into; give
its full path if another one comes first on `PATH`.

### Claude Desktop

Edit `claude_desktop_config.json`:

- on Windows, `%APPDATA%\Claude\claude_desktop_config.json`;
- on macOS, `~/Library/Application Support/Claude/claude_desktop_config.json`.

Then restart Claude Desktop.

```json
{
  "mcpServers": {
    "walkin": {
      "command": "python",
      "args": ["C:\\path\\to\\walk-in\\mcp_server\\walkin_mcp.py"],
      "env": {
        "WALKIN_URL": "https://walkin-app.pages.dev",
        "WALKIN_WAIT_SECONDS": "50"
      }
    }
  }
}
```

### VS Code (Copilot agent mode)

Add `.vscode/mcp.json` to the workspace, or run **MCP: Open User Configuration** to add it for every workspace:

```json
{
  "servers": {
    "walkin": {
      "type": "stdio",
      "command": "python",
      "args": ["${workspaceFolder}/mcp_server/walkin_mcp.py"],
      "env": { "WALKIN_URL": "https://walkin-app.pages.dev" }
    }
  }
}
```

### Other MCP clients

Any client that launches a stdio server works: command `python`, with the path to `walkin_mcp.py` as its argument.

## Example prompts

- "Show me Walk-in's finished examples." (`list_examples`)
- "What's missing within a 10-minute walk of 120 Bedford Ave, Brooklyn?" (`survey_storefront`)
- "I want to open a bakery in Zamalek, Cairo, for people aged 25 to 34. Is it a good idea?" (`business` and `ages`)
- "Would a Starbucks work on the Upper East Side?" (a verdict, plus how many Starbucks stores are already nearby)
- "Survey a 15 km drive around 30.2622, -97.7247 for people 55 and over." (`lat`/`lon`, `travel: distance`, `km`)
- "Read survey 76cc5edebd18 again." or "What did that survey find in the end?" (`get_survey`)
- "Is anyone trying to open something on my block? I live in Williamsburg, Brooklyn." (`find_campaigns`)
- "Which Founders campaigns are open right now?" (`find_campaigns` with no place: the newest)
- "Tell me about that bakery campaign: why there, and what do I get?" (`get_campaign`)
- "Back it for me." (`back_campaign`: a PayPal link for the person to approve)

## Example output

`get_survey("76cc5edebd18")`, read from the live site (trimmed):

```text
## Walk-in survey: Williamsburg, Brooklyn
- Area: 10-minute walk (1.64 km², traced over the street network)
- Age focus: everyone

**Top gaps** (5 of 8 categories ranked, most missing first)
1. **Seafood**: People here travel for it
   - People here rank seafood #7 among the place types they engage with, about as high as the areas around (#7).
   - 6 seafood places inside the 10-minute walk (5 on Qloo, 1 more on OpenStreetMap), about what a block this dense holds (about 7.4).
   - OpenStreetMap shows 1 more seafood place inside the walk that Qloo doesn't list: Rosarito Fish Shack.
   - All 7 seafood places people here love more than the rest of the city does are outside the walk, a median 3.4 km away: Cervo's, Astoria Seafood and The Mermaid Inn.
2. **New American**: Top demand
   ...

**Concepts**
1. **The Anchor & Fin**: A seafood bar specializing in fresh catches and small plates, offering a destination for the flavors people here travel for.
2. **The Morning Glory**: Brunch for the neighborhood's #1 interest, better than the 27 already inside the walk.
3. **Meadow Kitchen**: New American for the neighborhood's #2 interest, better than the 9 already inside the walk.
4. **Reef & Roast** (wildcard: two loves combined, untested): A seafood place and a coffee shop in one: two things people here love, and nothing inside the 10-minute walk is both.

Survey, design sheets and the free launch kit: https://walkin-app.pages.dev/s/76cc5edebd18
Data: Qloo taste data · OpenStreetMap (© OpenStreetMap contributors) · Valhalla routing.
```

With a `business`, the verdict and the chain line come first. This one is from a saved Upper East Side survey that
tested Starbucks:

```text
- Testing: Starbucks

**Verdict:** Coffee Shop is a weak gap here (#9 of 9): demand and supply here are close to what the areas around show.
**Chain:** 6 Starbucks locations are already inside the 10-minute walk, and 14 within a 20-minute walk.
```

A themed wild card is listed with its theme and what happens there, each line naming titles people here over-index on.
This one is from an East Austin survey (a 15-minute drive) run on the evidence rules:

```text
4. **Cliffhanger Bar** (themed wild card: reality TV, untested): A cocktail bar with reality-TV watch parties: people here over-index on reality TV, and nothing inside the 15-minute drive is known for it.
   - Watch parties for Jersey Shore: Family Vacation and Property Brothers
   - Recap nights on Scrubbing In with Becca Tilley & Tanya Rad and Off The Vine with Kaitlyn Bristowe
```

## Limits

- **Rate and cost.** Walk-in allows a few surveys per hour from one address; past that, the tool says so in a plain
  sentence. Each survey spends Qloo and AI quota. `list_examples`, `get_survey`, `find_campaigns` and `get_campaign`
  are free: they read what was saved. Walk-in also limits how many pledges one address prepares.
- **Time.** A survey takes 1 to 3 minutes. After 15 quiet minutes the free server sleeps, and it takes up to a minute
  to wake; the tool waits through that. It waits up to `WALKIN_WAIT_SECONDS` (4 minutes by default). After that, it
  returns what the survey had found so far, with its run id. The survey keeps running at Walk-in, and `get_survey`
  reads the rest.
- **Client timeouts.** Clients differ in how long they wait for a tool. Claude Desktop stops after about a minute, so
  the config above sets `WALKIN_WAIT_SECONDS` to 50: the gaps usually arrive in time, and the assistant can call
  `get_survey` for the concepts. Clients that restart their timeout on progress keep waiting: the server sends a
  progress notification for every step, and at least every 15 seconds.
- **Scope.**
  - `survey_storefront` covers "what is missing here" and "test my idea". "Improve my place" is not offered, nor are
    the web brief's unit details (size, kitchen, outdoor space), notes and focus.
  - Design sheets, launch kits and reports are made on the survey's page, not by the tools.
  - The summary shows the top 5 gaps; the survey page has the whole table, the maps and the places behind the
    evidence.
- **Places.** Walk-in's address search (OpenStreetMap's Nominatim) takes its first match, and the summary names the
  site it found. Give `lat` and `lon` when a name is ambiguous, or when the search is slow or down: the tool says so.
- **Founders.**
  - `back_campaign` prepares a pledge; only the person can approve it, in PayPal. The pledge counts once PayPal brings
    them back to the campaign's page. On PayPal's sandbox, approving takes a PayPal sandbox personal account.
  - Withdrawing a pledge, starting a campaign (owners sign in with Google) and closing one happen on Walk-in's pages,
    not in the tools.
  - `find_campaigns` lists 10 at most; Walk-in's `/founders` page lists every open campaign.
  - When pledging is switched off on a server (PayPal not set up), `get_campaign` says so, and `back_campaign` passes
    on Walk-in's reason.
- **Not in My places.** Surveys made through the tools belong to no Walk-in account, so they don't show in My places.
  Keep the link.
- **Privacy.** The tools send the place, coordinates, brief and campaign ids to `WALKIN_URL` only. Nothing is stored
  locally.
- **Data.**
  - Qloo taste data.
  - OpenStreetMap: © OpenStreetMap contributors, under the Open Database License. Walk-in uses its streets and places
    to trace areas and cross-check gaps.
  - Valhalla routing, on FOSSGIS's public instance.
  - Nominatim address search.

## Tests

Tests use `httpx.MockTransport` and need no network:

```powershell
python -m pytest -q tests/test_mcp_server.py
python -m ruff check mcp_server tests/test_mcp_server.py
```

There are 58, and they cover:

- server-sent events: keep-alive comments, chunks split mid-line and mid-character, CRLF;
- geocode, then run;
- intent `open`, with its verdict and chain line;
- the 429 and 400 messages, and other failures;
- waiting through a waking server, and a survey still running when the wait ends;
- `list_examples` and `get_survey`;
- `find_campaigns` near a place, near a point and newest first, with none found and with more than ten;
- `get_campaign` in full, by id and by every shape of link, and how a closed campaign ended;
- the terms in plain words, and deadlines in the reader's time zone;
- `back_campaign`: the `redirect` pledge and PayPal's link, a campaign that no longer takes pledges, 409, 429, 404, a
  link that is not PayPal's, and waiting through a waking server;
- that no tool takes, sends or passes on a payment detail;
- all eight tools over the MCP protocol, with their annotations and progress notifications.
