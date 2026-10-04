import type { Db } from "@journeys/db";
import type { EmailProvider } from "@journeys/providers";
import type { Queue } from "bullmq";

export type Ctx = {
  db: Db;
  queue: Queue;
  email: EmailProvider;
  emailFrom: string;
  /** Public base URL of the API, used in unsubscribe links. */
  appUrl: string;
  /** HMAC secret for unsubscribe tokens. */
  secret: string;
  /** Injectable clock. All scheduling uses the app clock (not DB now()) so wake_at and claim agree. */
  now: () => Date;
};
