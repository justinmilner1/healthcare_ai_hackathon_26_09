import { PrismaClient } from "@prisma/client";

// One Prisma client per process. Next dev reloads modules; the global keeps connections sane.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
