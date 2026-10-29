# Testing Walk-in Founders

This page walks a judge through Walk-in Founders on the live site: start a campaign as an owner, pledge as a neighbor
with PayPal's sandbox, withdraw, close and collect, cancel, and back a campaign from an AI assistant. The web path takes
about 10 minutes; the assistant path needs Python and an MCP client. How it works is in the [README](../../README.md),
the product rules and API in [CONTRACT.md](CONTRACT.md).

Live: https://walkin-app.pages.dev (pages `/founders`, `/examples`, `/p/{id}` for a campaign, `/k/{token}` for a
launch kit).

Checked against PayPal's sandbox on Oct 28, 2026. On the live site: pledges through PayPal's button, and a campaign
funded by three sandbox buyers, closed by its owner, collected and paid out, with each of PayPal's webhooks checked with
PayPal. On a local server running the same code: a whole campaign from the owner's draft to the payout, with a pledge
withdrawn on the way.

## Before you start

- **Test mode.** Founders runs on PayPal's sandbox, PayPal's test environment. Its accounts are test accounts with test
  balances: no real money moves, and nothing reaches a card or a bank. Every screen that shows money says so: "Test
  mode: PayPal sandbox, no real money." `GET /api/config` says `"environment": "sandbox"`, and the MCP tools say it in
  every answer that shows money. Never use a real card or a real PayPal account here.
