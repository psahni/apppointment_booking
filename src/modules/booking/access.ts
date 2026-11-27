import "server-only";
import { and, eq, gt, sql } from "drizzle-orm";
import type { ApplicationDatabase } from "@/db/connection";
import { patientSession, patientUser } from "@/db/schema/auth";
import { whatsappPatientLinks } from "@/db/schema/notifications";
import { BookingError, type WhatsAppBookingPrincipal } from "./models";

type Transaction = Parameters<Parameters<ApplicationDatabase["transaction"]>[0]>[0];

export async function verifiedPatientEmail(tx: Transaction, principal: WhatsAppBookingPrincipal) {
  if ("linkHash" in principal) {
    const [linked] = await tx.select({ email: patientUser.email }).from(whatsappPatientLinks)
      .innerJoin(patientUser, eq(patientUser.id, whatsappPatientLinks.patientUserId))
      .where(and(eq(patientUser.id, principal.userId), eq(patientUser.email, principal.email),
        eq(patientUser.emailVerified, true), eq(whatsappPatientLinks.linkHash, principal.linkHash)))
      .for("share", { of: whatsappPatientLinks });
    return linked?.email;
  }
  const [current] = await tx.select({ email: patientUser.email }).from(patientSession)
    .innerJoin(patientUser, eq(patientUser.id, patientSession.userId))
    .where(and(eq(patientSession.id, principal.sessionId), eq(patientSession.userId, principal.userId),
      gt(patientSession.expiresAt, sql`clock_timestamp()`), eq(patientUser.emailVerified, true)));
  return current?.email;
}

type PatientAuth = {
  api: { getSession(input: { headers: Headers; query: { disableCookieCache: true; disableRefresh: true } }):
    Promise<{ session: { id: string; userId: string } } | null> };
};

export function createPatientBookingAccess(patientAuth: PatientAuth) {
  return async (headers: Headers) => {
    const authenticated = await patientAuth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
    if (!authenticated) throw new BookingError(401, "SIGN_IN_REQUIRED", "Sign in to book an appointment.");
    return { userId: authenticated.session.userId, sessionId: authenticated.session.id };
  };
}
