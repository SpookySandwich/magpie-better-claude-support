import { secretRequests } from "./lib/secrets.mjs";

export function onRequest(body, context) {
  // The native adapter consumes Chat Completions. Group routes may choose it
  // after this hook runs, so capture those as well as direct Claude routes.
  if (context.options?.restoreSecrets === false || context.protocol !== "chat" ||
      !/^(?:claude-native\/|group\/)/.test(body.model ?? "")) return;
  const capture = secretRequests.capture(body);
  if (!capture) { context.report?.("unavailable"); return; }
  context.state.restoreRequest = capture.id;
  context.report?.("ready");
  return capture.body;
}

export function onResponse(_reply, context) {
  secretRequests.release(context.state.restoreRequest);
}
