import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";
import type { ApplicationDatabase } from "@/db/connection";
import { patientSession, patientUser } from "@/db/schema/auth";
import { appointments, bookingRequests } from "@/db/schema/booking";
import { whatsappConversations, whatsappPatientLinks, whatsappWebhookMessages } from "@/db/schema/notifications";
import { readClinicConfiguration } from "@/modules/clinic/repository";
import { BookingError, type WhatsAppBookingPrincipal } from "@/modules/booking/models";
import { cancelWhatsAppAppointment, readWhatsAppCancellableAppointments } from "@/modules/booking/patient-cancellation";
import type { createBookingService } from "@/modules/booking/service";
import type { createSlotAvailabilityService } from "@/modules/scheduling/slots";
import { createWhatsAppConversationVault } from "./conversation-vault";
import type { ConversationMessage, ConversationSender } from "./meta-conversation";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
const nameSchema = z.string().trim().min(1).max(100).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
type State = "MAIN_MENU" | "WAITING_FOR_NAME" | "WAITING_FOR_EMAIL" | "WAITING_FOR_CODE" | "CONFIRMING_NUMBER_REPLACEMENT" | "SELECTING_DATE" | "SELECTING_SLOT" | "CONFIRMING_BOOKING" | "BOOKING_COMPLETED" | "SUPPORT_REQUESTED" | "SELECTING_CANCELLATION" | "CONFIRMING_CANCELLATION";
type Data = { phone: string; name?: string; email?: string; patientUserId?: string; patientSessionId?: string; linkHash?: string; previousLinkHash?: string; date?: string; dateNextCursor?: string; startsAt?: string; requestId?: string; slotPage?: number; lastInboundId?: string; lastReply?: ConversationMessage;
  intent?: "cancel"; cancellationOffset?: number; cancellation?: { appointmentId: string; confirmationId: string };
};
type PatientAuthApi = {
  api: {
    sendVerificationOTP(input: { body: { email: string; type: "sign-in" } }): Promise<unknown>;
    signInEmailOTP(input: { body: { email: string; otp: string; name?: string } }): Promise<{ token: string; user: { id: string; email: string } }>;
  };
};
type BookingService = Pick<ReturnType<typeof createBookingService>, "bookForWhatsApp">;
type Slots = Pick<ReturnType<typeof createSlotAvailabilityService>, "read">;
const DAY_MS = 86_400_000;
type Transaction = Parameters<Parameters<ApplicationDatabase["transaction"]>[0]>[0];
const SESSION_MS = 30 * 60_000;
const CANCELLATION_PAGE_SIZE = 9;
const cancellationCommands = new Set(["cancel_appointment", "cancel an appointment", "cancel appointment", "cancel my appointment", "cancel my last appointment"]);
const greetings = new Set(["hi", "hello", "hey", "menu", "start"]);
type CancellableAppointment = Awaited<ReturnType<typeof readWhatsAppCancellableAppointments>>[number];

