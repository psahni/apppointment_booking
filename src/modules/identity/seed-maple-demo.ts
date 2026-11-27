import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ApplicationDatabase } from "@/db/connection";
import { patientUser, staffAccess, staffUser } from "@/db/schema/auth";
import { mapleDemoPatients, mapleDemoStaff } from "./maple-demo";

export function seedMapleDemo(db: ApplicationDatabase) {
  return db.transaction(async (tx) => {
    const patients = await tx.insert(patientUser)
      .values(mapleDemoPatients.map((patient) => ({ ...patient, id: randomUUID() })))
      .onConflictDoNothing({ target: patientUser.email }).returning({ id: patientUser.id });

    let staffCreated = 0;
    for (const staff of mapleDemoStaff) {
      const [created] = await tx.insert(staffUser).values({ ...staff, id: randomUUID() })
        .onConflictDoNothing({ target: staffUser.email }).returning({ id: staffUser.id });
      if (created) {
        await tx.insert(staffAccess).values({ userId: created.id, role: "staff" });
        staffCreated++;
      } else {
        const [existing] = await tx.select({ role: staffAccess.role }).from(staffUser)
          .leftJoin(staffAccess, eq(staffAccess.userId, staffUser.id)).where(eq(staffUser.email, staff.email));
        if (existing?.role !== "staff") throw new Error("A sample staff address is already assigned to a different role.");
      }
    }
    return { patientsCreated: patients.length, staffCreated };
  });
}
