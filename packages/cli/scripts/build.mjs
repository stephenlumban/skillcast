import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const distDir = path.join(packageRoot, "dist");
const sourceBundlesDir = path.join(repoRoot, "examples", "bundles");
const catalogPath = path.join(sourceBundlesDir, "catalog.json");
const builtinDistDir = path.join(distDir, "builtin");

await fs.rm(distDir, { recursive: true, force: true });
await run("npx", ["tsc", "-p", "tsconfig.json"], packageRoot);
await fs.mkdir(builtinDistDir, { recursive: true });

const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
await fs.copyFile(catalogPath, path.join(builtinDistDir, "catalog.json"));

for (const pack of catalog.packs) {
  const sourcePath = path.resolve(sourceBundlesDir, pack.path);
  const targetPath = path.join(builtinDistDir, path.basename(sourcePath));
  await fs.cp(sourcePath, targetPath, { recursive: true });
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32"
    });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}`));
    });
    child.on("error", reject);
  });
}
