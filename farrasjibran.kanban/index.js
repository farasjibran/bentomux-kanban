/* Kanban — a task board for Bentomux.
 *
 * Columns are the statuses. A card moves between them by dragging it (anywhere
 * in a column, or between two cards to pick the slot), or with Alt+Arrow on a
 * focused card. Double-click a title to rename it; Enter in the composer keeps
 * the composer open for the next task.
 *
 * The board is Plugin Data (`ctx.storage`): it survives restarts, and
 * uninstalling the plugin keeps it.
 *
 * Dragging runs on pointer events rather than HTML5 drag-and-drop: that is how
 * the app drags its own tabs, panes and workspaces, it needs no dataTransfer
 * round trip, and the card gets a real ghost that follows the pointer.
 *
 * `place()` and `dropIndex()` hold the only real logic here — column ordering
 * and drop-slot maths, where a drag can go wrong quietly — so they are pure
 * and exported for index.test.mjs. Everything else is DOM wiring.
 */

const COLUMNS = [
  { id: 'todo', label: 'To Do' },
  { id: 'doing', label: 'In Progress' },
  { id: 'done', label: 'Done' },
];
const STATUSES = COLUMNS.map((c) => c.id);
/* the priority chip walks this ring on click; '' is "no priority" */
const PRIORITY_RING = ['', 'low', 'medium', 'high'];

/* Move `id` to `status` at slot `index` among that column's other cards.
 *
 * `index` is clamped, and a slot past the end of the column lands after that
 * column's last card — not at the end of the array, which would silently
 * reshuffle a column the user is not looking at. Returns a new array.
 */
export function place(tasks, id, status, index) {
  const moving = tasks.find((t) => t.id === id);
  if (!moving) return tasks;
  const rest = tasks.filter((t) => t.id !== id);
  const members = rest.filter((t) => t.status === status);
  const at = Math.min(Math.max(index ?? members.length, 0), members.length);
  const before = members[at];
  const last = members[members.length - 1];
  const insert = before
    ? rest.indexOf(before)
    : last
      ? rest.indexOf(last) + 1
      : rest.length;
  return [...rest.slice(0, insert), { ...moving, status }, ...rest.slice(insert)];
}

/* Which slot the pointer is over, given the column's card rects, in order.
   The dragged card is not in `rects` — the caller filters it out, or a card
   dragged downwards would land one slot too low. */
export function dropIndex(rects, y) {
  for (let i = 0; i < rects.length; i++) {
    if (y < (rects[i].top + rects[i].bottom) / 2) return i;
  }
  return rects.length;
}

/* http(s) links, and bare www ones, in a run of text. Trailing punctuation
   belongs to the sentence, not to the URL: "see https://a.dev/x." must not
   open with the full stop. Commas end a token for the same reason, so
   "a.dev/x, http://b.dev/y" is two links rather than one long one.
   Exported for index.test.mjs. */
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>()"',]+/gi;
const trimLink = (url) => url.replace(/[.;:!?]+$/, '');

export function links(text) {
  const found = [];
  for (const match of String(text).matchAll(LINK_RE)) {
    const url = trimLink(match[0]);
    if (url) found.push({ url, start: match.index, end: match.index + url.length });
  }
  return found;
}

