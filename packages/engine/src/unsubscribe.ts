import { createHmac, timingSafeEqual } from "node:crypto";

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const mac = (contactId: string, secret: string) => createHmac("sha256", secret).update(contactId).digest("base64url");

/** Stateless signed token: no DB lookup needed to trust it, and it can't be forged without the secret. */
export function signUnsubscribeToken(contactId: string, secret: string): string {
  return `${b64(contactId)}.${mac(contactId, secret)}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): string | null {
  const [idPart, sig] = token.split(".");
  if (!idPart || !sig) return null;
  const contactId = Buffer.from(idPart, "base64url").toString();
  const a = Buffer.from(sig), b = Buffer.from(mac(contactId, secret));
  return a.length === b.length && timingSafeEqual(a, b) ? contactId : null;
}

export const unsubscribeUrl = (appUrl: string, contactId: string, secret: string) =>
  `${appUrl.replace(/\/$/, "")}/unsubscribe/${signUnsubscribeToken(contactId, secret)}`;
