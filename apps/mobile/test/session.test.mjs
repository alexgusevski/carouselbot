import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSession } from '../src/session.mjs';
import { newProject, newText, duplicateSlide, reorderSlide, patchLayer } from '../src/model.mjs';
test('edits made during an in-flight save serialize against the returned revision', async () => {
  const project = newProject();
  let release;
  const writes = [];
  const api = {
    save: async (document, revision) => {
      writes.push([document.name, revision]);
      if (writes.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return { ...document, revision: revision + 1 };
    },
  };
  const session = new EditorSession(api, project);
  session.edit({ ...project, name: 'First' });
  const saving = session.flush();
  session.edit({ ...session.project, name: 'Second' });
  release();
  await saving;
  assert.deepEqual(writes, [
    ['First', 0],
    ['Second', 1],
  ]);
  assert.equal(session.project.name, 'Second');
  assert.equal(session.revision, 2);
  assert.equal(session.dirty, false);
  session.dispose();
});
test('offline failure keeps local draft; retry saves it without resetting revision', async () => {
  const project = newProject();
  let failed = true;
  const session = new EditorSession(
    {
      save: async (p, revision) => {
        if (failed) throw new Error('Offline');
        return { ...p, revision: revision + 1 };
      },
    },
    project,
  );
  session.edit({ ...project, name: 'Local edit' });
  await assert.rejects(session.flush(), /Offline/);
  assert.equal(session.dirty, true);
  assert.equal(session.project.name, 'Local edit');
  failed = false;
  await session.flush();
  assert.equal(session.revision, 1);
  session.dispose();
});
test('revision conflict preserves unsynced edits and refuses subsequent writes', async () => {
  const project = newProject();
  const latest = { ...project, revision: 3, name: 'Other device' };
  const session = new EditorSession(
    {
      save: async () => {
        throw Object.assign(new Error('Changed elsewhere'), {
          code: 'STALE_PROJECT',
          project: latest,
        });
      },
    },
    project,
  );
  session.edit({ ...project, name: 'My edit' });
  await assert.rejects(session.flush());
  assert.equal(session.project.name, 'My edit');
  assert.equal(session.conflict, latest);
  assert.equal(session.replaceFromServer(latest), false);
  await assert.rejects(session.flush(), /Resolve/);
  session.reload(latest);
  assert.equal(session.project.name, 'Other device');
  assert.equal(session.dirty, false);
  session.dispose();
});
test('server agent updates invalidate manual history; locked edits cannot overwrite a job', () => {
  const project = newProject(),
    session = new EditorSession({}, project);
  session.locked = true;
  session.edit({ ...project, name: 'Should not save' });
  assert.equal(session.project.name, project.name);
  session.past = [project];
  session.replaceFromServer({ ...project, revision: 2 });
  assert.equal(session.past.length, 0);
  session.dispose();
});
test('a delayed refresh cannot roll back the revision of a completed save', () => {
  const project = { ...newProject(), revision: 8 },
    session = new EditorSession({}, project);
  assert.equal(session.replaceFromServer({ ...project, revision: 7, name: 'Old response' }), false);
  assert.equal(session.revision, 8);
  assert.equal(session.project.name, project.name);
  session.dispose();
});
test('mobile slide duplication and layer edits preserve the canonical schema', () => {
  const project = newProject();
  const text = newText(project.slides[0], 'Hello');
  project.slides[0].texts.push(text);
  const copy = duplicateSlide(project.slides[0]);
  assert.notEqual(copy.id, project.slides[0].id);
  assert.notEqual(copy.texts[0].id, text.id);
  assert.equal(copy.imageData, project.slides[0].imageData);
  project.slides.push(copy);
  assert.equal(reorderSlide(project, copy.id, -1).slides[0].id, copy.id);
  const next = patchLayer(project, project.slides[0].id, { kind: 'text', id: text.id }, { x: 0.4 });
  assert.equal(next.slides[0].texts[0].x, 0.4);
  assert.equal(project.slides[0].texts[0].x, 0.07);
});
