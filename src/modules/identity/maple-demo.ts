const previewOrigin = "https://apppointment-booking-git-vercel-preview-nuvortiq.vercel.app";

export const mapleDemoPatients = [
  { name: "Prashant Demo", email: "prashant@mapleclinic.example" },
  { name: "Maple Demo", email: "hello@mapleclinic.example" },
  { name: "Alex Demo", email: "alex@mapleclinic.example" },
];

export const mapleDemoCode = "462839";

export function mapleDemoEnabled(source: Record<string, string | undefined> = process.env) {
  return source.VERCEL_ENV === "preview" && source.PATIENT_DEMO_MODE === "true" &&
    (source.APP_URL === previewOrigin || source.APP_URL === `${previewOrigin}/`);
}

export function isMapleDemoPatient(email: string) {
  return mapleDemoPatients.some((patient) => patient.email === email);
}
