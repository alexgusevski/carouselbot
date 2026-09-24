import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/shares/index.js";
import { onRequestGet } from "../functions/api/shares/[id].js";

test("share API keeps Pages subdomains from bypassing the carousel.bot WAF rule", async () => {
  const stored = new Map();
  const env = { SHARES: {
    async put(key, value, options) { stored.set(key, { value, options }); },
    async getWithMetadata(key) {
      const entry = stored.get(key);
      return { value: entry?.value || null, metadata: entry?.options.metadata || null };
    },
  } };
  const payload = new Uint8Array([123, 125]);
  const post = (origin) => onRequestPost({
    request: new Request(`${origin}/api/shares`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/octet-stream", "X-CarouselBot-Share-Format": "json-v1" },
      body: payload,
    }),
    env,
  });

  assert.equal((await post("https://slides-editor.pages.dev")).status, 403);
  assert.equal((await post("https://preview.slides-editor.pages.dev")).status, 403);
  assert.equal(stored.size, 0);

  const created = await post("https://carousel.bot");
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal(stored.size, 1);
  assert.equal((await onRequestGet({
    request: new Request(`https://slides-editor.pages.dev/api/shares/${id}`), env, params: { id },
  })).status, 403);
  const opened = await onRequestGet({
    request: new Request(`https://carousel.bot/api/shares/${id}`), env, params: { id },
  });
  assert.equal(opened.status, 200);
  assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), payload);
});
