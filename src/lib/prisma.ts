import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { makePgPool } from "./lakebase";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function buildClient(): PrismaClient {
  const log =
    process.env.NODE_ENV === "development"
      ? (["warn", "error"] as const)
      : (["error"] as const);

  // Immer über den pg-Treiber-Adapter (queryCompiler-Client hat keine eigene Engine).
  // Lokal ist der Pool eine normale Postgres, im Lakebase-Modus eine mit Token-Erneuerung.
  // Das Schema MUSS dem Adapter mitgegeben werden: lokal "public", als App "windguru".
  const schema = process.env.LAKEBASE_SCHEMA || "public";
  return new PrismaClient({
    adapter: new PrismaPg(makePgPool(), { schema }),
    log: [...log],
  });
}

export const prisma = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
