CREATE TABLE "whatsapp_patient_links" (
	"patient_user_id" text PRIMARY KEY NOT NULL,
	"link_hash" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" DROP CONSTRAINT "whatsapp_conversation_state";--> statement-breakpoint
ALTER TABLE "whatsapp_patient_links" ADD CONSTRAINT "whatsapp_patient_links_patient_user_id_user_id_fk" FOREIGN KEY ("patient_user_id") REFERENCES "patient_auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversation_state" CHECK ("whatsapp_conversations"."state" in ('MAIN_MENU', 'WAITING_FOR_NAME', 'WAITING_FOR_EMAIL', 'WAITING_FOR_CODE', 'CONFIRMING_NUMBER_REPLACEMENT', 'SELECTING_DATE', 'SELECTING_SLOT', 'CONFIRMING_BOOKING', 'BOOKING_COMPLETED', 'SUPPORT_REQUESTED'));