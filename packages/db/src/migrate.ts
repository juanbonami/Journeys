import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "./client";

const here = path.dirname(fileURLToPath(import.meta.url));
const { db, pool } = createDb();
await migrate(db, { migrationsFolder: path.join(here, "../drizzle") });
await pool.end();
console.log("migrations applied");
