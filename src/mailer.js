import nodemailer from "nodemailer";
import { composeBody } from "./compose.js";

export function createTransport({ gmailUser, gmailAppPassword }) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailAppPassword },
    // All strictly below the worker's 90 s send timeout, so nodemailer reports its own (classified)
    // error before the worker gives up on the call.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
}

// DRY_RUN uses nodemailer's jsonTransport: the full message (including its Message-ID) is
// built but nothing is delivered. Otherwise the real Gmail transport.
export function createMailer(config) {
  if (config.dryRun) return nodemailer.createTransport({ jsonTransport: true });
  return createTransport(config);
}

function buildFrom(config) {
  return config.fromName ? { name: config.fromName, address: config.gmailUser } : config.gmailUser;
}

export function buildInitialMailOptions(config, row) {
  const { html, text } = composeBody(row.mailText, config.signatureHtml);
  const options = {
    from: buildFrom(config),
    to: row.email,
    subject: row.subject,
    html,
    text,
  };
  if (config.resumePath) {
    options.attachments = [{ path: config.resumePath }];
  }
  return options;
}

export function buildFollowUpMailOptions(config, row) {
  const { html, text } = composeBody(row.followUpText, config.signatureHtml);
  return {
    from: buildFrom(config),
    to: row.email,
    subject: `Re: ${row.subject}`,
    html,
    text,
    inReplyTo: row.messageId,
    references: row.messageId,
  };
}

export async function send(transport, mailOptions) {
  const info = await transport.sendMail(mailOptions);
  return info.messageId;
}
