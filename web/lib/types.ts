// Typed mirror of the Express API contracts (src/auth/routes.js, src/server/routes/*.js,
// src/domain/{contacts,schedule,template}.js). Timestamps arrive as ISO strings.

export const CONTACT_STATUSES = ["uploaded", "scheduled", "sent", "replied", "bounced", "opted_out", "failed"] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const MESSAGE_STATES = ["scheduled", "sending", "sent", "failed", "cancelled", "needs_review"] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export type MessageKind = "initial" | "followup";

export interface User {
  id: string;
  username: string;
}

export interface Batch {
  id: string;
  name: string;
  originalFilename: string | null;
  createdAt: string;
}

export interface BatchSummary extends Batch {
  contactCount: number;
  statusCounts: Partial<Record<ContactStatus, number>>;
}

export interface Contact {
  id: string;
  batchId: string;
  company: string;
  role: string;
  person: string;
  email: string;
  subject: string;
  mailText: string;
  followupText: string | null;
  status: ContactStatus;
  followupRequested: boolean;
  followupDelayDays: number;
  repliedAt: string | null;
  error: string | null;
  createdAt: string;
}

/** Plain-text preview built by the same composer the sender uses (no HTML ever reaches the browser). */
export interface Preview {
  subject: string;
  text: string;
}

export interface ContactWithPreview extends Contact {
  preview: Preview;
}

/** A contact as returned by POST /api/batches: `row` is its line number in the uploaded CSV. */
export interface UploadedContact extends ContactWithPreview {
  row: number;
}

/** Live (non-cancelled) message as listed on GET /api/contacts. */
export interface MessageRef {
  id: string;
  kind: MessageKind;
  state: MessageState;
  scheduledFor: string;
  sentAt: string | null;
}

export interface ContactListItem extends Contact {
  messages: MessageRef[];
}

export interface Message {
  id: string;
  contactId: string;
  kind: MessageKind;
  state: MessageState;
  scheduledFor: string;
  sentAt: string | null;
  attempts: number;
  error: string | null;
  dryRun: boolean;
  createdAt: string;
}

export interface RowIssue {
  row: number;
  message: string;
}

export interface RowWarning extends RowIssue {
  existingStatus: ContactStatus;
}

export interface UploadResult {
  batch: Batch;
  contacts: UploadedContact[];
  errors: RowIssue[];
  warnings: RowWarning[];
}

export type RefusalReason =
  | "replied"
  | "bounced"
  | "opted_out"
  | "failed"
  | "suppressed"
  | "already_sent"
  | "already_scheduled"
  | "not_in_batch"
  | `other_batch_${string}`;

export interface Refusal {
  contactId: string;
  email: string | null;
  reason: RefusalReason;
}

export interface ContactsPage {
  contacts: ContactListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ContactsQuery {
  status?: ContactStatus;
  q?: string;
  batchId?: string;
  page?: number;
  pageSize?: number;
}

export interface FollowupTemplate {
  subject: string;
  body: string;
}

export interface FollowupResult {
  contact: Contact;
  followup: Message | null;
}

export interface CancelResult {
  message: Message;
  contact: Contact;
}

export interface SweepState {
  ok: boolean;
  at: string;
  lastSuccessAt: string | null;
  errorCode: string | null;
  rowErrors: number;
}

export interface SweepResult {
  skipped?: boolean;
  reason?: string;
  checked?: number;
  replied?: number;
  rowErrors?: number;
  error?: boolean;
}

export interface UpcomingSend {
  messageId: string;
  contactId: string;
  kind: MessageKind;
  scheduledFor: string;
  email: string;
  company: string;
  person: string;
}

export interface RecentEvent {
  id: number;
  contactId: string | null;
  type: string;
  meta: Record<string, unknown> | null;
  at: string;
  email: string | null;
}

export interface CompanyStat {
  company: string;
  total: number;
  sent: number;
  replied: number;
}

export interface Dashboard {
  totals: Record<ContactStatus, number>;
  sentToday: number;
  dailyCap: number;
  repliedRate: number;
  upcoming: UpcomingSend[];
  recentEvents: RecentEvent[];
  byCompany: CompanyStat[];
  sweep: SweepState | null;
  followupsHeld: boolean;
  dryRun: boolean;
}
