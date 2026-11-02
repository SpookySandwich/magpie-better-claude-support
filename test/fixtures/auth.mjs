import { existsSync, writeFileSync } from "node:fs";

if (Object.keys(process.env).some((key) => /^(ANTHROPIC_|CLAUDE)/i.test(key))) process.exit(9);
const scenario = process.env.AUTH_SCENARIO;
if (process.argv.includes("status")) {
  if (scenario === "malformed") {
    console.log("invalid");
    process.exit(0);
  }
  const loggedIn =
    scenario === "existing" || scenario === "api" || existsSync(process.env.AUTH_MARKER ?? "");
  console.log(
    JSON.stringify({
      loggedIn,
      authMethod: scenario === "api" ? "api_key" : "claude.ai",
      apiProvider: "firstParty",
      email: "fixture@example.com",
    }),
  );
  process.exit(loggedIn ? 0 : 1);
}
if (process.argv.includes("login")) {
  if (!process.argv.includes("--claudeai")) process.exit(8);
  if (scenario === "no-link") setInterval(() => {}, 1000);
  else {
    process.stdout.write(
      "Opening browser: https://claude.com/cai/oauth/authorize?client_id=fixture",
    );
    setTimeout(() => {
      console.log("&state=fixture");
      setTimeout(() => {
        if (scenario === "login") writeFileSync(process.env.AUTH_MARKER, "signed-in");
        process.exit(scenario === "login" ? 0 : 1);
      }, 30);
    }, 30);
  }
}
