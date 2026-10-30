/** @internal Turns a failed HTTP response into the transport's error, keeping a server business sentence. */
async function harnessResponseError(response: Response): Promise<AgentChatTransportError> {
  // The status and the body stay on the error for the console; the sentence in the chat is
  // the Agent API's own business sentence when the body carries one — a 409 with `reason`, a
  // 4xx with `error.message` — or `labels.transportError` otherwise. A proxy's bare "HTTP 502"
  // is never shown; that is exactly what `transportFailure` below routes away from the chat.
  let message = "The assistant could not be reached; please try again shortly.";
  let details: unknown;
  let businessMessage = false;
  let reason: string | undefined;
  try {
    details = await response.json() as unknown;
    if (transportRecord(details) && transportRecord(details.error) && typeof details.error.code === "string" && typeof details.error.message === "string") {
      message = details.error.message;
      businessMessage = true;
      if (typeof details.error.reason === "string") reason = details.error.reason;
    }
  } catch { /* Use the fallback sentence. */ }
  const conflict = transportRecord(details) && transportRecord(details.error) && details.error.code === "conflict";
  // A 409 that names no `reason` is a stale runtime lease or a lost race — retrying can still
  // resolve it. A *reasoned* conflict (expired/superseded/already-resolved/stale-binding) is the
  // server saying the card is already settled: retrying only delays the card reaching its final
  // state, with rejected resumes for the one click that already happened.
  return new AgentChatTransportError(message, {
    code: "http-error", status: response.status, retryable: response.status >= 500 || (response.status === 409 && conflict && reason === undefined),
    details, transportFailure: !businessMessage, ...(reason ? { reason } : {}),
  });
}
