// pnpm demo:backup [label] | pnpm demo:restore [folder]: copies of the local database (accounts/local), with the
// backend stopped. A restore first backs up the database it replaces, so nothing is ever lost. With no folder,
// demo:restore lists the databases: namespace, accounts, licences, last change.
import { backup, describe, folders, requireStopped, restore, ACTIVE } from "./lib/local-db.js";

const [cmd, arg] = process.argv.slice(2);
if (cmd === "backup" || (cmd === "restore" && arg)) await requireStopped();
if (cmd === "backup") {
  const ns = describe(ACTIVE);
  const name = backup(arg || (ns.exists && ns.namespace ? ns.namespace.replace(/^likeness-eth-/, "") : "manual"));
  console.log(name ? `backed up accounts/local to accounts/${name}` : "nothing to back up: there is no active database");
} else if (cmd === "restore" && arg) {
  const saved = restore(arg);
  const now = describe(ACTIVE);
  console.log(`restored accounts/${arg} as accounts/local${now.exists ? ` (${now.namespace ?? "no namespace"}, ${now.accounts} accounts, ${now.licences} licences)` : ""}${saved ? `; the previous one is at accounts/${saved}` : ""}`);
} else {
  for (const f of folders()) console.log(`${f.name === "local" ? "* " : "  "}${f.name.padEnd(40)} ${(f.exists && f.namespace) || "-"}`.padEnd(66) + `${f.exists ? `${f.accounts} accounts, ${f.licences} licences, ${f.modified.slice(0, 16)}` : ""}`);
  if (cmd !== "list") console.log("\nusage: pnpm demo:backup [label] | pnpm demo:restore <folder> (* = active)");
}
