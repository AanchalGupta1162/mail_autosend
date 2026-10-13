// Typed client for the Express API, reached same-origin through the Next rewrite of /api/*.
// The session lives in the backend's httpOnly SameSite=Strict cookie; nothing is stored in
// localStorage. Mutating calls carry X-CSRF-Token (fetched once from /api/auth/csrf, replaced
// by the rotated token that login/change-password return, refetched once on the backend's 403 CSRF refusal).
import type {
  BatchSummary,
  CancelResult,
  Contact,
  ContactsPage,
  ContactsQuery,
  ContactWithPreview,
  ResolveAction,
  Batch,
  Dashboard,
  FollowupResult,
  FollowupTemplate,
  Message,
  Refusal,
  RowIssue,
  SweepResult,
  UploadResult,
  User,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** 409 scheduling refusals (all-or-nothing: nothing was scheduled). */
  readonly refused?: Refusal[];
  /** 422 upload: every row was rejected. */
  readonly rowErrors?: RowIssue[];

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    const b = body as { refused?: unknown; errors?: unknown } | null;
    if (Array.isArray(b?.refused)) this.refused = b.refused as Refusal[];
    if (Array.isArray(b?.errors)) this.rowErrors = b.errors as RowIssue[];
  }
}

export interface ApiOptions {
  fetch?: typeof fetch;
  /** Called on any 401 except a failed login. Default: full navigation to /login. */
  onUnauthorized?: () => void;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";
interface RequestOptions {
  json?: unknown;
  form?: FormData;
}

/** Exact error text of src/auth/middleware.js requireCsrf. */
const CSRF_ERROR = "Invalid CSRF token";
const NETWORK_MESSAGE = "Can't reach the server. Check your connection and that the backend is running.";

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname === "/login") return;
  // Full navigation on purpose: an expired session must drop all client-side state.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?next=${encodeURIComponent(pathname + search)}`);
}

const seg = (id: string) => encodeURIComponent(id);

