import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/n1doctor_demo';
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) });