/** @param {import('./bentomux-plugin-sdk').PluginContext} ctx */
export function activate(ctx) {
  const TAB_ID = 'farrasjibran.kanban.tab';

  let tasks = [];
  let host = null;
  let liveEl = null;
  /* the in-flight pointer drag: node, ghost, and the slot it is over */
  let drag = null;
  let composer = null; // column id whose composer is open
  let editId = null; // card being renamed
  let focusId = null; // card to focus after the next paint
  let saveTimer = null;
  let seq = 0;
  /* a drag that got going suppresses the click its pointer-up also fires */
  let dragged = false;
  let lastOpen = { url: '', at: 0 };
  const byId = (id) => tasks.find((t) => t.id === id);
  const labelFor = (status) => COLUMNS.find((c) => c.id === status)?.label ?? status;

  /* ---------------- persistence ---------------- */

  const write = () => {
    saveTimer = null;
    void ctx.storage.set('board', { tasks });
  };

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(write, 250);
  };

  /* a pending write must not be lost when the plugin is disabled or reloaded */
  ctx.dispose(() => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    write();
  });

  /* ---------------- helpers ---------------- */

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function age(ts) {
    const secs = Math.max(0, (Date.now() - ts) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 86400 * 30) return `${Math.floor(secs / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }

  function newTask(title, status) {
    seq += 1;
    return {
      id: `k${Date.now().toString(36)}${seq.toString(36)}`,
      title,
      status,
      priority: '',
      createdAt: Date.now(),
    };
  }

  /* Plugin Data is user data, and user data gets edited by hand: a card that
     lost its title or status must not take the board down with it. */
  function normalize(raw) {
    const list = Array.isArray(raw?.tasks) ? raw.tasks : [];
    return list
      .filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string')
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: STATUSES.includes(t.status) ? t.status : STATUSES[0],
        priority: PRIORITY_RING.includes(t.priority) ? t.priority : '',
        createdAt: typeof t.createdAt === 'number' ? t.createdAt : Date.now(),
      }));
  }

  function announce(text) {
    if (liveEl) liveEl.textContent = text;
  }

  /* ---------------- links ----------------
     A plugin cannot import @tauri-apps/plugin-opener: the host loads plugin
     entries as plain ES modules over plugin://, with no bundler and no import
     map. No ctx facade method opens a URL either, so this calls the very
     command the app's own openUrl() calls, allowed because the window already
     carries the capability (src-tauri/capabilities/default.json:
     opener:default, which is allow-open-url for http/https).

     Ceiling, deliberately accepted: this reaches past the ctx contract, so
     Studio cannot show 'opens links in your browser' on the install review.
     If the platform ever grows an external.open permission backed by
     ctx.app.openExternal, move openLink() onto it and declare it. */

  function openLink(url) {
    const target = /^www\./i.test(url) ? 'https://' + url : url;
    const now = Date.now();
    /* a double-click fires click twice; one link, one tab */
    if (target === lastOpen.url && now - lastOpen.at < 500) return;
    lastOpen = { url: target, at: now };
    /* injected by Tauri, so not in the DOM types: cast rather than widen */
    const internals =
      /** @type {{ __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }} */ (
        window
      ).__TAURI_INTERNALS__;
    const invoke = internals?.invoke;
    if (typeof invoke !== 'function') {
      ctx.log('kanban: cannot open links in this build', target);
      return;
    }
    Promise.resolve(invoke('plugin:opener|open_url', { url: target, with: null })).catch((e) =>
      ctx.log('kanban: could not open', target, e),
    );
  }

  function linkEl(url) {
    const link = el('span', 'kb-link', url);
    link.setAttribute('role', 'link');
    link.tabIndex = 0;
    link.title = 'Open in your browser';
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      /* a drag that started on the link text still ends in a click */
      if (dragged) {
        dragged = false;
        return;
      }
      openLink(url);
    });
    link.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      /* the card's own Enter opens a rename; the link gets there first */
      e.stopPropagation();
      openLink(url);
    });
    return link;
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const found of links(text)) {
      if (found.start > at) frag.append(text.slice(at, found.start));
      frag.append(linkEl(found.url));
      at = found.end;
    }
    if (at < text.length) frag.append(text.slice(at));
    return frag;
  }

  /* ---------------- actions ---------------- */

  function addTask(status, title) {
    tasks = [...tasks, newTask(title, status)];
    save();
  }

  function removeTask(id) {
    const task = byId(id);
    if (!task) return;
    tasks = tasks.filter((t) => t.id !== id);
    save();
    paint();
    announce(`Deleted ${task.title}`);
  }

  function cyclePriority(id) {
    const task = byId(id);
    if (!task) return;
    const next = (PRIORITY_RING.indexOf(task.priority) + 1) % PRIORITY_RING.length;
    task.priority = PRIORITY_RING[next];
    save();
    paint();
  }

  function rename(id, title) {
    const task = byId(id);
    if (!task || !title || task.title === title) return;
    task.title = title;
    save();
  }

  /* Every move — drag, drop, or Alt+Arrow — goes through here. */
  function commit(id, status, index) {
    const task = byId(id);
    if (!task) return;
    const moved = task.status !== status;
    tasks = place(tasks, id, status, index);
    focusId = id;
    save();
    paint();
    if (moved) announce(`${task.title} moved to ${labelFor(status)}`);
  }

  /* Alt+Left / Alt+Right: the next column over, landing at the top. */
  function stepColumn(id, dir) {
    const task = byId(id);
    if (!task) return;
    const at = STATUSES.indexOf(task.status) + dir;
    if (at < 0 || at >= STATUSES.length) return;
    commit(id, STATUSES[at], 0);
  }

  /* Alt+Up / Alt+Down: swap with the neighbour in the same column. */
  function stepSlot(id, dir) {
    const task = byId(id);
    if (!task) return;
    const members = tasks.filter((t) => t.status === task.status);
    const at = members.indexOf(task) + dir;
    if (at < 0 || at >= members.length) return;
    commit(id, task.status, at);
  }

  /* ---------------- rendering ---------------- */

  function summary() {
    if (!tasks.length) return 'No tasks yet';
    const done = tasks.filter((t) => t.status === 'done').length;
    return `${tasks.length - done} open · ${done} done`;
  }

  function paint() {
    if (!host) return;

    /* read the view state before anything can change it, then clear it */
    const editing = editId;
    const composing = composer;
    const focus = focusId;
    editId = null;
    focusId = null;

    /* a repaint rebuilds every column, so a long one would jump back to the
       top on each drop and each edit: carry the scroll positions across */
    const scrolled = new Map();
    for (const list of host.querySelectorAll('.kb-list')) {
      if (list.dataset.status) scrolled.set(list.dataset.status, list.scrollTop);
    }

    host.textContent = '';
    host.append(stylesheet());

    const root = el('div', 'kb-root');

    const top = el('div', 'kb-top');
    top.append(el('span', 'kb-sub', summary()));
    top.append(el('span', 'kb-hint', 'drag a card between columns · double-click to rename'));
    root.append(top);

    const board = el('div', 'kb-board');
    for (const column of COLUMNS) board.append(columnEl(column, editing, composing, scrolled));
    root.append(board);

    liveEl = el('div', 'kb-live');
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    root.append(liveEl);

    host.append(root);

    const target = editing
      ? host.querySelector('.kb-edit')
      : focus
        ? host.querySelector(`.kb-card[data-id="${focus}"]`)
        : composing
          ? host.querySelector('.kb-new')
          : null;
    if (!target) return;
    target.focus();
    if (target.tagName === 'INPUT') target.select();
  }

  function columnEl(column, editing, composing, scrolled) {
    const cards = tasks.filter((t) => t.status === column.id);

    const wrap = el('section', 'kb-col');
    const head = el('header', 'kb-colhead');
    head.append(el('span', `kb-dot kb-dot-${column.id}`));
    head.append(el('span', 'kb-collabel', column.label));
    head.append(el('span', 'kb-count', String(cards.length)));
    wrap.append(head);

    const list = el('div', 'kb-list');
    list.dataset.status = column.id;
    if (!cards.length) list.append(el('div', 'kb-list-empty', 'drop a card here'));
    for (const task of cards) list.append(cardEl(task, editing));
    /* a column the pointer was not scrolled in keeps scrollTop 0 */
    const resume = scrolled.get(column.id);
    if (resume) list.scrollTop = resume;
    wrap.append(list);

    const foot = el('div', 'kb-colfoot');
    foot.append(composing === column.id ? composerInput(column.id) : addButton(column.id));
    wrap.append(foot);
    return wrap;
  }

  function cardEl(task, editing) {
    const node = el('article', `kb-card${task.status === 'done' ? ' kb-done' : ''}`);
    node.dataset.id = task.id;
    node.tabIndex = 0;
    node.title = 'Drag to move · Alt+←/→ changes column · Alt+↑/↓ reorders';

    if (editing === task.id) {
      node.append(editInput(task));
    } else {
      const title = el('div', 'kb-cardtitle');
      title.append(linkify(task.title));
      title.addEventListener('dblclick', (e) => {
        /* a double-click on a link is someone opening it, not renaming */
        if (e.target instanceof Element && e.target.closest('.kb-link')) return;
        editId = task.id;
        paint();
      });
      node.append(title);

      const meta = el('div', 'kb-meta');
      const priority = el(
        'button',
        `kb-pri${task.priority ? ` kb-pri-${task.priority}` : ' kb-pri-none'}`,
        task.priority || 'priority',
      );
      priority.type = 'button';
      priority.title = 'Set priority';
      priority.addEventListener('click', (e) => {
        e.stopPropagation();
        cyclePriority(task.id);
      });
      meta.append(priority);
      meta.append(el('span', 'kb-age', age(task.createdAt)));

      const del = el('button', 'kb-del', '×');
      del.type = 'button';
      del.title = 'Delete task';
      del.setAttribute('aria-label', `Delete ${task.title}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTask(task.id);
      });
      meta.append(del);
      node.append(meta);
    }

    node.addEventListener('pointerdown', (e) => onPointerDown(e, task.id, node));

    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editId = task.id;
        paint();
        return;
      }
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepColumn(task.id, -1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepColumn(task.id, 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        stepSlot(task.id, -1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        stepSlot(task.id, 1);
      }
    });

    return node;
  }

  function editInput(task) {
    const input = el('input', 'kb-edit');
    input.value = task.title;
    input.setAttribute('aria-label', 'Task title');
    let settled = false;
    const settle = (keep) => {
      if (settled) return;
      settled = true;
      if (keep) rename(task.id, input.value.trim());
      focusId = task.id;
      paint();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        settle(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    });
    input.addEventListener('blur', () => settle(true));
    return input;
  }

  function addButton(status) {
    const button = el('button', 'kb-add', '+ Add task');
    button.type = 'button';
    button.addEventListener('click', () => {
      composer = status;
      paint();
    });
    return button;
  }

  function composerInput(status) {
    const input = el('input', 'kb-new');
    input.placeholder = 'What needs doing?';
    input.setAttribute('aria-label', 'New task');

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        composer = null;
        paint();
        return;
      }
      if (e.key !== 'Enter') return;
      const title = input.value.trim();
      if (!title) {
        composer = null;
        paint();
        return;
      }
      addTask(status, title);
      /* stay open: three tasks in a row is the normal case */
      paint();
    });

    input.addEventListener('blur', () => {
      if (composer !== status) return;
      composer = null;
      /* swap in place instead of repainting: the click that blurred this input
         may have been "+ Add task" in another column, and a repaint here would
         pull that button out from under the click before it fires */
      input.replaceWith(addButton(status));
    });

    return input;
  }

  function clearMarks(list) {
    list.classList.remove('over');
    for (const card of list.querySelectorAll('.kb-card')) {
      card.classList.remove('kb-before', 'kb-after');
    }
  }

  function clearAllMarks() {
    if (!host) return;
    for (const list of host.querySelectorAll('.kb-list')) clearMarks(list);
  }

  /* ---------------- dragging ----------------
     Pointer events, not HTML5 drag-and-drop. It is how the app moves its own
     tabs, panes and workspaces; there is no dataTransfer round trip; and the
     pointer-up is whatever the mouse is over, not only the drop target. */

  function onPointerDown(e, id, node) {
    if (e.button !== 0 || drag) return;
    /* a fresh gesture: any suppression left over from the last one is stale */
    dragged = false;
    /* the priority chip, the delete button and the rename input keep their
       own gestures */
    if (e.target instanceof Element && e.target.closest('button, input')) return;
    drag = {
      id,
      node,
      started: false,
      fromX: e.clientX,
      fromY: e.clientY,
      offsetX: 0,
      offsetY: 0,
      ghost: null,
      list: null,
      index: 0,
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    /* a pointer released outside the window never delivers pointerup */
    window.addEventListener('blur', stopDrag);
  }

  function onPointerMove(e) {
    if (!drag) return;
    /* a few pixels of slack, so a click stays a click */
    if (!drag.started && Math.hypot(e.clientX - drag.fromX, e.clientY - drag.fromY) < 4) {
      return;
    }
    if (!drag.started) startDrag(e);
    followPointer(e);
  }

  function startDrag(e) {
    const node = drag.node;
    const rect = node.getBoundingClientRect();
    drag.started = true;
    drag.offsetX = e.clientX - rect.left;
    drag.offsetY = e.clientY - rect.top;

    const ghost = node.cloneNode(true);
    ghost.classList.remove('dragging', 'kb-before', 'kb-after');
    ghost.classList.add('kb-ghost');
    ghost.style.width = rect.width + 'px';
    document.body.append(ghost);
    drag.ghost = ghost;

    node.classList.add('dragging');
    document.body.classList.add('kb-dragging');
    dragged = true;
    /* the pointer swept a text selection on its way here */
    window.getSelection()?.removeAllRanges();
    document.addEventListener('keydown', onDragKey);
  }

  function followPointer(e) {
    if (drag.ghost) {
      drag.ghost.style.left = e.clientX - drag.offsetX + 'px';
      drag.ghost.style.top = e.clientY - drag.offsetY + 'px';
    }
    /* the ghost is pointer-events:none, so hit testing still sees the board */
    /** @type {HTMLElement | null} */
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.kb-list') ?? null;
    if (!host) return;
    for (const list of host.querySelectorAll('.kb-list')) {
      if (list !== under) clearMarks(list);
    }
    drag.list = under;
    if (!under) return;

    under.classList.add('over');
    const cards = [...under.querySelectorAll('.kb-card')].filter(
      (card) => card instanceof HTMLElement && card.dataset.id !== drag.id,
    );
    const at = dropIndex(cards.map((c) => c.getBoundingClientRect()), e.clientY);
    drag.index = at;
    /* the slot bar sits above the card it would land on, or below the last
       one when the slot is the end of the column */
    for (const card of cards) card.classList.remove('kb-before', 'kb-after');
    if (at >= cards.length) cards[cards.length - 1]?.classList.add('kb-after');
    else cards[at].classList.add('kb-before');
  }

  function onDragKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    stopDrag();
  }

  /* Ends the gesture either way. Dropping outside a column just puts the card
     back: its position only ever changes through commit(). */
  function stopDrag() {
    if (!drag) return;
    const { id, node, ghost, list, index, started } = drag;
    if (ghost) ghost.remove();
    node.classList.remove('dragging');
    document.body.classList.remove('kb-dragging');
    document.removeEventListener('keydown', onDragKey);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    window.removeEventListener('blur', stopDrag);
    drag = null;
    clearAllMarks();
    const status = list?.dataset.status;
    if (started && status) commit(id, status, index);
  }

  function stylesheet() {
    const style = document.createElement('style');
    style.textContent = `
      /* the host gives a plugin tab min-height:100% and lets the page scroll
         (styles.css .plugin-tab-page). The board takes that over so only the
         columns scroll, and the toolbar stays put. */
      .plugin-tab-page { height: 100%; min-height: 0; padding: 0; overflow: hidden;
                         display: flex; box-sizing: border-box; }
      .kb-root { display: flex; flex-direction: column; flex: 1; min-height: 0;
                 padding: 14px 16px 16px; gap: 12px; font: inherit; color: inherit; }
      .kb-top { display: flex; align-items: baseline; gap: 10px; flex: 0 0 auto; }
      .kb-sub { font-size: 12px; font-weight: 600; color: var(--ink-2); }
      .kb-hint { margin-left: auto; font-size: 11.5px; color: var(--ink-3); }
      .kb-board { display: flex; gap: 12px; flex: 1; min-height: 0; align-items: stretch;
                  overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
      .kb-col { display: flex; flex-direction: column; flex: 0 0 258px; min-height: 0;
                border: 1px solid var(--line); border-radius: 12px; background: var(--tint);
                overflow: hidden; }
      .kb-colhead { display: flex; align-items: center; gap: 8px; padding: 9px 12px;
                    border-bottom: 1px solid var(--line); flex: 0 0 auto; }
      .kb-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
      .kb-dot-todo { background: var(--ink-3); }
      .kb-dot-doing { background: var(--accent); }
      .kb-dot-done { background: var(--ink-3); opacity: .5; }
      .kb-collabel { font-size: 11.5px; font-weight: 600; letter-spacing: .06em;
                     text-transform: uppercase; color: var(--ink-2); }
      .kb-count { margin-left: auto; font-size: 11px; color: var(--ink-3);
                  background: var(--surface); border: 1px solid var(--line);
                  border-radius: 999px; padding: 0 7px; }
      .kb-list { flex: 1; min-height: 0; overflow-y: auto; display: flex;
                 flex-direction: column; gap: 8px; padding: 9px; border-radius: 9px; }
      .kb-list.over { background: var(--accent-tint); box-shadow: inset 0 0 0 1.5px var(--accent); }
      .kb-list.over .kb-list-empty { display: none; }
      .kb-list-empty { margin: auto 0; padding: 10px; border: 1px dashed var(--line-2);
                       border-radius: 9px; text-align: center; font-size: 11.5px;
                       color: var(--ink-3); }
      .kb-card { position: relative; background: var(--surface); border: 1px solid var(--line);
                 border-radius: 9px; padding: 9px 10px; cursor: grab;
                 box-shadow: 0 1px 2px rgba(0,0,0,.05);
                 transition: box-shadow .12s ease, border-color .12s ease; }
      .kb-card:hover { border-color: var(--line-2); box-shadow: 0 3px 10px rgba(0,0,0,.09); }
      .kb-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
      .kb-card.dragging { opacity: .4; cursor: grabbing; }
      body.kb-dragging { cursor: grabbing; user-select: none; }
      /* the card that follows the pointer; .kb-ghost comes after .kb-card so
         its fixed position wins over the card's relative one */
      .kb-ghost { position: fixed; z-index: 999; pointer-events: none; opacity: .93;
                  box-shadow: 0 12px 28px rgba(0,0,0,.24); transform: rotate(1.2deg); }
      .kb-card.kb-before::before, .kb-card.kb-after::after {
        content: ''; position: absolute; left: 2px; right: 2px; height: 2px;
        border-radius: 2px; background: var(--accent); }
      .kb-card.kb-before::before { top: -6px; }
      .kb-card.kb-after::after { bottom: -6px; }
      .kb-cardtitle { font-size: 13px; line-height: 1.35; color: var(--ink);
                      overflow-wrap: anywhere; white-space: pre-wrap; }
      .kb-done .kb-cardtitle { color: var(--ink-3); text-decoration: line-through; }
      /* a URL in a title is clickable and opens in the system browser */
      .kb-link { color: var(--accent-ink); text-decoration: underline;
                 text-underline-offset: 2px; cursor: pointer; }
      .kb-link:hover { color: var(--accent); }
      .kb-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px;
                               border-radius: 3px; }
      .kb-meta { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
      .kb-age { font-size: 11px; color: var(--ink-3); }
      .kb-pri { font: inherit; font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase;
                border: 1px solid var(--line-2); border-radius: 999px; padding: 0 7px;
                background: transparent; color: var(--ink-2); cursor: pointer; }
      .kb-pri-medium { color: var(--accent-ink); border-color: var(--accent); background: var(--accent-tint); }
      .kb-pri-high { color: var(--danger); border-color: var(--danger); }
      .kb-pri-none { opacity: 0; }
      .kb-card:hover .kb-pri-none, .kb-card:focus-within .kb-pri-none { opacity: 1; }
      .kb-del { margin-left: auto; border: 0; background: transparent; color: var(--ink-3);
                font: inherit; font-size: 15px; line-height: 1; padding: 0 3px;
                border-radius: 5px; cursor: pointer; opacity: 0; }
      .kb-card:hover .kb-del, .kb-card:focus-within .kb-del { opacity: 1; }
      .kb-del:hover { color: var(--danger); background: var(--tint); }
      .kb-colfoot { flex: 0 0 auto; padding: 0 9px 9px; }
      .kb-add { width: 100%; text-align: left; font: inherit; font-size: 12px; color: var(--ink-3);
                background: transparent; border: 1px dashed transparent; border-radius: 8px;
                padding: 6px 8px; cursor: pointer; }
      .kb-add:hover { color: var(--ink); background: var(--tint); border-color: var(--line-2); }
      .kb-new, .kb-edit { width: 100%; box-sizing: border-box; font: inherit;
                          font-size: 12.5px; color: var(--ink); background: var(--surface);
                          border: 1px solid var(--accent); border-radius: 8px; padding: 7px 9px;
                          outline: none; }
      .kb-new::placeholder { color: var(--ink-3); }
      .kb-edit { font-size: 13px; }
      .kb-live { position: absolute; width: 1px; height: 1px; overflow: hidden;
                 clip-path: inset(50%); white-space: nowrap; }
      :root.dark .kb-card { box-shadow: 0 1px 2px rgba(0,0,0,.4); }
      :root.dark .kb-card:hover { box-shadow: 0 3px 10px rgba(0,0,0,.45); }
    `;
    return style;
  }

  /* ---------------- wiring ---------------- */

  ctx.ui.tab(TAB_ID, (node) => {
    host = node;
    paint();
    /* the tab body can be torn down and rebuilt; drop the host so paint()
       never writes into a detached node */
    return () => {
      if (host === node) host = null;
    };
  });

  ctx.ui.command('farrasjibran.kanban.open', () => ctx.ui.openTab(TAB_ID));

  /* the board is read once per activation; the tab paints from what is already
     in memory, so switching to it never waits on storage */
  void ctx.storage
    .get('board')
    .then((raw) => {
      /* the user got to the board before it loaded: their board wins */
      if (!tasks.length) tasks = normalize(raw);
      paint();
    })
    .catch((e) => ctx.log('kanban: could not read the board', e));

  /* Declaring a service is what makes a plugin load at boot instead of on
     first click (docs/PLUGIN_PLATFORM.md section 2). The board itself stays
     closed: this only keeps the plugin alive from the first frame, so its
     sidebar entry, its palette command and its tab renderer are in place
     before anything asks for them. */
  ctx.ui.service('farrasjibran.kanban.boot', () => {
    ctx.log('kanban ready');
  });
}
