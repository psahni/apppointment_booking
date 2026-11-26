import { chromium, expect, type Page } from "@playwright/test";

const braveExecutable = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const previewSettings = "https://apppointment-booking-git-vercel-preview-nuvortiq.vercel.app/admin/settings";
const fields = {
  "Clinic name": "Maple Clinic",
  "Doctor name": "Dr Alex Morgan",
  "Contact email (optional)": "hello@mapleclinic.example",
  "Contact phone (optional)": "",
  "Appointment duration (minutes)": "20",
  "Buffer before (minutes)": "0",
  "Buffer after (minutes)": "0",
  "Minimum notice (minutes)": "60",
  "Book ahead (days)": "30",
};
const timezone = "Europe/London";
const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const weekend = ["Saturday", "Sunday"];
const opening = "08:00";
const closing = "18:30";

export async function fillAndSaveMapleClinic(page: Page) {
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save settings", exact: true }) });
  for (const [label, value] of Object.entries(fields)) {
    await form.getByLabel(label, { exact: true }).fill(value);
  }
  await form.getByLabel("Clinic timezone", { exact: true }).selectOption(timezone);

  for (const day of [...weekdays, ...weekend]) {
    const group = form.getByRole("group", { name: `${day} hours`, exact: true });
    const intervals = group.getByRole("button", { name: new RegExp(`^Remove ${day} interval \\d+$`) });
    while (await intervals.count()) await intervals.last().click();
    if (weekdays.includes(day)) {
      await group.getByRole("button", { name: `Add ${day} hours`, exact: true }).click();
      await group.getByLabel(`${day} opening time 1`, { exact: true }).fill(opening);
      await group.getByLabel(`${day} closing time 1`, { exact: true }).fill(closing);
    }
  }

  await form.getByRole("button", { name: "Save settings", exact: true }).click();
  const saved = form.getByText("Clinic settings saved.", { exact: true });
  const error = form.getByRole("alert");
  await expect(saved.or(error)).toBeVisible();
  if (await error.isVisible()) throw new Error(await error.innerText());

  await page.reload();
  for (const [label, value] of Object.entries(fields)) {
    await expect(form.getByLabel(label, { exact: true })).toHaveValue(value);
  }
  await expect(form.getByLabel("Clinic timezone", { exact: true })).toHaveValue(timezone);
  for (const day of weekdays) {
    const group = form.getByRole("group", { name: `${day} hours`, exact: true });
    await expect(group.locator('input[type="time"]')).toHaveCount(2);
    await expect(group.getByLabel(`${day} opening time 1`, { exact: true })).toHaveValue(opening);
    await expect(group.getByLabel(`${day} closing time 1`, { exact: true })).toHaveValue(closing);
  }
  for (const day of weekend) {
    const group = form.getByRole("group", { name: `${day} hours`, exact: true });
    await expect(group.getByText("Closed", { exact: true })).toBeVisible();
  }
}

if (import.meta.main) {
  const browser = await chromium.launch({ executablePath: braveExecutable, headless: false });
  try {
    const page = await browser.newPage();
    await page.goto(previewSettings, { waitUntil: "domcontentloaded" });
    console.log("Sign in to Vercel if prompted, then sign in as clinic admin and open Clinic settings in this browser window.");
    await page.waitForURL(previewSettings, { timeout: 300_000 });
    await page.getByRole("heading", { name: "Clinic settings", exact: true }).waitFor({ timeout: 300_000 });
    await fillAndSaveMapleClinic(page);
    console.log("Maple Clinic settings saved and verified after reload.");
  } finally {
    await browser.close();
  }
}
