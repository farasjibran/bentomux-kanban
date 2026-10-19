/* The one check for the board's ordering maths:
 *
 *   node farrasjibran.kanban/index.test.mjs
 *
 * place() is where a drag goes wrong quietly — a card landing in the right
 * column at the wrong index, or a column the user is not looking at getting
 * reshuffled. That is pinned down here, without a DOM.
 */

import assert from 'node:assert/strict';
import { place, dropIndex, links } from './index.js';

const card = (id, status) => ({ id, title: id, status, priority: '', createdAt: 0 });
const ids = (list) => list.map((t) => t.id);
const statuses = (list) => list.map((t) => t.status);

const board = [card('a', 'todo'), card('b', 'todo'), card('c', 'doing'), card('d', 'done')];

/* into a column that has cards already: lands at the slot, keeps the rest */
const moved = place(board, 'a', 'doing', 0);
assert.deepEqual(ids(moved), ['b', 'a', 'c', 'd']);
assert.deepEqual(statuses(moved), ['todo', 'doing', 'doing', 'done']);
assert.notEqual(moved, board, 'place() must return a new array');

/* a slot past the end of the column clamps to the end of *that* column — the
   case that would otherwise reshuffle a column the user is not in */
const board2 = [
  card('x', 'doing'),
  card('a', 'todo'),
  card('b', 'todo'),
  card('y', 'doing'),
  card('z', 'done'),
];
assert.deepEqual(ids(place(board2, 'y', 'todo', 99)), ['x', 'a', 'b', 'y', 'z']);

/* ...and the same card at the top of that column */
assert.deepEqual(ids(place(board2, 'y', 'todo', 0)), ['x', 'y', 'a', 'b', 'z']);

/* reordering inside one column */
assert.deepEqual(ids(place(board, 'b', 'todo', 0)), ['b', 'a', 'c', 'd']);
assert.deepEqual(ids(place(board, 'a', 'todo', 1)), ['b', 'a', 'c', 'd']);

/* an empty column takes the card wherever the pointer was */
assert.deepEqual(ids(place([card('a', 'todo')], 'a', 'done', 5)), ['a']);

/* an id that is not on the board comes back untouched */
assert.equal(place(board, 'nope', 'done', 0), board);

/* dropIndex: before the first midpoint, between the two, past the last */
const rects = [
  { top: 0, bottom: 20 },
  { top: 28, bottom: 48 },
];
assert.equal(dropIndex(rects, -5), 0);
assert.equal(dropIndex(rects, 5), 0);
assert.equal(dropIndex(rects, 14), 1);
assert.equal(dropIndex(rects, 30), 1);
assert.equal(dropIndex(rects, 38), 2);
assert.equal(dropIndex([], 10), 0);

/* link picking, for the clickable URLs in a task title */
assert.deepEqual(links('no links here'), []);
assert.deepEqual(
  links('see https://a.dev/x for docs').map((l) => l.url),
  ['https://a.dev/x'],
);
/* a full stop belongs to the sentence, not to the URL */
assert.deepEqual(links('done. https://a.dev/x.').map((l) => l.url), ['https://a.dev/x']);
/* brackets around a link are not part of it */
assert.deepEqual(links('(https://a.dev/x)').map((l) => l.url), ['https://a.dev/x']);
/* a bare www host still counts, and keeps its query */
assert.deepEqual(links('www.example.com/a?b=1').map((l) => l.url), ['www.example.com/a?b=1']);
/* a comma ends a token, so two links stay two links */
assert.deepEqual(
  links('https://a.dev/x, http://b.dev/y').map((l) => l.url),
  ['https://a.dev/x', 'http://b.dev/y'],
);
/* anything without a scheme or a www host is not a link */
assert.deepEqual(links('mailto:me@a.dev and a.dev/x'), []);
/* the span the renderer links is exactly the text reported here */
const quoted = 'see https://a.dev/x.';
const first = links(quoted)[0];
assert.equal(quoted.slice(first.start, first.end), first.url);

console.log('kanban board maths ok');