- **Logins.**
  - Neighbors: PayPal sandbox personal accounts. Judges find three in the submission's testing instructions on
    Devpost (they are kept out of this public page, so nobody can lock them). To make your own: log in at
    [developer.paypal.com](https://developer.paypal.com/dashboard/), open **Testing Tools > Sandbox Accounts**, press
    **Create account**, and choose **Personal** and **United States**; **View/edit account** shows its email and
    password. A goal counts different PayPal accounts, and the smallest goal is 3, so a funded campaign (section 4)
    takes three.
  - Owner: your own Google account. Walk-in keeps its email, name and picture link to show that you are signed in;
    deleting your account in My places removes them.
- **The wake.** The backend runs on Render's free tier and sleeps when idle. The first visit after a quiet spell takes
  about 40 seconds: the page says "Waking the survey engine" and tries again by itself. The examples' pages still open
  meanwhile, from the Cloudflare front door.
- **Two windows.** Be the owner in your normal window, signed in. Be the neighbor in a private (incognito) window,
  signed out: on your own campaign's page you see a preview instead of PayPal's button.
- **Pop-ups.** PayPal opens in a pop-up, or in its own modal where pop-ups are blocked. A content blocker that blocks
  paypal.com stops the button; the page then says "PayPal could not load".

## 1. Start a campaign (owner)

1. Open https://walkin-app.pages.dev/examples. Pick a storefront, such as Milwaukee Avenue, Logan Square, Chicago,
   and press **Launch kit** under it.
2. Choose the kit's **Founders** tab (or add `#founders` to the address). Signed out, it says "Sign in with Google to
   start one". Sign in with Google.
3. **Step 1, your terms.** Fill in:
   - Each neighbor pledges: `5`
   - Neighbors needed: `3`
   - Deadline: any day 1 to 27 days away (the hint shows your time zone)
   - PayPal email for the money: a sandbox account's email, such as the first sandbox neighbor's, so the test payout has
     somewhere to go
   - Founding-supporter perk (optional): `10% off every visit in the first year`

   Try a term the rules refuse: Neighbors needed `2` shows "Pick a goal from 3 to 500 supporters." Set it back to `3`.
   Note the yellow "Test mode" line under the terms.
4. Press **Draft with AI**. "Writing the page from the evidence" shows, and Step 2 appears: a title, a pitch, the perks
   (yours first, word for word), "How it works · the server's own words" and "Beside the PayPal button, neighbors
   read". Your numbers are unchanged: the AI writes words, never the amount, the goal, the deadline or the perk. When no
   model answers within 30 seconds, the evidence rules write the draft instead, and the page looks the same.
5. **Try the rules.** Each of these comes back under "Not published yet" when you press **Publish the campaign**, and
   nothing is published:
   - Change the title to `The best place on the block`: "The title says "best", which nothing measured proves."
   - Change a perk to `A $5 pledge`: "Perk 2 only restates the pledge: say what founding supporters get beyond it." (the
     number is the perk's place in the list).

   Put your own title and perks back.
6. Press **Publish the campaign**. The campaign's page opens at `/p/{id}` with your panel: "Your campaign", "Share it,
   and watch it fill", "No pledges yet", the link under "Share this page", and "The window poster, with its QR code to
   this page".
7. Optional:
   - The kit's **Poster** tab now carries the campaign's line beside a QR code to it: "Back it before it opens: pledge
     $5, charged only if 3 neighbors join by {date}."
   - **My places** in the top bar lists your campaign.
   - Starting a second campaign for the same kit sends you to the first ("You already have an open campaign for this
     kit").

## 2. Pledge as a neighbor

1. Copy the link under "Share this page" and open it in a private window.
2. Read the neighbor's view: the business and the place; "Why this, why here" (up to three lines from the survey, with a
   link to it); "What founding supporters get"; "How it works"; "The plan", with links to the launch kit and the survey.
   The card beside it reads "0 of 3 neighbors", "Held by PayPal so far: $0", "Pledge $5 with PayPal" and the terms: "PayPal holds $5. You are
   charged only if 3 neighbors join by {date}; otherwise the hold is released.", then PayPal's button and the Test
   mode line.
3. Press PayPal's button. Log in as the first sandbox neighbor and approve. Approving
   places a hold, not a charge: the order asks PayPal for a "Continue" button rather than "Pay Now".
4. Back on the page: "Placing the hold with PayPal…", then "Your pledge is held. Thank you for backing {name}. PayPal
   holds your $5. You are charged only if 3 neighbors join by {date}; otherwise the hold is released and you pay
   nothing." The count reads 1 of 3, and "Held by PayPal so far" $5.
5. In the owner's window, reload the campaign's page: under Pledges, "Held 1".
6. To see a pledge abandoned: press PayPal's button and close PayPal without approving. The page says "You left PayPal
   before approving, so nothing is held."

At PayPal: pressing the button made the server create an Orders v2 order with intent `AUTHORIZE` for $5 (its
`custom_id` is the pledge's id). Approving let the server authorize it: a hold on the buyer's sandbox account, valid for
29 days. Nothing is captured yet.

## 3. Withdraw

1. In the private window, press **Withdraw my pledge**, then confirm. The dialog says "PayPal releases the hold on your
   $5, so nothing is charged."
2. The page says "Your pledge is withdrawn: PayPal released the hold, so nothing is charged." The count goes back to 0,
   and the owner's panel shows "Withdrawn 1".

At PayPal: the server voided the authorization. Withdrawing works while the campaign is open, from the browser that
pledged: the page keeps the pledge's PayPal order id there, so it is gone once the private window closes.

## 4. Fund it, close it, collect and pay out (owner)

This needs three different sandbox buyers: one PayPal account counts once, however many times it pledges.

1. Pledge three times, with a different sandbox neighbor each time (three
   different PayPal accounts). Between pledges, close every private window (they share one session while any is open)
   or use another browser: the page remembers the pledge made from a browser and shows it in place of PayPal's button.
   The count reaches 3 of 3 and reads "Goal met"; PayPal holds $15.
2. In the owner's window, reload. The panel says "The goal is met" and offers **Close and collect**. Press it, and the
   dialog says "PayPal collects every held pledge now: 3 neighbors at $5 each. The total, after PayPal's fees, goes to
   {your masked email}. This can't be undone." Confirm.
3. "Closing and settling with PayPal…", then "Closed. The settlement is below." The status reads Collected, the card
   "Collected $15", and the pledges "Collected 3".
4. The payout reads "$X on its way to {masked email}", where $X is the total after PayPal's fees, then "$X paid to
   {masked email}" once PayPal reports it, by webhook or at the next settlement run (every 3 hours).
5. In a neighbor's window, the card says "Pledges are closed. It met its goal, and every pledge was collected."

At PayPal: one capture per hold (a hold older than PayPal's 3-day honor period is reauthorized first; on a new
campaign none is), each capture's net from its `seller_receivable_breakdown`, then one Payouts batch whose
`sender_batch_id` is the campaign's id. A payout to an email without a sandbox account cannot be paid, and does not
show as paid.

## 5. Cancel (owner)

1. Start a campaign from another example's kit (one open campaign per owner per kit), and pledge once as a neighbor.
2. As the owner, press **Cancel and release every hold**. The dialog says "Every hold is released and nobody pays.
   This can't be undone." Confirm.
3. The panel says "Cancelled. Every hold is released: nobody pays." and "Released 1". A neighbor reads "The owner
   cancelled it, so every hold was released: nobody paid."

While a campaign is short of its goal, **Close and collect** is not offered; once the goal is met, only **Close and
collect** is. At the deadline, a campaign short of its goal expires and every hold is voided. The free server's
settlement runs every 3 hours, so this happens within about 3 hours of the deadline; until then the owner sees
**Settle now**, which settles at once.

## 6. From an AI assistant (MCP)

Walk-in's MCP server lets an assistant find a campaign, explain it and prepare a pledge. You approve the pledge in
PayPal; the assistant never sees a card, a login or an email.

1. Clone the repository, install Python 3.10 or newer, then the server's requirements:

   ```powershell
   git clone https://github.com/AhmedOsamaAli/walk-in-paypal
   pip install -r walk-in-paypal/mcp_server/requirements.txt
   ```

2. Point Claude Desktop at it. Edit `claude_desktop_config.json` (on Windows `%APPDATA%\Claude\`, on macOS
   `~/Library/Application Support/Claude/`) and restart Claude Desktop. Use the absolute path to `walkin_mcp.py`, and
   set `WALKIN_URL` to the Founders site:

   ```json
   {
     "mcpServers": {
       "walkin": {
         "command": "python",
         "args": ["C:\\path\\to\\walk-in-paypal\\mcp_server\\walkin_mcp.py"],
         "env": {
           "WALKIN_URL": "https://walkin-app.pages.dev",
           "WALKIN_WAIT_SECONDS": "50"
         }
       }
     }
   }
   ```

   `python` must be the interpreter you installed the requirements into; give its full path if another one comes
   first. In VS Code (Copilot agent mode), add `.vscode/mcp.json` to the cloned folder:

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

   To try the tools by hand instead, run the MCP Inspector from the cloned folder:

   ```powershell
   npx @modelcontextprotocol/inspector -e WALKIN_URL=https://walkin-app.pages.dev python mcp_server/walkin_mcp.py
   ```

3. Ask, in turn:
   - "Which Walk-in Founders campaigns are open right now?" (`find_campaigns`, the newest), or "Is anyone trying to
     open something near Logan Square, Chicago?" (`find_campaigns` near a place).
   - "Tell me about the first one: why there, and what do I get?" (`get_campaign`: the survey's evidence, the perks,
     the terms in plain words).
   - "Back it for me." (`back_campaign`).
4. The assistant answers with PayPal's sandbox link (`https://www.sandbox.paypal.com/…`), the terms, the progress, the
   deadline and "Test mode: PayPal sandbox, no real money." Open the link, log in as a sandbox buyer and approve.
5. PayPal brings you back to the campaign's page (`/p/{id}?pledge=…`), which says "Placing your hold with PayPal…",
   then "Your pledge is held". Cancelling in PayPal instead brings you back with "You left PayPal before approving, so
   nothing was held."

What to check: the assistant never asks for a card, a PayPal login or an email; the link is PayPal's own; nothing is
held until you approve in PayPal; and the terms it quotes match the campaign's page. The first call after a quiet
spell may wait about 40 seconds while the server wakes; the tools send progress meanwhile.

## 7. Without a browser: the public API

```bash
curl https://walkin-app.pages.dev/api/config
curl https://walkin-app.pages.dev/api/campaigns
curl https://walkin-app.pages.dev/api/campaigns/{id}
```

`/api/config` says whether pledging is on (`"paypal": {"enabled": true, "environment": "sandbox", …}`). The campaign
answers carry `Cache-Control: no-store`: they change with every pledge. The endpoints are in [CONTRACT.md](CONTRACT.md).

## What each step does at PayPal

| You | The server calls PayPal | Code |
|---|---|---|
| Press PayPal's button, or ask an assistant to back a campaign | `POST /v2/checkout/orders` (intent `AUTHORIZE`) | `pledge` in [app/routes/campaigns.py](../../app/routes/campaigns.py) |
| Approve in PayPal | `POST /v2/checkout/orders/{id}/authorize` | `hold_pledge`, same file |
| Withdraw | `POST /v2/payments/authorizations/{id}/void` | `withdraw`, same file |
| Close and collect | `reauthorize` past day 3, `capture`, then `POST /v1/payments/payouts` | [app/settlement.py](../../app/settlement.py), [app/payments/pledges.py](../../app/payments/pledges.py) |
| Cancel, or miss the goal | `void` for every hold | the same |
| (PayPal) a webhook arrives | `POST /v1/notifications/verify-webhook-signature` | [app/routes/hooks.py](../../app/routes/hooks.py) |

## If something goes wrong

- **"Waking the survey engine"**: wait about 40 seconds; the page tries again by itself.
- **"Pledging is off on this server: PayPal isn't set up here."**: the server has no PayPal keys, so nothing can be
  pledged. If the live site says it, please tell us on the project's Devpost page.
- **"PayPal could not load"**: a blocker stops paypal.com, or the connection dropped. Allow paypal.com and press
  "Try again".
- **"PayPal declined that payment method"** (or "that way to pay"): nothing is held. Press PayPal's button again and
  choose another way to pay.
- **"This campaign no longer takes pledges"**: its deadline passed, or its owner closed it.
- **The payout stays "on its way"**: PayPal reports it by webhook, or the next settlement run reads it (every 3
  hours). A payout email without a sandbox account cannot be paid.

## Run the checks yourself

From a clone, after `pip install -r requirements-dev.txt`: `python -m pytest -q` runs the 965 server tests, PayPal's
in-memory fake included, and `cd frontend; npm ci; npm test` runs the 515 front-end tests. Running Walk-in locally, the
PayPal sandbox setup and the two scripts that run the money flows against the real sandbox
(`docs/founders/sandbox_money_flows.py` and `docs/founders/e2e_campaign.py`) are in the README's
[Run it yourself](../../README.md#run-it-yourself).
