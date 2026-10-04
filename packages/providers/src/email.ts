export type SendEmailInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
  /** Our own ids, echoed back by the provider so events can be mapped to messages without guessing. */
  tags: Record<string, string>;
};

export type SendEmailResult = { providerMessageId: string };

/**
 * Providers throw ProviderError so the engine can tell "definitely not sent" (safe to retry)
 * from everything else (ambiguous -> never auto-retried).
 */
export class ProviderError extends Error {
  constructor(message: string, public readonly definitelyNotSent: boolean) {
    super(message);
  }
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
