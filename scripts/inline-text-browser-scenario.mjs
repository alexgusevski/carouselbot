export async function verifyInlineTextRows(cdp, evaluate) {
  await evaluate(cdp, `(async () => {
    const agent = window.carouselBotAgent;
    const original = agent.inspect({ includeAllProjects: false });
    const scope = { projectId: original.project.id, slideId: original.slide.id };
    const run = (operation) => agent.execute({ ...scope, ...operation });
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const created = await run({ type: 'text.add', text: 'Vibecoded an app\\nwith AI', size: 105, fontWeight: 719,
      style: 'boxed', backgroundShape: 'lines', align: 'left', width: 0.897802, height: 0.36, x: 0.05, y: 0.05 });
    const id = created.createdTextId;
    const box = () => document.querySelector('[data-text-id="' + id + '"]');
    const current = () => agent.inspect({ includeAllProjects: false }).slide.texts.find((text) => text.id === id);
    const edit = () => {
      box().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0 }));
      return box().querySelector('.text-editor');
    };
    const finish = () => {
      const editor = box()?.querySelector('.text-editor');
      editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!box()?.querySelector('.text-editor'), 'Escape must end inline editing');
    };
    try {
      for (const style of ['boxed', 'plain', 'outline']) {
        for (const align of ['left', 'center', 'right']) {
          await run({ type: 'text.update', updates: [{ id, style, align }] });
          const editor = edit();
          const node = editor.firstChild;
          const nativeRows = [];
          for (let i = 0; i < node.length; i++) {
            if (/\\s/.test(node.textContent[i])) continue;
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getBoundingClientRect();
            let row = nativeRows.find((item) => Math.abs(item.y - rect.y) < 1);
            if (!row) { row = { y: rect.y, text: '', x: rect.x, right: rect.right }; nativeRows.push(row); }
            row.text += node.textContent[i];
            row.right = rect.right;
          }
          const painted = [...box().querySelectorAll('.text-visual--inside .text-line')];
          assert(JSON.stringify(nativeRows.map((row) => row.text)) === JSON.stringify(painted.map((row) => row.textContent.replace(/\\s/g, ''))),
            'Inline rows disagree with visible rows: ' + style + '/' + align + ' ' + JSON.stringify(nativeRows));
          const bounds = editor.getBoundingClientRect();
          assert(nativeRows.every((row) => row.y < bounds.bottom && row.right <= bounds.right + 1), 'Editable rows are clipped');
          const first = painted[0];
          if (style !== 'outline') {
            const range = document.createRange(); range.selectNodeContents(first);
            assert(Math.abs(range.getBoundingClientRect().x - nativeRows[0].x) < 1, 'Caret starts outside painted text');
          }
          assert(window.getSelection().toString() === current().text, 'Select-all must cover all rows');
          finish();
        }
      }
      await run({ type: 'text.update', updates: [{ id, style: 'boxed', align: 'left', size: 70, text: 'First\\nSecond' }] });
      let editor = edit();
      document.execCommand('insertText', false, 'First');
      document.execCommand('insertParagraph');
      assert(current().text === 'First\\n', 'Enter must preserve one trailing newline: ' + JSON.stringify({model: current().text, html: editor.innerHTML, inner: editor.innerText}));
      document.execCommand('insertText', false, 'Second');
      assert(current().text === 'First\\nSecond', 'Native paragraphs must serialize to exactly one newline');
      document.execCommand('insertParagraph');
      document.execCommand('insertParagraph');
      assert(current().text === 'First\\nSecond\\n\\n', 'Intentional blank rows must survive');
      finish();
      editor = edit();
      editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
      assert(current().text === 'First\\nSecond\\n\\n', 'Reopening and editing must not remove a saved blank row');
      document.execCommand('insertText', false, 'Vibecoded an app\\nwith AI');
      assert(current().text === 'Vibecoded an app\\nwith AI', 'Replacing all rows must not append a newline: ' + JSON.stringify({model: current().text, html: editor.innerHTML, inner: editor.innerText, selection: window.getSelection().toString()}));
      assert(box().querySelectorAll('.text-visual--inside .text-line').length === 2, 'Two fitting paragraphs must paint as two rows');
      const before = box().querySelector('.text-visual--inside .text-background path').getAttribute('d');
      finish();
      editor = edit();
      assert(box().querySelector('.text-visual--inside .text-background path').getAttribute('d') === before, 'Editing must preserve rounded background geometry');
      assert(current().text === editor.innerText, 'Reopening must preserve newlines');
      finish();
    } finally {
      finish();
      await run({ type: 'layer.delete', layerIds: [id] });
    }
  })()`);
}
