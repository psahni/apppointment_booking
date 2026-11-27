const previewOrigin = "https://apppointment-booking-git-vercel-preview-nuvortiq.vercel.app";

export const mapleDemoPatients = [
  { name: "Prashant Demo", email: "prashant@mapleclinic.example" },
  { name: "Maple Demo", email: "hello@mapleclinic.example" },
  { name: "Alex Demo", email: "alex@mapleclinic.example" },
];

export const mapleDemoCode = "462839";

export const mapleDemoStaff = [
  { name: "Maple Reception Demo", email: "reception@mapleclinic.example" },
  { name: "Maple Staff Demo", email: "staff@mapleclinic.example" },
];

export function mapleWhatsAppDemoEnabled(source: Record<string, string | undefined> = process.env) {
  return source.VERCEL_ENV === "preview" && source.PATIENT_DEMO_MODE === "true" &&
    source.APP_URL?.replace(/\/$/, "") === previewOrigin;
}

export function mapleDemoEnabled(source: Record<string, string | undefined> = process.env) {
  if (source.VERCEL_ENV !== "preview" || source.PATIENT_DEMO_MODE !== "true" || !source.APP_URL) return false;
  const origin = source.APP_URL.replace(/\/$/, "");
  if (mapleWhatsAppDemoEnabled(source)) return true;
  return source.VERCEL_GIT_COMMIT_REF === "feat/maple-patient-demo" &&
    [source.VERCEL_BRANCH_URL, source.VERCEL_URL].some((host) =>
      host?.endsWith(".vercel.app") && origin === `https://${host}`);
}

export function isMapleDemoPatient(email: string) {
  return mapleDemoPatients.some((patient) => patient.email === email);
}
