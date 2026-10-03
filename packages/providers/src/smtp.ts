import nodemailer from "nodemailer";
import { ProviderError, type EmailProvider, type SendEmailInput } from "./email";

/** Local dev provider: sends to Mailpit (http://localhost:8025). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transport;
  constructor(host = "localhost", port = 1025) {
    this.transport = nodemailer.createTransport({ host, port, secure: false });
  }
  async send(input: SendEmailInput) {
    try {
      const info = await this.transport.sendMail({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        headers: { "X-Journeys-Tags": JSON.stringify(input.tags) },
      });
      return { providerMessageId: String(info.messageId) };
    } catch (e) {
      // nodemailer reports failures to establish the connection with command "CONN"
      // (code ESOCKET/ECONNECTION/ETIMEDOUT). Nothing was handed to the server, so a retry is safe.
      const err = e as NodeJS.ErrnoException & { command?: string };
      throw new ProviderError(err.message, err.command === "CONN");
    }
  }
}
