import { connection } from "next/server";

/** Marks a GET handler as request-time (not prerendered). No-op outside a request scope (unit tests). */
export async function requestTime() {
  try {
    await connection();
  } catch {
    // Called outside Next's request scope (e.g. direct handler invocation in tests).
  }
}
