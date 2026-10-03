import { z } from "zod";

/** Provider-independent event types. The workflow engine only ever sees these. */
export const EVENT_TYPES = [
  "form.submitted",
  "email.sent",
  "email.delivered",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.unsubscribed",
  "sms.sent",
  "sms.delivered",
  "sms.failed",
  "sms.received",
  "sms.opted_out",
  "purchase.created",
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;
