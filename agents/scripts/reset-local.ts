// pnpm reset-local: wipes the local development database (accounts, sessions, sign-in attempts, pending actions and
// licence records of LIKENESS_MODE=local). Refuses while the backend is running. Other modes are never touched.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../accounts/local/", import.meta.url));
const port = Number(process.env.PORT || 8788);
const running = await new Promise<boolean>((r) => {
  const s = createConnection({ host: "127.0.0.1", port }, () => (s.end(), r(true)));
  s.on("error", () => r(false));
});
if (running) {
  console.error(`The backend is running on 127.0.0.1:${port}: stop it first (Ctrl-C in its terminal), then run pnpm reset-local again.`);
  process.exit(1);
}
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^accounts\.sqlite(-wal|-shm|-journal)?$/.test(f)) : [];
for (const f of files) rmSync(`${dir}${f}`);
console.log(files.length ? `Removed ${files.map((f) => `accounts/local/${f}`).join(", ")}. The next start begins with no accounts.` : "Nothing to remove: no local database yet.");
