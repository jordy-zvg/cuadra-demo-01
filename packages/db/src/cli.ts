/** Uso: DATABASE_URL=... tsx src/cli.ts migrate|seed */
import { connectPostgres, migratePostgres } from "./node.js";
import { seedDemo } from "./seed.js";

const cmd = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url || (cmd !== "migrate" && cmd !== "seed")) {
  process.stderr.write("Uso: DATABASE_URL=... tsx src/cli.ts migrate|seed\n");
  process.exit(2);
}
const { db, pool } = await connectPostgres(url);
try {
  if (cmd === "migrate") {
    const applied = await migratePostgres(pool);
    process.stdout.write(`${JSON.stringify({ msg: "migrated", applied })}\n`);
  } else {
    await seedDemo(db);
    process.stdout.write(`${JSON.stringify({ msg: "seeded" })}\n`);
  }
} finally {
  await pool.end();
}
