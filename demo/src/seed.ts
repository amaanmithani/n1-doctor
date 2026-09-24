import { prisma } from './db.js';

export async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "User", "Post", "Comment", "Tag", "AuditLog", "_PostToTag" RESTART IDENTITY CASCADE',
  );
  await prisma.user.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ name: `user${i + 1}` })) });
  await prisma.post.createMany({
    data: Array.from({ length: 20 }, (_, i) => ({ title: `Post ${i + 1}`, authorId: (i % 12) + 1 })),
  });
  await prisma.comment.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      body: `c${i}`,
      postId: (i % 20) + 1,
      authorId: ((i * 5) % 12) + 1,
    })),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed();
  await prisma.$disconnect();
}
