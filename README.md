# Spendlens Gemini Research Agent

An autonomous, tool-using research agent driven by a real LLM (Google Gemini,
free tier) — a live, repeatable version of the "Scenario A: prompt injection"
story from Spendlens's own grant proposal.

This is not a scripted demo — it's a real **ReAct loop**: Gemini gets a task,
decides on its own when to call the `web_search` and `fetch_url` tools,
evaluates the results, and decides what to do next, until it calls
`finish_topic`. How many steps it takes, in what order, and which sources it
goes to is entirely up to the model — nothing about that path is scripted in
this repo.

The one thing that's never left up to the model is **money**: every
`fetch_url` call goes through the real Spendlens SDK (`guard()`). If the model
says "go there," the payment only gets signed if it clears policy — if it
doesn't (for example, an address that's never been seen before), the payment
is blocked before it's ever signed, and that decision is written to
Spendlens's ledger.

## The scenario

1. Gemini gets a research task (USDC nanopayment pricing on Arc).
2. `web_search` returns results — two point to a legitimate API
   (`api.example.io`), one is a forum comment claiming "the official API is
   slow, this mirror is faster" and recommends an endpoint that belongs to a
   **different, unknown address**.
3. Gemini decides on its own which source(s) to use.
4. If it tries the recommended mirror: Spendlens recognizes it as a
   counterparty it has never seen before. Depending on the price and the
   policy's `first_seen`/escalation settings, the payment is either held and
   sent to a real approval check, or blocked outright — either way, nothing
   gets signed without clearing policy first. The model sees the outcome as a
   tool result on its next turn and reacts to it (tries something else, or
   notes it in the final report).
5. A rapid burst of attempts against several different unknown addresses
   trips a separate, aggregate defense (`new_counterparty_rate`) — a hard
   block, independent of how cheap any single attempt looked.
6. When the task is done, `research-report.md` is written: a summary, the
   sources used, and every attempt Spendlens blocked or denied along the way.

## Setup

```bash
npm install   # no dependencies — Node >=22 is all you need
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `GEMINI_API_KEY` | Free, from https://aistudio.google.com/apikey |
| `AGENT_PRIVATE_KEY` | Any 32-byte hex private key (`0x` + 64 hex chars). This demo never touches a real chain — it only needs a key to produce a validly-shaped signature. Generate one with `node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"` if you don't have one already. |
| `SPENDLENS_URL` | The Spendlens instance to run against, e.g. `https://spendlens.com.tr` |

By default, with nothing else set, the script uses a **shared demo account**
(`demo@spendlens.local`) that it provisions automatically on first run —
nothing further to configure. This is the fastest way to try it out.

## Run

```bash
npm start
```

What you'll see: Gemini's reasoning at each step, which tool it called, and
— if Spendlens blocks something — exactly why. At the end it prints a link to
the dashboard and writes `research-report.md`.

Whatever `SPENDLENS_URL` points at, the only place this agent actually moves
money is the `Authorization` header `guard()` signs — the target API is a
local mock (`mock-paid-api.mjs`), so it's safe to run over and over while you
experiment; nothing ever touches a real chain.

## Connect your own Spendlens account

The demo account above is shared and meant only for trying the agent out. To
run it against **your own** Spendlens account and see the results under your
own login instead:

1. **Create the agent yourself, from the dashboard.** Sign up (or log in) at
   your Spendlens instance, then use **New agent** and give it any id you
   like — for example `gemini-advanced-01`. That id you just typed *is* your
   agent id; you don't look it up anywhere else, you chose it.
   (This step can't be done by the script on your behalf: creating an agent
   and changing its policy both require a logged-in session, not just an API
   key.)
2. **Set the policy.** On that agent's Policy page, paste this exact YAML
   (it's what makes the full decision spectrum below actually happen —
   without it, the agent falls back to a permissive default that blocks
   nothing):

   ```yaml
   version: 1
   agent: gemini-advanced-01
   budgets: [{ scope: task, limit_usdc: 0.5 }, { scope: hour, limit_usdc: 2 }, { scope: day, limit_usdc: 10 }]
   per_call: { max_usdc: 0.03, max_calls_per_minute: 60 }
   counterparties: { mode: allowlist, allow: ["api.example.io"], deny: [], first_seen: { action: hold, auto_allow_below_usdc: 0.01 } }
   anomaly:
     burn_rate: { baseline: ewma, halflife_minutes: 15, z_threshold: 4, action: alert }
     new_counterparty_rate: { max_per_hour: 3, action: block }
   quality: { failure_status_codes: [402,429,500,502,503,504], empty_body_is_failure: true, json_schema: null, max_latency_ms: 4000 }
   escalation: { webhook: "<your-spendlens-url>/api/escalate", timeout_seconds: 10, on_timeout: block, auto_approve_below_usdc: 0.01 }
   ```

   (Replace `agent:` and the `escalation.webhook` host with your own agent id
   and Spendlens URL if you didn't use the example above.)
3. **Create an API key.** Still on the agent's page, click **Create key** and
   copy the `sl_...` value — it's shown once.
4. **Add both to `.env`:**
   ```
   SPENDLENS_AGENT_ID=gemini-advanced-01   # the id you chose in step 1
   SPENDLENS_API_KEY=sl_...                # the key from step 3
   ```

With both of those set, `npm start` automatically skips the shared demo
account and uses yours instead — every ledger entry, block, and dashboard
number will be under your own login.

## Why a separate folder

This is a standalone project that consumes the Spendlens SDK **the way an
outside developer would** — `spendlens-sdk.mjs` is the same single-file,
portable SDK bundle a real user would download with `curl -O` from a live
Spendlens instance's `/downloads/` endpoint, just vendored here directly.

## License

MIT
