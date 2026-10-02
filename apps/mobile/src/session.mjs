// One serialized writer per open document. Local edits survive failed writes;
// revision conflicts stop saving until the user chooses reload or save a copy.
export class EditorSession {
  /** @param {any} api @param {any} project @param {(session: EditorSession) => void} notify */
  constructor(api, project, notify = (_session) => {}) {
    this.api = api;
    this.project = project;
    this.notify = notify;
    this.revision = project.revision;
    this.dirty = false;
    this.saving = false;
    this.conflict = null;
    this.error = null;
    this.past = [];
    this.future = [];
    this.version = 0;
    this.timer = null;
    this.inflight = null;
    this.disposed = false;
    this.locked = false;
  }
  publish() {
    if (!this.disposed) this.notify(this);
  }
  edit(next, history = true) {
    if (this.locked || this.conflict) return;
    if (history) {
      this.past.push(this.project);
      if (this.past.length > 30) this.past.shift();
      this.future = [];
    }
    this.project = { ...next, revision: this.revision, updatedAt: Date.now() };
    this.dirty = true;
    this.version++;
    this.error = null;
    this.publish();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch(() => {});
    }, 500);
  }
  undo() {
    if (!this.past.length || this.locked) return;
    const next = this.past.pop();
    this.future.push(this.project);
    this.edit(next, false);
  }
  redo() {
    if (!this.future.length || this.locked) return;
    const next = this.future.pop();
    this.past.push(this.project);
    this.edit(next, false);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.inflight) {
      await this.inflight;
      if (this.dirty) return this.flush();
      return;
    }
    if (this.conflict) throw new Error('Resolve the project conflict before continuing.');
    if (!this.dirty || this.disposed) return;
    this.saving = true;
    this.publish();
    this.inflight = (async () => {
      while (this.dirty && !this.disposed) {
        const version = this.version,
          document = this.project;
        try {
          const saved = await this.api.save(
            { ...document, revision: this.revision },
            this.revision,
          );
          this.revision = saved.revision;
          if (version === this.version) {
            this.project = saved;
            this.dirty = false;
          } else this.project = { ...this.project, revision: this.revision };
          this.error = null;
        } catch (error) {
          this.error = error.message;
          if (error.code === 'STALE_PROJECT') this.conflict = error.project || { deleted: true };
          throw error;
        } finally {
          this.publish();
        }
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
      this.saving = false;
      this.publish();
    }
  }
  replaceFromServer(project) {
    if (this.dirty || this.saving || project.revision < this.revision) return false;
    if (project.revision !== this.revision) {
      this.past = [];
      this.future = [];
    }
    this.project = project;
    this.revision = project.revision;
    this.conflict = null;
    this.publish();
    return true;
  }
  reload(project) {
    this.dirty = false;
    this.conflict = null;
    this.error = null;
    this.past = [];
    this.future = [];
    this.replaceFromServer(project);
  }
  dispose() {
    clearTimeout(this.timer);
    this.disposed = true;
  }
}
