import test from "node:test";
import assert from "node:assert/strict";
import { clientSpawnOptions, setupSkillTargets } from "../src/setup.mjs";

test("non-interactive Hermes setup approves its tool-discovery prompt", () => {
  assert.deepEqual(clientSpawnOptions("hermes"), {
    input: "y\ny\n",
    stdio: ["pipe", "inherit", "inherit"],
  });
  assert.deepEqual(clientSpawnOptions("codex"), { stdio: "inherit" });
});

test("setup installs the skill into the active Hermes profile as well as shared locations", () => {
  assert.deepEqual(
    setupSkillTargets("/Users/test", "/Users/test/.hermes/profiles/slideshow-bot"),
    [
      "/Users/test/.agents/skills/carouselbot",
      "/Users/test/.claude/skills/carouselbot",
      "/Users/test/.hermes/skills/carouselbot",
      "/Users/test/.hermes/profiles/slideshow-bot/skills/carouselbot",
    ],
  );
});
