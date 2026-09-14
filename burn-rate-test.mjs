/**
 * Burn-rate (Signal 1 / EWMA) anomaly testi — 200 yetkilendirme + 30 dakikalık
 * ısınma penceresini GERÇEKTEN 30 dakika beklemeden geçmek için, PolicyEngine'i
 * guard()'ı atlayıp doğrudan sürüyoruz ve `now`'u kendimiz veriyoruz (SDK bunu
 * destekliyor: EvaluationInput.now). Böylece:
 *   - Isınma eşiğini (200 çağrı + 30 dk) simüle edilmiş zamanla GERÇEKTEN geçiyoruz
 *     (sahte veri değil — aynı matematik, aynı kod yolu, sadece saat bizim elimizde).
 *   - Her adımın gerçek z-skorunu görebiliyoruz (guard() bunu dışa vermiyor).
 *   - Sonuçları GERÇEK /api/authorizations'a yazıyoruz, yani panelde de görünüyor.
 *
 * Kullanım: node burn-rate-test.mjs
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const SPENDLENS_URL = (process.env.SPENDLENS_URL || "http://localhost:3000").replace(/\/$/, "");
const EMAIL = "demo@spendlens.local";
const PASSWORD = "spendlens-demo-2026";
const AGENT_SLUG = "gemini-advanced-01";
const COUNTERPARTY = "api.example.io";
const RESOURCE = "http://localhost:4077/pricing/current";
const AMOUNT_USDC = 0.003;

const { PolicyEngine, InMemoryPolicyStateStore } = await import("./spendlens-sdk.mjs");

let cookie = "";
async function spendlensApi(method, path, body) {
  const res = await fetch(`${SPENDLENS_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: SPENDLENS_URL, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

console.log("▶ Giriş yapılıyor…");
let r = await spendlensApi("POST", "/api/auth/sign-in/email", { email: EMAIL, password: PASSWORD });
if (!cookie) throw new Error("Giriş başarısız.");

// burn_rate.action'ı "alert"ten "hold"a çekiyoruz — böylece tetiklenince gerçek
// bir karar değişikliği (allow -> hold) olarak net görülür, sessiz bir etiket
// olarak kalmaz. Panelin Policies sayfası da bunu yansıtacak.
const policy = `version: 1
agent: ${AGENT_SLUG}
budgets: [{ scope: task, limit_usdc: 0.5 }, { scope: hour, limit_usdc: 2 }, { scope: day, limit_usdc: 10 }]
per_call: { max_usdc: 0.03, max_calls_per_minute: 600 }
counterparties: { mode: allowlist, allow: ["api.example.io"], deny: [], first_seen: { action: hold, auto_allow_below_usdc: 0.01 } }
anomaly:
  burn_rate: { baseline: ewma, halflife_minutes: 15, z_threshold: 4, action: hold }
  new_counterparty_rate: { max_per_hour: 3, action: block }
quality: { failure_status_codes: [402,429,500,502,503,504], empty_body_is_failure: true, json_schema: null, max_latency_ms: 4000 }
escalation: { webhook: "${SPENDLENS_URL}/api/escalate", timeout_seconds: 10, on_timeout: block, auto_approve_below_usdc: 0.01 }`;
await spendlensApi("POST", `/api/policies/${AGENT_SLUG}`, { raw: policy });
console.log("  policy güncellendi: burn_rate.action artık 'hold' (test için, daha önce 'alert'ti)");

const mk = await spendlensApi("POST", `/api/agents/${AGENT_SLUG}/keys`, {
  name: `burn-rate-test ${new Date().toISOString().slice(0, 16)}`,
});
const apiKey = mk.json.key;
console.log(`  key alındı`);

// Aynı camelCase şekil — contracts/policy.ts'teki PolicyConfig ile birebir.
const policyConfig = {
  version: 1,
  agent: AGENT_SLUG,
  budgets: [
    { scope: "hour", limitUsdc: 2 },
    { scope: "day", limitUsdc: 10 },
  ],
  perCall: { maxUsdc: 0.03, maxCallsPerMinute: 600 },
  counterparties: { mode: "allowlist", allow: [COUNTERPARTY], deny: [], firstSeen: { action: "hold", autoAllowBelowUsdc: 0.01 } },
  anomaly: {
    burnRate: { baseline: "ewma", halflifeMinutes: 15, zThreshold: 4, action: "hold" },
    newCounterpartyRate: { maxPerHour: 3, action: "block" },
  },
  quality: { failureStatusCodes: [402, 429, 500, 502, 503, 504], emptyBodyIsFailure: true, jsonSchema: null, maxLatencyMs: 4000 },
  escalation: { webhook: `${SPENDLENS_URL}/api/escalate`, timeoutSeconds: 10, onTimeout: "block", autoApproveBelowUsdc: 0.01 },
};

const store = new InMemoryPolicyStateStore();
const engine = new PolicyEngine(policyConfig, store);

// Zaman çizelgesi: son "ramp" çağrısı ~şimdi olacak şekilde geriye doğru kur —
// panelde makul, kronolojik bir zaman dizisi görünsün diye.
const RAMP_CALLS = 200;
const RAMP_GAP_MS = 10_000; // her çağrı arası 10 SİMÜLE saniye
const SPIKE_GAP_MS = 1_000; // spike çağrıları arası 1 SİMÜLE saniye (taban değer)
const nowReal = Date.now();
const baseTime = nowReal - RAMP_CALLS * RAMP_GAP_MS - 3 * SPIKE_GAP_MS;

const records = [];
function buildRecord(verdict, ts, taskId) {
  return {
    id: randomUUID(),
    ts: new Date(ts).toISOString(),
    agentId: AGENT_SLUG,
    taskId,
    counterparty: COUNTERPARTY,
    resource: RESOURCE,
    amountMicroUsdc: Math.round(AMOUNT_USDC * 1_000_000),
    decision: verdict.decision,
    ruleHit: verdict.ruleHit,
    nonce: null,
    chainId: null,
    httpStatus: verdict.decision === "allow" || verdict.decision === "hold_approved" ? 200 : 402,
    latencyMs: verdict.decision === "allow" || verdict.decision === "hold_approved" ? 40 : null,
    bodyBytes: verdict.decision === "allow" || verdict.decision === "hold_approved" ? 64 : null,
    bodySha256: null,
    quality: verdict.decision === "allow" || verdict.decision === "hold_approved" ? "ok" : null,
    settlementId: null,
    createdAt: new Date(ts).toISOString(),
  };
}

console.log(`\n▶ Isınma penceresi simüle ediliyor: ${RAMP_CALLS} çağrı, aralarında 10sn (simüle) — toplam ~${((RAMP_CALLS * RAMP_GAP_MS) / 60000).toFixed(1)} dakika`);
for (let i = 0; i < RAMP_CALLS; i++) {
  const ts = baseTime + i * RAMP_GAP_MS;
  const verdict = await engine.evaluate({
    agentId: AGENT_SLUG,
    counterparty: COUNTERPARTY,
    amount: AMOUNT_USDC,
    resource: RESOURCE,
    now: ts,
  });
  records.push(buildRecord(verdict, ts, "burn-rate-ramp"));
  if ((i + 1) % 40 === 0 || i === RAMP_CALLS - 1) {
    const ewma = store.getEwmaState(AGENT_SLUG);
    console.log(
      `   [${i + 1}/${RAMP_CALLS}] karar=${verdict.decision}  mu=${ewma.mu.toFixed(5)} USDC/dk  z(bu adım)=${(verdict.anomalyZ ?? 0).toFixed(2)}`,
    );
  }
}

const totalSoFar = store.getTotalAuthorizationsCount(AGENT_SLUG);
const firstTs = store.getFirstActivityTimestamp(AGENT_SLUG);
const minutesSince = (baseTime + (RAMP_CALLS - 1) * RAMP_GAP_MS - firstTs) / 60000;
console.log(`\n▶ Isınma durumu: ${totalSoFar} çağrı · ilk çağrıdan bu yana ${minutesSince.toFixed(1)} dk (eşik: 200 çağrı VE 30 dk)`);
console.log(`  → cold start artık ${totalSoFar >= 200 && minutesSince >= 30 ? "BİTTİ — anomaly kuralları artık gerçekten karar değiştirebilir" : "hâlâ aktif"}`);

/** Ham "hold" bir terminal ledger durumu değil (DecisionSchema yalnızca allow/
 *  block/hold_approved/hold_denied kabul ediyor) — guard()'ın gerçekte yaptığı
 *  gibi, gerçek /api/escalate'e sorup GERÇEK sonucu alıyoruz. */
