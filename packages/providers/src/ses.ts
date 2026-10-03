import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ProviderError, type EmailProvider, type SendEmailInput } from "./email";

export class SesEmailProvider implements EmailProvider {
  readonly name = "ses";
  private client: SESv2Client;
  constructor(opts: { region?: string; configurationSet?: string } = {}) {
    this.client = new SESv2Client({ region: opts.region ?? process.env.AWS_REGION ?? "us-east-1" });
    this.configurationSet = opts.configurationSet || undefined;
  }
  private configurationSet?: string;

  async send(input: SendEmailInput) {
    try {
      const out = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: input.from,
          Destination: { ToAddresses: [input.to] },
          ConfigurationSetName: this.configurationSet,
          // Tags come back on every SES event, so events map to our messages directly.
          EmailTags: Object.entries(input.tags).map(([Name, Value]) => ({ Name, Value })),
          Content: {
            Simple: {
              Subject: { Data: input.subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: input.html, Charset: "UTF-8" },
                ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
              },
            },
          },
        }),
      );
      return { providerMessageId: out.MessageId ?? "" };
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number }; message: string };
      // 4xx from SES = request rejected (bad identity, sandbox, validation): nothing was sent.
      const status = err.$metadata?.httpStatusCode;
      throw new ProviderError(`${err.name}: ${err.message}`, status !== undefined && status >= 400 && status < 500);
    }
  }
}
