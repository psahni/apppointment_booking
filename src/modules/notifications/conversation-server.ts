import "server-only";
import { createDatabase } from "@/db/connection";
import { readAuthEnvironment } from "@/platform/env";
import { getDatabase } from "@/db/server";
import { getIdentity } from "@/modules/identity/server";
import { getBookingService } from "@/modules/booking/server";
import { createSlotAvailabilityService } from "@/modules/scheduling/slots";
import { createMetaConversationSender, readConversationMetaConfig } from "./meta-conversation";
import { createWhatsAppConversationService } from "./conversation-service";

let stateDatabase: ReturnType<typeof createDatabase> | undefined;

export function getWhatsAppConversationService() {
  const config = readConversationMetaConfig();
  if (!config) return null;
  const database = getDatabase().db;
  // A held conversation row must not consume a connection needed by auth or booking.
  stateDatabase ??= createDatabase(readAuthEnvironment().DATABASE_URL, 3);
  return createWhatsAppConversationService(database, getBookingService(), createSlotAvailabilityService(database),
    getIdentity().patient, createMetaConversationSender(config), process.env.BOOKING_DATA_KEY, undefined, undefined, stateDatabase.db);
}
