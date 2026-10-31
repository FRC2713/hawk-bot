import { readFileSync } from "node:fs";
const contract = JSON.parse(
  readFileSync(new URL("../.hawk/app.json", import.meta.url), "utf8")
);
if (process.argv.includes("--contract")) {
  console.log(JSON.stringify(contract));
} else {
  // Never initialize SQLite, schedulers or external clients in this command.
  const missing = contract.required_env.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
  try {
    const { config } = await import("../dist/src/config.js");
    config();
    const { encrypt } = await import("../dist/src/crypto.js");
    encrypt("deployment-check");
    for (const name of ["PUBLIC_URL", "APP_URL", "ONSHAPE_REDIRECT_URI"]) {
      if (process.env[name]) {
        const url = new URL(process.env[name]);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      }
    }
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
      const key = JSON.parse(
        Buffer.from(
          process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64,
          "base64"
        ).toString("utf8")
      );
      if (
        key.type !== "service_account" ||
        !key.client_email ||
        !key.private_key
      )
        throw new Error();
    }
    if (
      process.env.REPORT_TIME &&
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.REPORT_TIME)
    )
      throw new Error();
    console.log(JSON.stringify({ status: "ok", contract: contract.schema }));
  } catch {
    // Parse errors can contain credentials. Report names, never values.
    console.error(
      "Invalid deployment configuration; check the app environment contract."
    );
    process.exit(1);
  }
}
