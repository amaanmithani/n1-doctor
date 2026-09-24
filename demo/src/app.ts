// A small blog API with deliberate N+1 bugs, their fixes, and routes that
// look like N+1s but aren't. Labels live in eval.ts.
import DataLoader from 'dataloader';
import express from 'express';
import { prisma } from './db.js';
import { here } from './tracing.js';

export const app = express();
app.use(express.json());

const TAGS = ['go', 'rust', 'ts', 'sql', 'otel', 'k8s', 'wasm', 'ml'];

// Author per post, one query each.
app.get('/feed/n1', async (_req, res) => {
  here();
  const posts = await prisma.post.findMany({ take: 20, orderBy: { id: 'asc' } });
  const out = [];
  for (const p of posts)
    out.push({ ...p, author: await prisma.user.findUnique({ where: { id: p.authorId } }) });
  res.json(out);
});
app.get('/feed/fixed', async (_req, res) => {
  here();
  res.json(await prisma.post.findMany({ take: 20, orderBy: { id: 'asc' }, include: { author: true } }));
});

// Post count per user.
app.get('/users/n1', async (_req, res) => {
  here();
  const users = await prisma.user.findMany();
  const out = [];
  for (const u of users) out.push({ ...u, posts: await prisma.post.count({ where: { authorId: u.id } }) });
  res.json(out);
});
app.get('/users/fixed', async (_req, res) => {
  here();
  const [users, counts] = await Promise.all([
    prisma.user.findMany(),
    prisma.post.groupBy({ by: ['authorId'], _count: { _all: true } }),
  ]);
  const byAuthor = new Map(counts.map((c) => [c.authorId, c._count._all]));
  res.json(users.map((u) => ({ ...u, posts: byAuthor.get(u.id) ?? 0 })));
});

// Comment authors fetched concurrently: still one query per comment.
app.get('/comments/n1', async (_req, res) => {
  here();
  const comments = await prisma.comment.findMany();
  res.json(
    await Promise.all(
      comments.map(async (c) => ({
        ...c,
        author: await prisma.user.findFirst({ where: { id: c.authorId } }),
      })),
    ),
  );
});
// Looks identical, but Prisma batches findUnique calls made in the same tick
// into one query, so there is no N+1 on the wire.
app.get('/comments/batched', async (_req, res) => {
  here();
  const comments = await prisma.comment.findMany();
  res.json(
    await Promise.all(
      comments.map(async (c) => ({
        ...c,
        author: await prisma.user.findUnique({ where: { id: c.authorId } }),
      })),
    ),
  );
});
app.get('/comments/fixed', async (_req, res) => {
  here();
  // DataLoader collects the keys requested in one tick into a single query.
  const users = new DataLoader(async (ids: readonly number[]) => {
    const rows = await prisma.user.findMany({ where: { id: { in: [...ids] } } });
    const byId = new Map(rows.map((u) => [u.id, u]));
    return ids.map((id) => byId.get(id) ?? null);
  });
  const comments = await prisma.comment.findMany();
  res.json(await Promise.all(comments.map(async (c) => ({ ...c, author: await users.load(c.authorId) }))));
});

// One insert per audit event.
app.post('/audit/n1', async (_req, res) => {
  here();
  for (let i = 0; i < 10; i++) await prisma.auditLog.create({ data: { event: 'viewed', refId: i } });
  res.json({ ok: true });
});
app.post('/audit/fixed', async (_req, res) => {
  here();
  await prisma.auditLog.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({ event: 'viewed', refId: i })),
  });
  res.json({ ok: true });
});

// One update per post.
app.post('/views/n1', async (_req, res) => {
  here();
  for (let id = 1; id <= 12; id++)
    await prisma.post.update({ where: { id }, data: { views: { increment: 1 } } });
  res.json({ ok: true });
});
app.post('/views/fixed', async (_req, res) => {
  here();
  await prisma.post.updateMany({ where: { id: { lte: 12 } }, data: { views: { increment: 1 } } });
  res.json({ ok: true });
});

// One upsert per tag name.
app.post('/tags/n1', async (_req, res) => {
  here();
  for (const name of TAGS) await prisma.tag.upsert({ where: { name }, create: { name }, update: {} });
  res.json({ ok: true });
});
app.post('/tags/fixed', async (_req, res) => {
  here();
  await prisma.tag.createMany({ data: TAGS.map((name) => ({ name })), skipDuplicates: true });
  res.json({ ok: true });
});

// Look-alike: many queries, all different.
app.get('/dashboard', async (_req, res) => {
  here();
  res.json({
    users: await prisma.user.count(),
    posts: await prisma.post.count(),
    comments: await prisma.comment.count(),
    tags: await prisma.tag.count(),
    latest: await prisma.post.findFirst({ orderBy: { createdAt: 'desc' } }),
    top: await prisma.post.findFirst({ orderBy: { views: 'desc' } }),
    audits: await prisma.auditLog.count(),
  });
});

// A real N+1, but only three iterations: below the default threshold.
app.get('/pinned', async (_req, res) => {
  here();
  const out = [];
  for (const id of [1, 2, 3]) out.push(await prisma.post.findUnique({ where: { id } }));
  res.json(out);
});

// Look-alike: keyset pagination in a loop. Each page depends on the last,
// so these can't be merged into one query.
app.get('/export', async (_req, res) => {
  here();
  const out = [];
  let cursor = 0;
  for (;;) {
    const page = await prisma.post.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: 3,
    });
    if (!page.length) break;
    out.push(...page);
    cursor = page[page.length - 1]!.id;
  }
  res.json(out);
});

// Look-alike: a transaction with several different statements.
app.post('/publish', async (_req, res) => {
  here();
  const post = await prisma.$transaction(async (tx) => {
    const p = await tx.post.create({ data: { title: 'draft', authorId: 1 } });
    await tx.auditLog.create({ data: { event: 'published', refId: p.id } });
    await tx.user.update({ where: { id: 1 }, data: { name: 'user1' } });
    return tx.post.findUnique({ where: { id: p.id }, include: { author: true } });
  });
  res.json(post);
});

// Look-alike: one IN query for many ids.
app.get('/by-ids', async (_req, res) => {
  here();
  res.json(
    await prisma.post.findMany({ where: { id: { in: Array.from({ length: 15 }, (_, i) => i + 1) } } }),
  );
});
