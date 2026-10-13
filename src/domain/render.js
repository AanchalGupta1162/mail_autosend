import { composeBody } from "../compose.js";

// Initial-email preview via the same composer the sender uses. The API exposes the
// plain-text body only; the HTML version is never sent to the browser.
export function renderInitialPreview(contact, signatureHtml = "") {
  const { text } = composeBody(contact.mailText, signatureHtml);
  return { subject: contact.subject, text };
}