async function resolveHold(verdict, taskId) {
  const res = await fetch(`${SPENDLENS_URL}/api/escalate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      counterparty: COUNTERPARTY,
      resource: RESOURCE,
      amountUsdc: AMOUNT_USDC,
      ruleHit: verdict.ruleHit,
      taskId,
    }),
  });
  const j = await res.json().catch(() => ({}));
  return j.decision ?? "hold_denied";
}

console.log(`\n▶ Spike testi: aynı miktar, ama art arda yalnızca 1sn (simüle) arayla — beklenen: burn_rate tetiklenip hold'a düşmesi`);
let lastTs = baseTime + (RAMP_CALLS - 1) * RAMP_GAP_MS;
for (let i = 0; i < 3; i++) {
  const ts = lastTs + SPIKE_GAP_MS;
  lastTs = ts;
  const verdict = await engine.evaluate({
    agentId: AGENT_SLUG,
    counterparty: COUNTERPARTY,
    amount: AMOUNT_USDC,
    resource: RESOURCE,
    now: ts,
  });
  let finalDecision = verdict.decision;
  if (verdict.decision === "hold") {
    finalDecision = await resolveHold(verdict, "burn-rate-spike");
  }
  records.push(buildRecord({ ...verdict, decision: finalDecision }, ts, "burn-rate-spike"));
  console.log(
    `   spike #${i + 1}: policy kararı=${verdict.decision}${verdict.ruleHit ? ` (${verdict.ruleHit})` : ""}` +
      `  z=${(verdict.anomalyZ ?? 0).toFixed(2)}  →  escalation sonrası=${finalDecision}`,
  );
}

console.log(`\n▶ ${records.length} kayıt gerçek ledger'a yazılıyor (/api/authorizations)…`);
for (let i = 0; i < records.length; i += 200) {
  const batch = records.slice(i, i + 200);
  const res = await fetch(`${SPENDLENS_URL}/api/authorizations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ records: batch }),
  });
  const j = await res.json().catch(() => ({}));
  console.log(`   batch ${i}-${i + batch.length}: ${res.status} ${JSON.stringify(j)}`);
}

console.log(`\n${"─".repeat(64)}`);
console.log(`  Panel : ${SPENDLENS_URL}/dashboard/anomalies`);
console.log(`  Giriş : ${EMAIL}  /  ${PASSWORD}`);
console.log(`${"─".repeat(64)}\n`);
