import { backup, DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, relative, sep } from "node:path";

const [source = "/var/lib/codewise", destination] = process.argv.slice(2);
if (!destination) {
  throw new Error("Usage: node backup.mjs [state-dir] <backup-destination>");
}

const sourceDir = resolve(source);
const destinationDir = resolve(destination);
const isWithin = (child, parent) => child === parent || child.startsWith(`${parent}${sep}`);
if (isWithin(destinationDir, sourceDir)) {
  throw new Error("Backup destination must be outside the Codewise state directory.");
}

const dbPath = resolve(sourceDir, "userdata/state.sqlite");
const dbInfo = await lstat(dbPath).catch(() => null);
if (!dbInfo?.isFile()) throw new Error(`No SQLite database exists at ${dbPath}.`);

await mkdir(destinationDir, { recursive: true, mode: 0o700 });
const backupDbPath = resolve(destinationDir, "state.sqlite");
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  await backup(db, backupDbPath);
} finally {
  db.close();
}

// Copy every non-database state file. The database itself is copied through
// SQLite's online backup API so WAL activity cannot create an inconsistent
// snapshot. Exclude lock/WAL files that are process-local or already folded in.
for (const name of ["userdata/attachments", "userdata/secrets", "userdata/settings.json", "userdata/keybindings.json", "userdata/environment-id", "userdata/anonymous-id"]) {
  const from = resolve(sourceDir, name);
  const to = resolve(destinationDir, "state", name);
  const info = await lstat(from).catch(() => null);
  if (info) {
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await cp(from, to, { recursive: info.isDirectory(), force: true, preserveTimestamps: true });
  }
}

const verificationDb = new DatabaseSync(backupDbPath, { readOnly: true });
let integrityCheck;
let schemaVersion;
try {
  integrityCheck = verificationDb.prepare("PRAGMA integrity_check").get().integrity_check;
  schemaVersion = verificationDb.prepare("PRAGMA user_version").get().user_version;
} finally {
  verificationDb.close();
}
if (integrityCheck !== "ok") throw new Error(`SQLite integrity check failed: ${integrityCheck}`);

const manifest = {
  format: 1,
  createdAt: new Date().toISOString(),
  applicationVersion: process.env.CODEWISE_VERSION ?? "unknown",
  schemaVersion,
  database: basename(backupDbPath),
  stateRoot: relative(destinationDir, resolve(destinationDir, "state")),
  sqliteIntegrityCheck: integrityCheck,
};
await writeFile(resolve(destinationDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`Created verified backup at ${destinationDir}`);
