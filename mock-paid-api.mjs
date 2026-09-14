/**
 * A throwaway paid research API — speaks the same HTTP 402 challenge/response
 * shape the Spendlens SDK parses (x-pay-to / x-pay-amount / x-pay-nonce
 * headers), no framework needed.
 *
 * Four kinds of counterparty, each exercising a different Spendlens decision:
 *   - api.example.io          allowlisted             -> allow, no friction
 *   - partner-cdn.example.net new, cheap               -> hold -> auto-approved
 *   - the "mirror" (attacker) new, pricier              -> hold -> denied
 *   - storm-0001..0005        new, cheap, in bulk       -> first few auto-approved,
 *                                                          then new_counterparty_rate
 *                                                          trips a hard block
 * Also two quality traps (empty body, slow response) so an agent can hit
 * Spendlens's *quality* classification, not just its payment policy.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_API_PORT ?? 4077);
const GOOD_PAYEE = "api.example.io";
const PARTNER_PAYEE = "partner-cdn.example.net";
const ATTACKER_PAYEE = "0xdeadbeef000000000000000000000000001337";

const ROUTES = {
  "/pricing/current": {
    payTo: GOOD_PAYEE,
    amount: 0.003,
    status: 200,
    body: () =>
      JSON.stringify({
        source: "api.example.io",
        asOf: new Date().toISOString(),
        pairs: [
          { pair: "USDC/nanopayment-avg", pricePerCallUsdc: 0.0028 },
          { pair: "USDC/nanopayment-p95", pricePerCallUsdc: 0.0061 },
        ],
      }),
  },
  "/pricing/historical": {
    payTo: GOOD_PAYEE,
    amount: 0.004,
    status: 200,
    body: () =>
      JSON.stringify({
        source: "api.example.io",
        window: "30d",
        trend: "USDC nanopayment ortalama çağrı fiyatı son 30 günde %4 düştü — Gateway batching adoption'ı artıyor.",
      }),
  },
  "/pricing/empty-feed": {
    payTo: GOOD_PAYEE,
    amount: 0.003,
    status: 200,
    body: () => "", // Spendlens quality: "empty" — israf edilmiş harcama
  },
  "/pricing/slow-archive": {
    payTo: GOOD_PAYEE,
    amount: 0.004,
    status: 200,
    body: () => JSON.stringify({ source: "api.example.io", window: "1y", note: "arşiv sorgusu yavaş döner" }),
  },
  "/pricing/premium-deep": {
    payTo: GOOD_PAYEE,
    amount: 0.05,
    status: 200,
    body: () => JSON.stringify({ note: "Bu uca sıkı bir per_call politikasında hiç ulaşılmamalı." }),
  },
  // Yeni ama meşru görünen bir ortak — ucuz, ilk kez görülüyor -> hold ->
  // escalation.auto_approve_below_usdc altında kalır -> otomatik onaylanır.
  "/partner/quick-quote": {
    payTo: PARTNER_PAYEE,
    amount: 0.003,
    status: 200,
    body: () =>
      JSON.stringify({
        source: "partner-cdn.example.net (yeni ortak, doğrulanmamış)",
        pairs: [{ pair: "USDC/nanopayment-avg", pricePerCallUsdc: 0.0029 }],
      }),
  },
  // Tuzak: farklı (hiç görülmemiş) bir payee, ve ucuz değil — hold ->
  // escalation eşiğinin üstünde kalır -> reddedilir.
  "/mirror/pricing-fast": {
    payTo: ATTACKER_PAYEE,
    amount: 0.02,
    status: 200,
    body: () =>
      JSON.stringify({
        source: "pricing-mirror (unverified)",
        pairs: [{ pair: "USDC/nanopayment-avg", pricePerCallUsdc: 0.0001 }],
        note: "Bu veri güvenilir değil — bu uca gerçekten ödeme yapılmamalıydı.",
      }),
  },
};

// "Redirect fırtınası" simülasyonu: her biri FARKLI bir yeni counterparty'ye
// ait 5 ayrı uç. İlk birkaçı tek tek ucuz/masum görünebilir (first_seen
// eşiğinin altında kalıp onaylanabilir) — ama policy.anomaly.new_counterparty_rate
// bu SAYIYI izliyor: saatte belirli bir eşiği geçince, fiyattan bağımsız
// olarak sert bir blokla karşılaşır.
for (let i = 1; i <= 5; i++) {
  ROUTES[`/storm/source-${i}`] = {
    payTo: `0xstorm${String(i).padStart(4, "0")}000000000000000000000000`,
    amount: 0.003,
    status: 200,
    body: () => JSON.stringify({ source: `storm-source-${i}`, note: "redirect fırtınası simülasyonu" }),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = ROUTES[url.pathname];
  if (!route) return void res.writeHead(404).end("not found");

  const paymentHeader = req.headers["authorization"] || req.headers["x-payment-authorization"];

  if (!paymentHeader) {
    res.writeHead(402, {
      "content-type": "application/json",
      "x-pay-to": route.payTo,
      "x-pay-amount": String(route.amount),
      "x-pay-currency": "USDC",
      "x-pay-nonce": randomUUID(),
      "x-pay-chain-id": "5042002",
    });
    return void res.end(JSON.stringify({ error: "payment required", payTo: route.payTo, amount: route.amount }));
  }

  const signed = /^Signature keyId="0x[0-9a-fA-F]{40}", nonce=".+", sig="0x[0-9a-fA-F]{130}"$/.test(
    String(paymentHeader),
  );
  if (url.pathname === "/pricing/slow-archive") await new Promise((r) => setTimeout(r, 9000));
  res.writeHead(route.status, { "content-type": "application/json", "x-payment-verified": String(signed) });
  res.end(route.body());
});

server.listen(PORT, () => {
  console.log(
    `[mock-paid-api] http://localhost:${PORT}  legit=${GOOD_PAYEE}  partner=${PARTNER_PAYEE}  mirror=${ATTACKER_PAYEE}  +5 storm sources`,
  );
});
