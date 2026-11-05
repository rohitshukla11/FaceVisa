import type { IncomingMessage } from "node:http";
import { csrfToken } from "../src/app/session.js";

/** The CSRF token the server expects for a session cookie header (what /api/me hands the browser), or "". */
export const csrfFor = (cookie: string | undefined) => (cookie ? (csrfToken({ headers: { cookie } } as IncomingMessage) ?? "") : "");
/** That token as the x-csrf-token header, when there is a session. */
export const csrfHeaders = (cookie: string | undefined): Record<string, string> => (csrfFor(cookie) ? { "x-csrf-token": csrfFor(cookie) } : {});
