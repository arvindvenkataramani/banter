// What the HTTP adapters share: paths under the caller's endpoint, and the text of a failed answer.

/** The endpoint without a trailing slash, so a path can follow it. */
export const trimEndpoint = (endpoint: string): string => endpoint.replace(/\/$/, "");

/** An error carrying the status and the server's own text: the body's `error` (a string or `error.message`), or the raw body. */
export async function failure(res: Response): Promise<Error> {
  const raw = await res.text().catch(() => "");
  let text = raw;
  try {
    const error = (JSON.parse(raw) as { error?: unknown } | null)?.error;
    if (typeof error === "string") text = error;
    else if (typeof (error as { message?: unknown } | undefined)?.message === "string") text = (error as { message: string }).message;
  } catch {
    // Not JSON: the raw body is the text.
  }
  return new Error(`${res.status} ${text || res.statusText}`.trim());
}
