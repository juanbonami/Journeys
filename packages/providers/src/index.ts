import type { EmailProvider } from "./email";
import { SesEmailProvider } from "./ses";
import { SmtpEmailProvider } from "./smtp";

export * from "./email";
export { SesEmailProvider, SmtpEmailProvider };

export function createEmailProvider(env = process.env): EmailProvider {
  switch (env.EMAIL_PROVIDER ?? "smtp") {
    case "ses":
      return new SesEmailProvider({ region: env.AWS_REGION, configurationSet: env.SES_CONFIGURATION_SET });
    case "smtp":
      return new SmtpEmailProvider(env.SMTP_HOST, Number(env.SMTP_PORT ?? 1025));
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${env.EMAIL_PROVIDER}"`);
  }
}
