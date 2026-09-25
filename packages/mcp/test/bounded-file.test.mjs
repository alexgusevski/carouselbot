import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedFile } from "../src/bounded-file.mjs";

test("bounded descriptor reads reject oversized files, directories and disallowed symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'carousel-bounded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'sample');
  await writeFile(file, 'hello');
  assert.equal((await readBoundedFile(file, 5)).buffer.toString(), 'hello');
  await assert.rejects(readBoundedFile(file, 4), /transfer limit/);
  await assert.rejects(readBoundedFile(dir, 5), /transfer limit/);
  await symlink(file, join(dir, 'alias'));
  await assert.rejects(readBoundedFile(join(dir, 'alias'), 5, { noFollow: true }));
});
