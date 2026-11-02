// Only call for a native error, never ordinary assistant text or tool output.
// These are account/service refusals which another source can satisfy. Invalid
// requests, context limits and ambiguous failures stay terminal.
export function upstreamRefusal(message, type) {
  if (/prompt is too long|context.{0,20}(length|window|limit)|invalid_request_error/i.test(message))
    return undefined;
  const status = Number(message.match(/(?:API Error:|HTTP(?: status)?|status(?: code)?)[\s:]+(\d{3})\b/i)?.[1]);
  if (type === "rate_limit" || type === "rate_limit_error" || status === 429 ||
      /\brate[_ -]?limit(?:ed|_error)?\b|\bquota (?:exceeded|reached)|(?:you(?:'ve| have)|usage) (?:hit|reached|exceeded) (?:your |the )?limit|usage limit (?:reached|exceeded)/i.test(message))
    return { status: 429, type: "rate_limit_error", code: "native_upstream_rate_limit" };
  if (type === "authentication_failed" || type === "authentication_error" || status === 401 ||
      /authentication_error|failed to authenticate|OAuth (?:token|session).{0,40}expired|invalid (?:API key|authentication credentials)/i.test(message))
    return { status: 401, type: "authentication_error", code: "native_upstream_auth" };
  if (type === "billing_error" || status === 402 || /credit balance is too low|insufficient credits|billing_error/i.test(message))
    return { status: 402, type: "billing_error", code: "native_upstream_credit" };
  if (type === "permission_error" || status === 403)
    return { status: 403, type: "permission_error", code: "native_upstream_permission" };
  if (type === "overloaded_error" || status === 529 || /overloaded_error|\boverloaded\b/i.test(message))
    return { status: 529, type: "overloaded_error", code: "native_upstream_overloaded" };
  if (type === "server_error" || type === "api_error" || status >= 500 && status <= 599)
    return { status: status >= 500 && status <= 599 ? status : 502, type: "api_error", code: "native_upstream_unavailable" };
}
