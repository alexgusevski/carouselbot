import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequestPost } from "../functions/api/shares/index.js";
import { onRequestGet } from "../functions/api/shares/[id].js";
import { reserveShareBudget, signShareId, DAY_MS } from "../functions/_lib/share-security.js";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_share_budgets.sql", import.meta.url), "utf8"));
  t.after(() => db.close());
  const stored = new Map();
  let reads = 0;
  const env = { SHARING_ENABLED: "true", TURNSTILE_SECRET_KEY: "test-secret", SHARES: {
    async put(key, value, options) { stored.set(key, { value, options }); },
    async getWithMetadata(key) { reads++; const item = stored.get(key); return { value: item?.value, metadata: item?.options.metadata }; },
  }, SHARE_BUDGETS: {
    prepare(sql) {
      return { sql, values: [], bind(...values) { return { ...this, values }; },
        async first() { return db.prepare(sql).get(...this.values); } };
    },
    async batch(statements) {
      db.exec("BEGIN");
      try { const result = statements.map(({ sql, values }) => db.prepare(sql).run(...values)); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } };
  const payload = new TextEncoder().encode(JSON.stringify({ version: 1, project: { id: "p", name: "Test", slides: [], assets: [] } }));
  const request = (body = payload, headers = {}, origin = "https://carousel.bot") => new Request(`${origin}/api/shares`, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/octet-stream", "X-CarouselBot-Share-Format": "json-v1",
    "X-CarouselBot-Share-Bytes": String(body.length), "X-CarouselBot-Turnstile": "proof", "CF-Connecting-IP": "192.0.2.1", ...headers,
  }, body });
  const get = (id, origin = "https://carousel.bot") => onRequestGet({ env, params: { id }, request: new Request(`${origin}/api/shares/${id}`, { headers: { "CF-Connecting-IP": "192.0.2.1" } }) });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(JSON.parse(options.body).secret, "test-secret");
    return Response.json({ success: true, hostname: "carousel.bot", action: "share" });
  });
  return { db, env, stored, payload, request, get, reads: () => reads };
}
test("valid uploads require verification and round-trip through signed, quota-controlled links", async (t) => {
  const h = setup(t);
  const response = await onRequestPost({ request: h.request(), env: h.env });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const opened = await h.get(id);
  assert.equal(opened.status, 200);
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), h.payload);
  const forged = id.slice(0, -1) + (id.endsWith("0") ? "1" : "0");
  assert.equal((await h.get(forged)).status, 404);
  assert.equal(h.reads(), 1);
  for (const origin of ["https://slides-editor.pages.dev", "https://preview.slides-editor.pages.dev", "http://carousel.bot", "http://localhost"]) {
    assert.equal((await onRequestPost({ env: h.env, request: h.request(h.payload, {}, origin) })).status, 403);
    assert.equal((await h.get(id, origin)).status, 403);
  }
});
test("rejects absent, wrong-host, wrong-action and failed verification before reading the body or writing storage", async (t) => {
  const h = setup(t);
  assert.equal((await onRequestPost({ env: h.env, request: h.request(h.payload, { "X-CarouselBot-Turnstile": "" }) })).status, 403);
  for (const result of [{ success: false }, { success: true, hostname: "evil.example", action: "share" }, { success: true, hostname: "carousel.bot", action: "other" }]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(result));
    assert.equal((await onRequestPost({ env: h.env, request: h.request() })).status, 403);
  }
  assert.equal(h.stored.size, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM share_budgets").get().n, 0);
});
test("rejects arbitrary bytes, unsafe project data, and dishonest lengths; fails closed", async (t) => {
  const h = setup(t);
  assert.equal((await onRequestPost({ env: h.env, request: h.request(new TextEncoder().encode("arbitrary storage")) })).status, 400);
  assert.equal((await onRequestPost({ env: h.env, request: h.request(h.payload, { "X-CarouselBot-Share-Bytes": "1" }) })).status, 413);
  assert.equal(h.stored.size, 0);
  h.env.SHARING_ENABLED = "false";
  assert.equal((await onRequestPost({ env: h.env, request: h.request() })).status, 503);
  h.env.SHARING_ENABLED = "true";
  h.env.SHARE_BUDGETS.batch = async () => { throw new Error("unavailable"); };
  assert.equal((await onRequestPost({ env: h.env, request: h.request() })).status, 503);
  assert.equal(h.stored.size, 0);
});
test("simultaneous admissions cannot overshoot client or global budgets and failed batches roll back", async (t) => {
  const h = setup(t);
  const now = Date.now();
  const results = await Promise.all(Array.from({ length: 40 }, () => reserveShareBudget(h.request(), h.env, "upload", 1, now)));
  assert.equal(results.filter(Boolean).length, 20);
  const day = Math.floor(now / DAY_MS);
  assert.equal(h.db.prepare("SELECT count FROM share_budgets WHERE scope = 'upload:global' AND window = ?").get(day).count, 20);
  h.db.prepare("UPDATE share_budgets SET bytes = max_bytes - 10 WHERE scope = 'upload:global'").run();
  const remaining = await Promise.all(Array.from({ length: 20 }, (_, i) => reserveShareBudget(h.request(h.payload, { "CF-Connecting-IP": `192.0.2.${i + 2}` }), h.env, "upload", 10, now)));
  assert.equal(remaining.filter(Boolean).length, 1);
  assert.equal(await reserveShareBudget(h.request(), h.env, "upload", 1, (day + 1) * DAY_MS), true);
});
test("real signed links are also read limited; expired and unsigned IDs never reach KV", async (t) => {
  const h = setup(t);
  const now = Date.now();
  const id = await signShareId(`${now.toString(36)}-${"a".repeat(32)}`, h.env);
  const day = Math.floor(now / DAY_MS);
  h.db.prepare("INSERT INTO share_budgets VALUES ('read:global', ?, 10000, 0, 10000, 0)").run(day);
  assert.equal((await h.get(id)).status, 429);
  assert.equal((await h.get(`${now.toString(36)}-${"a".repeat(32)}`)).status, 404);
  const expired = await signShareId(`${(now - DAY_MS - 1).toString(36)}-${"a".repeat(32)}`, h.env);
  assert.equal((await h.get(expired)).status, 410);
  assert.equal(h.reads(), 0);
});
