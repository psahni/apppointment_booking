import { createPatientAuthHandler } from "@/modules/identity/patient-http";
import { getIdentity } from "@/modules/identity/server";
import { readAuthEnvironment } from "@/platform/env";
import { mapleDemoEnabled } from "@/modules/identity/maple-demo";

const handle = createPatientAuthHandler(() => getIdentity().patient, () => getIdentity().patient.options.baseURL,
  () => mapleDemoEnabled() || readAuthEnvironment().AUTH_TEST_MODE);
export const POST = handle;
export const GET = handle;
