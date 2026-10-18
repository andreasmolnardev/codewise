import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packages = ["subpolar-core", "subpolar-core-pi", "subpolar-cli"].filter((name) =>
  existsSync(fileURLToPath(new URL(`../../${name}/src/`, import.meta.url))),
);

for (const name of packages) {
  test(`${name} source has no Subpolar Agent or PocketBase runtime imports`, async () => {
    const cwd = fileURLToPath(new URL(`../../${name}/src/`, import.meta.url));
    for await (const path of new Bun.Glob("**/*.ts").scan(cwd)) {
      const source = await Bun.file(`${cwd}/${path}`).text();
      expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:subpolar-agent|pocketbase|hono)[^"']*["']/i);
      if (name === "subpolar-core") expect(source).not.toMatch(/(?:from|import\()\s*["'][^"']*(?:core-pi|pi-coding-agent)[^"']*["']/i);
    }
  });
}
