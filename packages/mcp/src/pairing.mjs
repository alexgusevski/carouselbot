import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

// A browser tab on an allowed origin must be approved once by the local user
// before it can drive the agent bridge. The tab shows a short code; the user
// approves it through `carouselbot pair <code>` or their agent's pair_browser
// tool. Approval hands the tab a long-lived pairing key (stored hashed here),
// so reloads and new tabs on the same origin reconnect without a new code.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_PENDING_PAIRINGS = 16;
export const MAX_PAIRED_BROWSERS = 50;

export function createPairingCode() {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizePairingCode(value) {
  const code = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

export function createPairingKey() {
  return randomBytes(32).toString("base64url");
}

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest();
}

export function createPairingStore(path, { now = () => Date.now() } = {}) {
  let browsers = null;
  const pending = new Map();

  async function load() {
    if (browsers) return browsers;
    try {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      browsers = Array.isArray(parsed?.browsers) ? parsed.browsers.filter((entry) => typeof entry?.origin === "string" && typeof entry?.keyHash === "string") : [];
    } catch {
      browsers = [];
    }
    return browsers;
  }

  async function save() {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, browsers }), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }

  function prune() {
    const time = now();
    for (const [editorId, item] of pending) if (item.expiresAt <= time) pending.delete(editorId);
  }

  return {
    async isPaired(origin, key) {
      if (typeof key !== "string" || key.length < 32 || key.length > 128) return false;
      const digest = hashKey(key);
      const entry = (await load()).find((item) => {
        const stored = Buffer.from(item.keyHash, "hex");
        return item.origin === origin && stored.length === digest.length && timingSafeEqual(stored, digest);
      });
      if (!entry) return false;
      entry.lastUsedAt = new Date(now()).toISOString();
      await save().catch(() => {});
      return true;
    },

    // Returns the pending request for this tab, creating one when needed.
    request(editorId, origin) {
      prune();
      const existing = pending.get(editorId);
      if (existing && existing.origin === origin) return existing;
      if (!existing && pending.size >= MAX_PENDING_PAIRINGS) return null;
      const item = { editorId, origin, code: createPairingCode(), expiresAt: now() + PAIRING_TTL_MS, approvedKey: null };
      pending.set(editorId, item);
      return item;
    },

    approve(code) {
      prune();
      const normalized = normalizePairingCode(code);
      if (!normalized) return null;
      const item = [...pending.values()].find((candidate) => candidate.code === normalized);
      if (!item) return null;
      item.approvedKey ||= createPairingKey();
      return { editorId: item.editorId, origin: item.origin };
    },

    // Completes an approved request once: the key is returned to the tab and
    // only its hash is kept on disk.
    async complete(editorId, origin) {
      prune();
      const item = pending.get(editorId);
      if (!item?.approvedKey || item.origin !== origin) return null;
      pending.delete(editorId);
      const list = await load();
      const time = new Date(now()).toISOString();
      list.push({ origin, keyHash: hashKey(item.approvedKey).toString("hex"), pairedAt: time, lastUsedAt: time });
      list.sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
      list.splice(MAX_PAIRED_BROWSERS);
      await save();
      return item.approvedKey;
    },

    pendingCount() {
      prune();
      return [...pending.values()].filter((item) => !item.approvedKey).length;
    },

    async forgetAll() {
      await load();
      const removed = browsers.length;
      browsers = [];
      pending.clear();
      await save();
      return removed;
    },
  };
}
