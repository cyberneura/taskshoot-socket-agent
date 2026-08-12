import assert from "node:assert/strict";
import { test } from "node:test";

const {
  collectUnreadPages,
  NOTIFICATION_PAGE_SIZE_FOR_TESTS: PAGE_SIZE,
  MAX_NOTIFICATION_PAGES_FOR_TESTS: MAX_PAGES,
} = await import("../src/taskshoot.js");

type Row = { id: string };

/** A server holding `total` unread rows, newest first, answering the same
 * `before` cursor the CLI sends. */
function fakeServer(total: number) {
  const rows: Row[] = Array.from({ length: total }, (_, i) => ({
    // Descending ids so "newest first" and "before = older than" line up.
    id: `n${String(total - i).padStart(5, "0")}`,
  }));
  const calls: (string | undefined)[] = [];
  const fetchPage = async (before?: string) => {
    calls.push(before);
    const start = before ? rows.findIndex((r) => r.id === before) + 1 : 0;
    return rows.slice(start, start + PAGE_SIZE) as never[];
  };
  return { rows, calls, fetchPage };
}

const withCursor = async () => true;
const withoutCursor = async () => false;

test("a short first page is the whole list and costs one request", async () => {
  const server = fakeServer(3);

  const items = await collectUnreadPages(server.fetchPage, withCursor);

  assert.deepEqual(
    items.map((i) => i.id),
    server.rows.map((r) => r.id),
  );
  assert.equal(server.calls.length, 1);
});

test("a backlog deeper than one page is walked with the cursor", async () => {
  const server = fakeServer(PAGE_SIZE * 2 + 5);

  const items = await collectUnreadPages(server.fetchPage, withCursor);

  // Every row, in order, with no duplicates.
  assert.deepEqual(
    items.map((i) => i.id),
    server.rows.map((r) => r.id),
  );
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  // First page has no cursor; each later page starts after the previous last.
  assert.deepEqual(server.calls, [
    undefined,
    server.rows[PAGE_SIZE - 1]!.id,
    server.rows[PAGE_SIZE * 2 - 1]!.id,
  ]);
});

test("an exactly-full backlog stops on the following empty page", async () => {
  const server = fakeServer(PAGE_SIZE);

  const items = await collectUnreadPages(server.fetchPage, withCursor);

  assert.equal(items.length, PAGE_SIZE);
  // The full page cannot be known to be the last one without asking again.
  assert.equal(server.calls.length, 2);
});

test("an older CLI degrades to the newest page instead of failing", async () => {
  const server = fakeServer(PAGE_SIZE * 3);

  const items = await collectUnreadPages(server.fetchPage, withoutCursor);

  assert.equal(items.length, PAGE_SIZE);
  assert.equal(server.calls.length, 1);
});

test("the cursor is only checked when a second page is needed", async () => {
  const server = fakeServer(1);
  let asked = 0;

  await collectUnreadPages(server.fetchPage, async () => {
    asked += 1;
    return true;
  });

  assert.equal(asked, 0);
});

test("paging stops at the page cap and leaves the rest for the next poll", async () => {
  // Deeper than the cap: the loop must not walk it forever.
  const server = fakeServer(PAGE_SIZE * (MAX_PAGES + 3));

  const items = await collectUnreadPages(server.fetchPage, withCursor);

  assert.equal(items.length, PAGE_SIZE * MAX_PAGES);
  assert.equal(server.calls.length, MAX_PAGES);
});

test("a backlog ending exactly on the cap is returned whole", async () => {
  // The boundary: everything fits, but the loop cannot tell that apart from a
  // deeper backlog without another request — so it stops and says "may remain".
  const server = fakeServer(PAGE_SIZE * MAX_PAGES);

  const items = await collectUnreadPages(server.fetchPage, withCursor);

  assert.deepEqual(
    items.map((i) => i.id),
    server.rows.map((r) => r.id),
  );
  assert.equal(server.calls.length, MAX_PAGES);
});
