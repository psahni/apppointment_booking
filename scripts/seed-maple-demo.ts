import { createDatabase } from "../src/db/connection";
import { seedMapleDemo } from "../src/modules/identity/seed-maple-demo";

async function main() {
  const url = process.env.MAPLE_DEMO_DATABASE_URL;
  if (!url) {
    process.stderr.write("Set MAPLE_DEMO_DATABASE_URL to the Maple Clinic Neon preview branch connection string.\n");
    process.exitCode = 1;
    return;
  }
  const { db, pool } = createDatabase(url, 1);
  try {
    const { patientsCreated, staffCreated } = await seedMapleDemo(db);
    process.stdout.write(`Maple demo setup complete. Created ${patientsCreated} patient and ${staffCreated} staff accounts.\n`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write("Maple demo setup failed. Check the preview database connection, migrations and sample staff roles.\n");
  process.exitCode = 1;
});
