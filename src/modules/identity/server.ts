import "server-only";
import { getDatabase } from "@/db/server";
import { readAuthEnvironment } from "@/platform/env";
import { unconfiguredMailer } from "@/platform/mail";
import { createLocalAuthMailer } from "@/platform/local-auth-mailer";
import { createIdentity } from "./create-auth";
import { mapleDemoEnabled } from "./maple-demo";

let identity: ReturnType<typeof createIdentity> | undefined;
let mapleDemoIdentity: ReturnType<typeof createIdentity> | undefined;

function configuredIdentity(patientDemoMode: boolean) {
  const env = readAuthEnvironment();
  const { db } = getDatabase();
  return createIdentity({ db, baseURL: env.APP_URL, patientSecret: env.PATIENT_AUTH_SECRET, staffSecret: env.STAFF_AUTH_SECRET,
    mailer: env.LOCAL_AUTH_EMAIL_PREVIEW ? createLocalAuthMailer() : unconfiguredMailer, testMode: env.AUTH_TEST_MODE, patientDemoMode });
}

// Lazy initialization: importing a page must not open database connections at build time.
export function getIdentity() {
  return identity ??= configuredIdentity(false);
}

export function getWebPatientAuth() {
  if (!mapleDemoEnabled()) return getIdentity().patient;
  return (mapleDemoIdentity ??= configuredIdentity(true)).patient;
}
