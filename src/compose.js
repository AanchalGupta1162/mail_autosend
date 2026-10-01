function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").trim();
}

/** Converts **bold** markdown in plain text to an HTML fragment with <strong> tags. */
export function markdownBoldToHtml(text) {
  const escaped = escapeHtml(text);
  const bolded = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return bolded.replace(/\n/g, "<br>\n");
}

/** Builds the HTML + plain-text bodies for a mail-text block plus signature. */
export function composeBody(mailText, signatureHtml) {
  const bodyHtml = markdownBoldToHtml(mailText);
  const html = signatureHtml ? `${bodyHtml}<br><br>${signatureHtml}` : bodyHtml;

  const plainBody = mailText.replace(/\*\*(.+?)\*\*/g, "$1");
  const text = signatureHtml
    ? `${plainBody}\n\n${stripHtml(signatureHtml)}`
    : plainBody;

  return { html, text };
}
