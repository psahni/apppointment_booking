import { createPatientAuthHandler } from "@/modules/identity/patient-http";
import { getWebPatientAuth } from "@/modules/identity/server";
import { readAuthEnvironment } from "@/platform/env";
import { mapleDemoEnabled } from "@/modules/identity/maple-demo";

const handle = createPatientAuthHandler(getWebPatientAuth, () => getWebPatientAuth().options.baseURL,
  () => mapleDemoEnabled() || readAuthEnvironment().AUTH_TEST_MODE);
export const POST = handle;
export const GET = handle;
