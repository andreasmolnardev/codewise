import { DatabaseSync } from "node:sqlite";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const [backupDir] = process.argv.slice(2);
if (!backupDir) throw new Error("Usage: node restore-validate.mjs <backup-directory>");
const root = resolve(backupDir);
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
if (manifest.format !== 1 || manifest.database !== "state.sqlite") {
  throw new Error("Unsupported or invalid Codewise backup manifest.");
}
const databasePath = resolve(root, manifest.database);
await access(databasePath);
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  const result = database.prepare("PRAGMA integrity_check").get().integrity_check;
  if (result !== "ok") throw new Error(`SQLite integrity check failed: ${result}`);
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("SQLite foreign key check failed.");
  }
} finally {
  database.close();
}
console.log(`Backup is valid and restorable: ${root}`);
