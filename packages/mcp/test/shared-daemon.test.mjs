import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shares one daemon while preserving per-agent editor selection", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "carouselbot-shared-"));
  const port = 45000 + Math.floor(Math.random() * 1000);
  process.env.CAROUSELBOT_STATE_DIR = stateDirectory;
  process.env.CAROUSELBOT_BRIDGE_PORT = String(port);
  process.env.CAROUSELBOT_EDITOR_TTL_MS = "120";
  process.env.CAROUSELBOT_EVENT_POLL_TIMEOUT_MS = "2000";
  const { companionRestart, createCompanion } = await import(`../src/companion.mjs?shared=${port}`);
  const first = await createCompanion("Claude Code", "test");
  const second = await createCompanion("Codex", "test");
  const origin = "https://carousel.bot";
  const base = `http://127.0.0.1:${port}`;

  async function connect(editorId) {
    const response = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ editorId, protocolVersion: 3, pageUrl: `${origin}/#${editorId}`, state: { activeProjectId: null } }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const editorA = await connect("editor-a");
  const editorB = await connect("editor-b");
  try {
    assert.equal(first.daemon.pid, second.daemon.pid);
    assert.equal((await first.call("list_editors")).editors.length, 2);
    await first.call("select_editor", { editorId: "editor-a" });
    await second.call("select_editor", { editorId: "editor-b" });
    const firstEditors = await first.call("list_editors");
    const secondEditors = await second.call("list_editors");
    assert.equal(firstEditors.selectedEditorId, "editor-a");
    assert.equal(firstEditors.editors.find((editor) => editor.id === "editor-a").selected, true);
    assert.equal(secondEditors.selectedEditorId, "editor-b");
    assert.equal(secondEditors.editors.find((editor) => editor.id === "editor-b").selected, true);

    await first.call("notify", { message: "From Claude", tone: "success" });
    await second.call("notify", { message: "From Codex", tone: "info" });
    const eventA = await fetch(`${base}/events?editorId=editor-a`, { headers: { Origin: origin, Authorization: `Bearer ${editorA.sessionToken}` } }).then((response) => response.json());
    const eventB = await fetch(`${base}/events?editorId=editor-b`, { headers: { Origin: origin, Authorization: `Bearer ${editorB.sessionToken}` } }).then((response) => response.json());
    assert.equal(eventA.message, "From Claude");
    assert.equal(eventA.agent.name, "Claude Code");
    assert.equal(eventB.message, "From Codex");
    assert.equal(eventB.agent.name, "Codex");

    const sessionA = await first.call("begin_edit_session", { editorId: "editor-a", projectId: "project-a", purpose: "Build deck A" });
    assert.equal(sessionA.editorId, "editor-a");
    assert.equal(sessionA.projectId, "project-a");
    await assert.rejects(
      second.call("begin_edit_session", { editorId: "editor-a", projectId: "project-b", purpose: "Competing worker" }),
      /EDITOR_BUSY/,
    );
    await assert.rejects(
      second.call("begin_edit_session", { editorId: "editor-b", projectId: "project-a", purpose: "Same project elsewhere" }),
      /PROJECT_BUSY/,
    );
    const sessionB = await second.call("begin_edit_session", { editorId: "editor-b", projectId: "project-b", purpose: "Build deck B" });

    async function nextCommand(editorId, token) {
      for (;;) {
        const event = await fetch(`${base}/events?editorId=${editorId}`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } }).then((response) => response.json());
        if (event.kind === "command") return event;
      }
    }

    const browserCall = first.call("browser", {
      toolName: "add_slide", mutating: true, editSessionId: sessionA.id,
      operation: { type: "slide.add", projectId: "project-a" }, label: "Adding a slide…",
    });
    const command = await nextCommand("editor-a", editorA.sessionToken);
    assert.equal(command.editSessionId, sessionA.id);
    assert.equal(command.operation.projectId, "project-a");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      (await first.call("list_editors")).editors.some((editor) => editor.id === "editor-a"),
      "an editor running a command must stay active beyond the idle TTL",
    );
    await fetch(`${base}/result`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${editorA.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ editorId: "editor-a", requestId: command.requestId, ok: true, result: { projectId: "project-a", revision: 2 } }),
    });
    assert.equal((await browserCall).revision, 2);
    const audit = await first.call("list_recent_operations", { projectId: "project-a", limit: 10 });
    assert.ok(audit.events.some((event) => event.toolName === "add_slide" && event.status === "ok"));

    const heartbeat = await fetch(`${base}/heartbeat`, {
      method: "POST",
      headers: { Origin: origin, Authorization: `Bearer ${editorA.sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ editorId: "editor-a" }),
    });
    assert.equal(heartbeat.status, 200);

    await first.call("end_edit_session", { editSessionId: sessionA.id });
    await second.call("end_edit_session", { editSessionId: sessionB.id });
    const simultaneous = await Promise.allSettled([
      first.call("begin_edit_session", { editorId: "editor-a", purpose: "Worker one" }),
      second.call("begin_edit_session", { editorId: "editor-a", purpose: "Worker two" }),
    ]);
    assert.equal(simultaneous.filter((result) => result.status === "fulfilled").length, 1, "only one simultaneous claim may win");
    assert.match(simultaneous.find((result) => result.status === "rejected").reason.message, /EDITOR_BUSY/);
    const winning = simultaneous.find((result) => result.status === "fulfilled").value;
    await first.call("end_edit_session", { editSessionId: winning.id });

    const controller = new AbortController();
    const openPoll = (async () => {
      while (!controller.signal.aborted) {
        await fetch(`${base}/events?editorId=editor-a`, {
          headers: { Origin: origin, Authorization: `Bearer ${editorA.sessionToken}` },
          signal: controller.signal,
        });
      }
    })().catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await first.call("list_editors")).editors.map((editor) => editor.id), ["editor-a"], "an open event request should keep a background editor active");
    controller.abort();
    await openPoll;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await first.call("list_editors")).editors, [], "a closed event request should expire after the configured grace period");

    const previousPid = first.daemon.pid;
    const restarted = await companionRestart();
    assert.notEqual(restarted.pid, previousPid, "restart should replace the daemon process");
    assert.deepEqual((await first.call("list_editors")).editors, [], "an existing client should recover against the replacement daemon");
    assert.equal(first.daemon.pid, restarted.pid);
  } finally {
    await first.close();
    await second.close();
    const state = await readFile(join(stateDirectory, `daemon-${port}.json`), "utf8").then(JSON.parse).catch(() => null);
    if (state?.pid) try { process.kill(state.pid, "SIGTERM"); } catch { /* Already stopped. */ }
    await rm(stateDirectory, { recursive: true, force: true });
    delete process.env.CAROUSELBOT_STATE_DIR;
    delete process.env.CAROUSELBOT_BRIDGE_PORT;
    delete process.env.CAROUSELBOT_EDITOR_TTL_MS;
    delete process.env.CAROUSELBOT_EVENT_POLL_TIMEOUT_MS;
  }
});