function menu(canCancel = false): ConversationMessage {
  return { type: "buttons", body: "Welcome to Nuvortiq Clinic. What would you like to do?", buttons: [
    { id: "book", title: "Book appointment" }, { id: "support", title: "Contact support" },
    ...(canCancel ? [{ id: "cancel_appointment", title: "Cancel appointment" }] : []),
  ] };
}
function text(body: string): ConversationMessage { return { type: "text", body }; }
function shortDate(date: string) {
  return new Intl.DateTimeFormat("en", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T12:00:00Z`));
}
function shortTime(startsAt: string, timezone: string) {
  return new Intl.DateTimeFormat("en", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(startsAt));
}

export function createWhatsAppConversationService(
  db: ApplicationDatabase,
  booking: BookingService,
  slots: Slots,
  patientAuth: PatientAuthApi,
  sender: ConversationSender,
  encodedKey: string | undefined,
  clock = () => new Date(),
  uuid = () => crypto.randomUUID(),
  stateDb = db,
) {
  const vault = createWhatsAppConversationVault(encodedKey);

  async function clinicContact() {
    const clinic = await readClinicConfiguration(db);
    return clinic?.phone ? `Clinic support: ${clinic.phone}`
      : clinic?.email ? `Clinic support: ${clinic.email}` : "";
  }

  function withClinicContact(body: string, contact: string) {
    return text(contact ? `${body}\n\n${contact}` : body);
  }

  async function supportReply(): Promise<ConversationMessage> {
    const clinic = await readClinicConfiguration(db);
    const methods = [clinic?.phone ? `Phone: ${clinic.phone}` : "", clinic?.email ? `Email: ${clinic.email}` : ""].filter(Boolean).join("\n");
    return { type: "buttons", body: methods ? `Please contact the clinic team:\n${methods}` : "The clinic has not configured its phone or email contact yet. Please try again later.", buttons: [
      { id: "book", title: "Book appointment" }, { id: "menu", title: "Main menu" },
    ] };
  }

  async function completedAppointment(data: Data) {
    if (!data.patientUserId || !data.requestId) return undefined;
    // The request record also identifies bookings completed before this reply changed.
    const [appointment] = await db.select({
      id: appointments.id, startsAt: appointments.startsAt, timezone: appointments.timezone, status: appointments.status,
    }).from(bookingRequests).innerJoin(appointments, eq(appointments.id, bookingRequests.appointmentId))
      .where(and(eq(bookingRequests.actorKind, "patient"), eq(bookingRequests.actorId, data.patientUserId),
        eq(bookingRequests.requestId, data.requestId), eq(appointments.whatsappNumberVerified, true))).limit(1);
    return appointment;
  }

  function confirmationBody(visit: { id: string; startsAt: string; timezone: string }) {
    return `Your appointment is confirmed for ${shortTime(visit.startsAt, visit.timezone)} (${visit.timezone}). Reference: ${visit.id.slice(0, 8)}.`;
  }

  async function dateChoices(startDate?: string) {
    const first = await slots.read(startDate);
    if (!first.configured || first.noAvailableDates) return { first, days: [] as { date: string; available: number }[] };
    const days: { date: string; available: number }[] = [];
    let cursor = Date.parse(`${startDate ?? first.today}T00:00:00Z`);
    for (; cursor <= Date.parse(`${first.lastDate}T00:00:00Z`) && days.length < 8; cursor += DAY_MS) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      const view = await slots.read(date), available = view.slots.filter((slot) => slot.availability === "available").length;
      if (available) days.push({ date, available });
    }
    return { first, days, nextCursor: cursor <= Date.parse(`${first.lastDate}T00:00:00Z`) ? new Date(cursor).toISOString().slice(0, 10) : undefined };
  }

  function datesMessage(days: { date: string; available: number }[], nextCursor?: string): ConversationMessage {
    const rows: { id: string; title: string; description?: string }[] = days.map(({ date, available }) => ({ id: `D:${date}`, title: shortDate(date), description: `${available} available time${available === 1 ? "" : "s"}` }));
    if (nextCursor) rows.push({ id: `D:MORE:${nextCursor}`, title: "More dates" });
    return { type: "list", body: "Choose an available date, or send Cancel to return to the main menu.", button: "View dates", section: "Available dates", rows };
  }

  function timesMessage(date: string, timezone: string, available: { startsAt: string; label: string }[], page: number): ConversationMessage {
    const start = page * 8, rows = available.slice(start, start + 8).map((slot) => ({ id: `S:${slot.startsAt}`, title: slot.label }));
    if (page > 0) rows.unshift({ id: "S:PREVIOUS", title: "Previous times" });
    if (start + 8 < available.length) rows.push({ id: "S:MORE", title: "More times" });
    return { type: "list", body: `Choose a time on ${shortDate(date)} (${timezone}), or send Cancel to return to the main menu.`, button: "View times", section: "Available times", rows };
  }

  async function openDates(data: Data): Promise<ConversationMessage> {
    const choices = await dateChoices().catch(() => null);
    data.dateNextCursor = choices?.nextCursor;
    if (!choices) return text("Your email is verified. Dates are temporarily unavailable. Send View dates to try again.");
    return choices.days.length ? datesMessage(choices.days, choices.nextCursor) : text("There are no available appointment times right now. Send Cancel to return to the main menu.");
  }

  function verifiedPrincipal(data: Data): WhatsAppBookingPrincipal | null {
    if (!data.patientUserId || !data.email) return null;
    if (data.linkHash) return { userId: data.patientUserId, linkHash: data.linkHash, email: data.email };
    return data.patientSessionId ? { userId: data.patientUserId, sessionId: data.patientSessionId } : null;
  }

  async function verifyCode(email: string, otp: string, name: string | undefined, now: Date) {
    let result: Awaited<ReturnType<PatientAuthApi["api"]["signInEmailOTP"]>>;
    try {
      result = await patientAuth.api.signInEmailOTP({ body: { email, otp, name } });
    } catch {
      return null;
    }
    const [session] = await db.select({ id: patientSession.id, userId: patientSession.userId }).from(patientSession)
      .innerJoin(patientUser, eq(patientUser.id, patientSession.userId))
      .where(and(eq(patientSession.token, result.token), eq(patientSession.userId, result.user.id),
        eq(patientUser.email, email), eq(patientUser.emailVerified, true), gt(patientSession.expiresAt, now))).limit(1);
    return session;
  }

  async function transition(tx: Transaction, senderHash: string, phone: string, messageId: string, incoming: string, now: Date) {
    await tx.insert(whatsappConversations).values({ senderHash, state: "MAIN_MENU", payloadCiphertext: vault.encrypt(senderHash, { phone }), expiresAt: new Date(now.getTime() + SESSION_MS), updatedAt: now }).onConflictDoNothing();
    const [row] = await tx.select().from(whatsappConversations).where(eq(whatsappConversations.senderHash, senderHash)).for("update");
    const accepted = await tx.insert(whatsappWebhookMessages).values({ messageId, receivedAt: now }).onConflictDoNothing().returning({ messageId: whatsappWebhookMessages.messageId });
    let state = row.state as State;
    let data = vault.decrypt<Data>(senderHash, row.payloadCiphertext);
    if (!accepted.length) {
      if (data.lastInboundId !== messageId || !data.lastReply) return null;
      return { state, data, reply: data.lastReply, duplicate: true };
    }
    if (row.expiresAt <= now) {
      if (state === "BOOKING_COMPLETED") {
        delete data.linkHash;
        delete data.patientSessionId;
      } else {
        state = "MAIN_MENU";
        data = { phone };
      }
    }

    const normalized = incoming.trim(), command = normalized.toLowerCase();
    const keepAppointment = command === "keep_appointment" || command.replace(/\*/g, "").replace(/\s+/g, " ") === "keep appointment";
    const showMenu = async () => {
      const principal = verifiedPrincipal(data);
      if (!principal) return menu();
      try { return menu((await readWhatsAppCancellableAppointments(tx, principal, now)).length > 0); }
      catch (error) {
        if (error instanceof BookingError && error.code === "SIGN_IN_REQUIRED") return menu();
        throw error;
      }
    };
    const askCancellationEmail = () => {
      data = { phone, intent: "cancel" };
      state = "WAITING_FOR_EMAIL";
      return text("Enter the email address you used to book. Send Menu to go back.");
    };
    const confirmCancellation = (appointment: CancellableAppointment): ConversationMessage => {
      const confirmationId = uuid();
      data.cancellation = { appointmentId: appointment.id, confirmationId };
      state = "CONFIRMING_CANCELLATION";
      return { type: "buttons", body: `Cancel your appointment on ${shortTime(appointment.startsAt.toISOString(), appointment.timezone)} (${appointment.timezone})?`,
        buttons: [{ id: "keep_appointment", title: "Keep appointment" }, { id: `C:CONFIRM:${confirmationId}`, title: "Confirm cancellation" }] };
    };
    const openCancellation = async (offset = 0): Promise<ConversationMessage> => {
      const principal = verifiedPrincipal(data);
      if (!principal) return askCancellationEmail();
      delete data.intent;
      delete data.cancellation;
      try {
        const choices = await readWhatsAppCancellableAppointments(tx, principal, now, { offset, limit: CANCELLATION_PAGE_SIZE + 1 });
        if (!choices.length && offset > 0) return openCancellation();
        if (!choices.length) {
          state = "MAIN_MENU";
          return { type: "buttons", body: "You don’t have any upcoming appointments to cancel.",
            buttons: [{ id: "book", title: "Book appointment" }, { id: "menu", title: "Back to menu" }] };
        }
        if (offset === 0 && choices.length === 1) return confirmCancellation(choices[0]);
        state = "SELECTING_CANCELLATION";
        data.cancellationOffset = offset;
        const rows = choices.slice(0, CANCELLATION_PAGE_SIZE).map((choice) => ({
          id: `C:SELECT:${choice.id}`, title: shortTime(choice.startsAt.toISOString(), choice.timezone), description: choice.timezone,
        }));
        if (choices.length > CANCELLATION_PAGE_SIZE) rows.push({ id: "C:MORE", title: "More appointments", description: "" });
        return { type: "list", body: "Choose the appointment you want to cancel. Send Menu to go back.",
          button: "View appointments", section: "Upcoming appointments", rows };
      } catch (error) {
        if (error instanceof BookingError && error.code === "SIGN_IN_REQUIRED") return askCancellationEmail();
        throw error;
      }
    };
    let reply: ConversationMessage;
    if (keepAppointment) {
      if (state === "SELECTING_CANCELLATION" || state === "CONFIRMING_CANCELLATION") {
        delete data.cancellation;
        state = "MAIN_MENU";
        reply = { ...await showMenu(), body: "Cancellation stopped. I didn’t cancel your appointment." };
      } else reply = text("There’s no cancellation in progress. Send Menu to see your options.");
    } else if (cancellationCommands.has(command) || (state === "BOOKING_COMPLETED" && command === "cancel")) {
      reply = await openCancellation();
    } else if (state === "SELECTING_CANCELLATION" || state === "CONFIRMING_CANCELLATION") {
      const principal = verifiedPrincipal(data);
      if (greetings.has(command) || ["cancel", "restart", "start over"].includes(command)) {
        delete data.cancellation;
        state = "MAIN_MENU";
        reply = await showMenu();
      } else if (/^\d{4,6}$/.test(normalized)) return null;
      else if (!principal) reply = askCancellationEmail();
      else if (state === "SELECTING_CANCELLATION" && normalized === "C:MORE") {
        reply = await openCancellation((data.cancellationOffset ?? 0) + CANCELLATION_PAGE_SIZE);
      } else if (state === "SELECTING_CANCELLATION" && normalized.startsWith("C:SELECT:")) {
        const appointmentId = z.uuid().safeParse(normalized.slice("C:SELECT:".length));
        try {
          const [selected] = appointmentId.success
            ? await readWhatsAppCancellableAppointments(tx, principal, now, { appointmentId: appointmentId.data })
            : [];
          reply = selected ? confirmCancellation(selected) : await openCancellation();
        } catch (error) {
          if (!(error instanceof BookingError) || error.code !== "SIGN_IN_REQUIRED") throw error;
          reply = askCancellationEmail();
        }
      } else if (state === "CONFIRMING_CANCELLATION" && data.cancellation && normalized === `C:CONFIRM:${data.cancellation.confirmationId}`) {
        try {
          await cancelWhatsAppAppointment(tx, principal, data.cancellation.appointmentId, clock);
          delete data.cancellation;
          state = "MAIN_MENU";
          reply = { type: "buttons", body: "Your appointment has been cancelled.",
            buttons: [{ id: "book", title: "Book appointment" }, { id: "menu", title: "Back to menu" }] };
        } catch (error) {
          if (!(error instanceof BookingError)) throw error;
          if (error.code === "SIGN_IN_REQUIRED") reply = askCancellationEmail();
          else if (["APPOINTMENT_NOT_FOUND", "CANCELLATION_NOT_ALLOWED"].includes(error.code)) {
            delete data.cancellation;
            state = "MAIN_MENU";
            reply = withClinicContact("This appointment can no longer be cancelled here.", await clinicContact());
          } else throw error;
        }
      } else if (state === "SELECTING_CANCELLATION") reply = await openCancellation(data.cancellationOffset ?? 0);
      else reply = text("Use the latest confirmation buttons to confirm cancellation or keep the appointment. Send Menu to go back.");
    } else if (state === "BOOKING_COMPLETED") {
      const appointment = await completedAppointment(data);
      if (appointment?.status === "cancelled") {
        state = "MAIN_MENU"; reply = await showMenu();
      } else if (command === "book" || normalized === "book_appointment") {
        state = "WAITING_FOR_NAME"; data = { phone }; reply = text("What name should we use for your appointment? Send Cancel to return to the main menu.");
      } else if (command === "cancel_booking") {
        reply = withClinicContact("You can cancel your appointment in My appointments on the booking website or contact the clinic.", await clinicContact());
      } else if (normalized === "support" || normalized === "contact_support") {
        reply = await supportReply();
      } else if (greetings.has(command)) {
        reply = await showMenu();
      } else {
        reply = withClinicContact(appointment?.status === "confirmed"
          ? confirmationBody({ ...appointment, startsAt: appointment.startsAt.toISOString() })
          : "Your booking is complete.", await clinicContact());
      }
    } else if (command === "menu" || (greetings.has(command) && state !== "WAITING_FOR_NAME")) {
      state = "MAIN_MENU";
      data = { phone, email: data.email, patientUserId: data.patientUserId, linkHash: data.linkHash, patientSessionId: data.patientSessionId };
      reply = await showMenu();
    } else if (["cancel", "restart", "start over"].includes(command) || normalized === "cancel_booking") {
      state = "MAIN_MENU"; data = { phone }; reply = menu();
    } else if (state === "MAIN_MENU") {
      if (normalized === "book" || normalized === "book_appointment") { state = "WAITING_FOR_NAME"; data = { phone }; reply = text("What name should we use for your appointment? Send Cancel to return to the main menu."); }
      else if (normalized === "support" || normalized === "contact_support") {
        state = "SUPPORT_REQUESTED";
        reply = await supportReply();
      } else reply = menu();
    } else if (state === "SUPPORT_REQUESTED") {
      if (normalized === "book" || normalized === "book_appointment") { state = "WAITING_FOR_NAME"; data = { phone }; reply = text("What name should we use for your appointment? Send Cancel to return to the main menu."); }
      else { state = "MAIN_MENU"; data = { phone }; reply = menu(); }
    } else if (state === "WAITING_FOR_NAME") {
      const name = nameSchema.safeParse(normalized);
      if (!name.success) reply = text("Please enter your name (up to 100 characters).");
      else { data.name = name.data; state = "WAITING_FOR_EMAIL"; reply = text("What is your email address? If we need to verify it, we’ll ask for a one-time code before showing available times. Send Cancel to stop."); }
    } else if (state === "WAITING_FOR_EMAIL") {
      const email = emailSchema.safeParse(normalized);
      if (!email.success) reply = text("Please enter a valid email address.");
      else {
        const linkHash = vault.linkHash(phone, email.data);
        const [linked] = await tx.select({ userId: patientUser.id }).from(patientUser)
          .innerJoin(whatsappPatientLinks, eq(whatsappPatientLinks.patientUserId, patientUser.id))
          .where(and(eq(patientUser.email, email.data), eq(patientUser.emailVerified, true),
            eq(whatsappPatientLinks.linkHash, linkHash)));
        if (linked) {
          data = { phone, name: data.name, intent: data.intent, email: email.data, patientUserId: linked.userId, linkHash };
          if (data.intent === "cancel") reply = await openCancellation();
          else { state = "SELECTING_DATE"; reply = await openDates(data); }
        } else {
          try {
            await patientAuth.api.sendVerificationOTP({ body: { email: email.data, type: "sign-in" } });
            data = { phone, name: data.name, intent: data.intent, email: email.data };
            state = "WAITING_FOR_CODE";
            reply = text("Enter the one-time verification code for that email within five minutes. Send Cancel to stop.");
          } catch { reply = text("Email verification is temporarily unavailable. Please try again later or contact the clinic."); }
        }
      }
    } else if (state === "WAITING_FOR_CODE") {
      if (!data.email || !/^\d{4,6}$/.test(normalized)) reply = text("Enter the verification code for your email, or send Cancel to start over.");
      else {
        const session = await verifyCode(data.email, normalized, data.name, now);
        if (!session) {
          state = "WAITING_FOR_EMAIL";
          reply = text("That code is invalid or expired. Request a new one by sending your email again, or send Cancel to start over.");
        } else {
          data.patientUserId = session.userId;
          data.patientSessionId = session.id;
          const linkHash = vault.linkHash(phone, data.email);
          await tx.insert(whatsappPatientLinks).values({ patientUserId: session.userId, linkHash, verifiedAt: now }).onConflictDoNothing();
          const [link] = await tx.select().from(whatsappPatientLinks).where(eq(whatsappPatientLinks.patientUserId, session.userId));
          if (link?.linkHash === linkHash) data.linkHash = linkHash;
          if (data.intent === "cancel") {
            reply = await openCancellation();
          } else if (link?.linkHash === linkHash) {
            state = "SELECTING_DATE";
            reply = await openDates(data);
          } else {
            data.previousLinkHash = link?.linkHash;
            state = "CONFIRMING_NUMBER_REPLACEMENT";
            reply = { type: "buttons", body: "Your email is verified. Replace the WhatsApp number linked to this account, or keep it and book just this visit from this number?", buttons: [
              { id: "replace_number", title: "Replace number" }, { id: "keep_number", title: "Keep linked number" },
            ] };
          }
        }
      }
    } else if (state === "CONFIRMING_NUMBER_REPLACEMENT") {
      if ((normalized === "replace_number" || normalized === "keep_number") && data.patientUserId && data.email && data.patientSessionId) {
        if (normalized === "replace_number") {
          const [session] = await tx.select({ id: patientSession.id }).from(patientSession)
            .innerJoin(patientUser, eq(patientUser.id, patientSession.userId))
            .where(and(eq(patientSession.id, data.patientSessionId), eq(patientSession.userId, data.patientUserId),
              eq(patientUser.email, data.email), eq(patientUser.emailVerified, true), gt(patientSession.expiresAt, now)));
          if (!session || !data.previousLinkHash) {
            data = { phone, name: data.name };
            state = "WAITING_FOR_EMAIL";
            reply = text("Your verification is no longer current. Enter your email to verify again.");
          } else {
            const replacementHash = vault.linkHash(phone, data.email);
            const [updated] = await tx.update(whatsappPatientLinks).set({ linkHash: replacementHash, verifiedAt: now })
              .where(and(eq(whatsappPatientLinks.patientUserId, data.patientUserId), eq(whatsappPatientLinks.linkHash, data.previousLinkHash)))
              .returning({ userId: whatsappPatientLinks.patientUserId });
            if (!updated) {
              data = { phone, name: data.name };
              state = "WAITING_FOR_EMAIL";
              reply = text("The linked number changed. Enter your email to verify again.");
            } else {
              data.linkHash = replacementHash;
              state = "SELECTING_DATE";
              reply = await openDates(data);
            }
          }
        } else {
          state = "SELECTING_DATE";
          reply = await openDates(data);
        }
        delete data.previousLinkHash;
      } else if (/^\d{4,6}$/.test(normalized)) return null;
      else reply = text("Choose Replace number, Keep linked number, or Cancel.");
    } else if (state === "SELECTING_DATE") {
      // A second code can arrive after the first advanced this chat. Keep its date reply cached.
      if (/^\d{4,6}$/.test(normalized)) return null;
      if (normalized.startsWith("D:MORE:")) {
        const cursor = normalized.slice("D:MORE:".length), choices = await dateChoices(cursor);
        data.dateNextCursor = choices.nextCursor;
        reply = choices.days.length ? datesMessage(choices.days, choices.nextCursor) : text("There are no more available dates. Send Cancel to return to the main menu.");
      } else {
      const date = normalized.startsWith("D:") ? normalized.slice(2) : "";
      const view = date ? await slots.read(date).catch(() => null) : null;
      const available = view?.slots.filter((slot) => slot.availability === "available") ?? [];
      if (!view || !available.length) {
        const choices = await dateChoices(); data.dateNextCursor = choices.nextCursor; reply = choices.days.length ? datesMessage(choices.days, choices.nextCursor) : text("No appointment times are currently available. Send Cancel to return to the main menu.");
      } else {
        data.date = date; data.slotPage = 0; state = "SELECTING_SLOT";
        reply = timesMessage(date, view.timezone, available, 0);
      }
      }
    } else if (state === "SELECTING_SLOT") {
      if (normalized === "S:MORE" || normalized === "S:PREVIOUS") {
        const view = data.date ? await slots.read(data.date).catch(() => null) : null;
        const available = view?.slots.filter((choice) => choice.availability === "available") ?? [];
        const page = Math.max(0, (data.slotPage ?? 0) + (normalized === "S:MORE" ? 1 : -1)); data.slotPage = page;
        reply = view && data.date ? timesMessage(data.date, view.timezone, available, page) : text("Please choose an available date again.");
      } else {
      const startsAt = normalized.startsWith("S:") ? normalized.slice(2) : "";
      const view = data.date ? await slots.read(data.date).catch(() => null) : null;
      const slot = view?.slots.find((choice) => choice.startsAt === startsAt && choice.availability === "available");
      if (!slot || !view || !data.name || !verifiedPrincipal(data)) {
        state = "SELECTING_DATE"; const choices = await dateChoices(); data.dateNextCursor = choices.nextCursor; reply = choices.days.length ? datesMessage(choices.days, choices.nextCursor) : text("No appointment times are currently available.");
      } else {
        data.startsAt = slot.startsAt; data.requestId = uuid(); state = "CONFIRMING_BOOKING";
        reply = { type: "buttons", body: `Appointment summary\nName: ${data.name}\nDate and time: ${shortTime(slot.startsAt, view.timezone)} (${view.timezone})\n\nChoose whether to receive WhatsApp appointment updates.`, buttons: [
          { id: "confirm_updates", title: "Confirm + updates" }, { id: "confirm_no_updates", title: "Confirm only" }, { id: "cancel_booking", title: "Cancel" },
        ] };
      }
      }
    } else if (state === "CONFIRMING_BOOKING") {
      if (normalized === "confirm_updates" || normalized === "confirm_no_updates") {
        const principal = verifiedPrincipal(data);
        if (!principal || !data.requestId || !data.startsAt || !data.name) { state = "MAIN_MENU"; data = { phone }; reply = menu(); }
        else {
          const contact = await clinicContact();
          try {
            const receipt = await booking.bookForWhatsApp(principal, {
              requestId: data.requestId, startsAt: data.startsAt, name: data.name, phone, whatsappConsent: normalized === "confirm_updates",
            });
            state = "BOOKING_COMPLETED";
            reply = withClinicContact(confirmationBody(receipt), contact);
          } catch (error) {
            if (error instanceof BookingError && error.code === "SIGN_IN_REQUIRED") {
              data = { phone, name: data.name };
              state = "WAITING_FOR_EMAIL";
              reply = text("Your verification is no longer current. Enter your email to verify again.");
            } else {
              state = "SELECTING_DATE";
              const choices = await dateChoices();
              reply = choices.days.length ? text("That time is no longer available. Please choose another date.") : text("We could not confirm that time and no other times are available. Please contact the clinic.");
            }
          }
        }
      } else reply = text("Choose Confirm + updates, Confirm only, or Cancel.");
    } else { state = "MAIN_MENU"; data = { phone }; reply = menu(); }

    data.lastInboundId = messageId; data.lastReply = reply;
    const updatedAt = clock();
    await tx.update(whatsappConversations).set({
      state, payloadCiphertext: vault.encrypt(senderHash, data), expiresAt: new Date(updatedAt.getTime() + SESSION_MS), updatedAt,
    }).where(eq(whatsappConversations.senderHash, senderHash));
    return { state, data, reply, duplicate: false };
  }

  async function process(phone: string, messageId: string, incoming: string): Promise<{ state: State; data: Data; reply: ConversationMessage } | null> {
    const senderHash = vault.senderHash(phone);
    // Hold the same sender row until its next state and deduplication receipt commit together.
    const result = await stateDb.transaction((tx) => transition(tx, senderHash, phone, messageId, incoming, clock()));
    if (!result) return null;
    const { state, data, reply, duplicate } = result;
    try { await sender.send(phone, reply); }
    catch (error) {
      const code = error instanceof Error && /^META_[A-Z_]+$/.test(error.message) ? error.message : "META_SEND_FAILED";
      console.warn(`WhatsApp conversation reply could not be sent; sender=${senderHash.slice(0, 12)} code=${code}`);
      throw new Error("WHATSAPP_REPLY_FAILED");
    }
    return duplicate ? null : { state, data, reply };
  }

  return { process };
}