export function createApi(options: ApiOptions = {}) {
  const doFetch = (...args: Parameters<typeof fetch>) => (options.fetch ?? globalThis.fetch)(...args);
  const onUnauthorized = options.onUnauthorized ?? redirectToLogin;
  let csrf: string | null = null;
  let pending: Promise<string> | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, { credentials: "same-origin", cache: "no-store", ...init });
    } catch {
      throw new ApiError(0, NETWORK_MESSAGE);
    }
  }

  async function readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // One in-flight fetch shared by concurrent callers.
  function csrfToken(refresh = false): Promise<string> {
    if (csrf && !refresh) return Promise.resolve(csrf);
    if (pending) return pending;
    pending = (async () => {
      const res = await send("/api/auth/csrf", { headers: { accept: "application/json" } });
      const body = (await readJson(res)) as { csrfToken?: unknown } | null;
      if (!res.ok || typeof body?.csrfToken !== "string") throw new ApiError(res.status, "Could not start a secure session. Reload the page.");
      csrf = body.csrfToken;
      return csrf;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function request<T>(method: Method, url: string, opts: RequestOptions = {}): Promise<T> {
    const mutating = method !== "GET";
    const attempt = async (token: string | null) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (token) headers["X-CSRF-Token"] = token;
      let body: BodyInit | undefined;
      if (opts.form) body = opts.form; // browser sets the multipart boundary
      else if (opts.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.json);
      }
      return send(url, { method, headers, body });
    };

    const res0 = await attempt(mutating ? await csrfToken() : null);
    let res = res0;
    let data = await readJson(res0);
    // Retry once, only for the backend's CSRF refusal (token expired or session rotated).
    if (res0.status === 403 && mutating && (data as { error?: unknown } | null)?.error === CSRF_ERROR) {
      res = await attempt(await csrfToken(true));
      data = await readJson(res);
    }
    if (res.ok) return data as T;

    const message = typeof (data as { error?: unknown } | null)?.error === "string" ? (data as { error: string }).error : `Request failed (${res.status})`;
    if (res.status === 401 && url !== "/api/auth/login") {
      csrf = null;
      onUnauthorized();
    }
    throw new ApiError(res.status, message, data);
  }

  const keepToken = <T extends { csrfToken?: string }>(r: T) => {
    if (typeof r?.csrfToken === "string") csrf = r.csrfToken;
    return r;
  };

  return {
    /** Forget the cached CSRF token (tests, logout). */
    reset() {
      csrf = null;
      pending = null;
    },

    // Auth
    async login(username: string, password: string): Promise<User> {
      const r = keepToken(await request<{ user: User; csrfToken: string }>("POST", "/api/auth/login", { json: { username, password } }));
      return r.user;
    },
    async logout(): Promise<void> {
      try {
        await request("POST", "/api/auth/logout");
      } finally {
        csrf = null;
      }
    },
    async me(): Promise<User> {
      return (await request<{ user: User }>("GET", "/api/auth/me")).user;
    },
    async changePassword(currentPassword: string, newPassword: string): Promise<void> {
      keepToken(await request<{ ok: true; csrfToken: string }>("POST", "/api/auth/change-password", { json: { currentPassword, newPassword } }));
    },

    // Batches & contacts
    uploadBatch(file: File, name?: string): Promise<UploadResult> {
      const form = new FormData();
      if (name?.trim()) form.append("name", name.trim());
      form.append("file", file, file.name);
      return request<UploadResult>("POST", "/api/batches", { form });
    },
    async listBatches(): Promise<BatchSummary[]> {
      return (await request<{ batches: BatchSummary[] }>("GET", "/api/batches")).batches;
    },
    getBatch(id: string): Promise<{ batch: Batch; contacts: ContactWithPreview[] }> {
      return request("GET", `/api/batches/${seg(id)}`);
    },
    listContacts(query: ContactsQuery = {}): Promise<ContactsPage> {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "" && v !== null) params.set(k, String(v));
      const qs = params.toString();
      return request("GET", `/api/contacts${qs ? `?${qs}` : ""}`);
    },
    async markReplied(id: string): Promise<Contact> {
      return (await request<{ contact: Contact }>("POST", `/api/contacts/${seg(id)}/mark-replied`)).contact;
    },
    async optOut(id: string): Promise<Contact> {
      return (await request<{ contact: Contact }>("POST", `/api/contacts/${seg(id)}/opt-out`)).contact;
    },

    // Scheduling (bulk is all-or-nothing: a 409 carries `refused`)
    async scheduleBatch(batchId: string, body: { contactIds: string[]; sendAt: string; staggerMinutes?: number }): Promise<Message[]> {
      return (await request<{ messages: Message[] }>("POST", `/api/batches/${seg(batchId)}/schedule`, { json: body })).messages;
    },
    async scheduleContact(contactId: string, sendAt: string): Promise<Message> {
      return (await request<{ message: Message }>("PUT", `/api/contacts/${seg(contactId)}/schedule`, { json: { sendAt } })).message;
    },
    setFollowup(contactId: string, body: { enabled: boolean; delayDays?: number }): Promise<FollowupResult> {
      return request("PUT", `/api/contacts/${seg(contactId)}/followup`, { json: body });
    },
    cancelMessage(messageId: string): Promise<CancelResult> {
      return request("DELETE", `/api/messages/${seg(messageId)}`);
    },
    /** Settle a message whose delivery is unknown (state needs_review). */
    resolveMessage(messageId: string, action: ResolveAction): Promise<CancelResult> {
      return request("POST", `/api/messages/${seg(messageId)}/resolve`, { json: { action } });
    },

    // Template, dashboard, sweep
    async getFollowupTemplate(): Promise<FollowupTemplate> {
      return (await request<{ template: FollowupTemplate }>("GET", "/api/template/followup")).template;
    },
    async saveFollowupTemplate(template: FollowupTemplate): Promise<FollowupTemplate> {
      return (await request<{ template: FollowupTemplate }>("PUT", "/api/template/followup", { json: template })).template;
    },
    getDashboard(): Promise<Dashboard> {
      return request("GET", "/api/dashboard");
    },
    runSweep(): Promise<SweepResult> {
      return request("POST", "/api/sweep");
    },
  };
}

export type Api = ReturnType<typeof createApi>;

/** App-wide client. Components import this; tests stub global fetch and call resetApiState(). */
export const api = createApi();

export function resetApiState() {
  api.reset();
}
