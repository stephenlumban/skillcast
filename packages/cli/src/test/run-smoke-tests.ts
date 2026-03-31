import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInstalledBundles, getPackList, inspectBundle, installBundle } from "../index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

await run("list packs uses curated built-in catalog", async () => {
  process.chdir(repoRoot);
  const packs = await getPackList();

  assert.ok(packs.some((pack) => pack.name === "repo-onboarding-pack"));
  assert.ok(packs.some((pack) => pack.name === "pr-workflow-pack"));
  assert.ok(!packs.some((pack) => pack.name === "sample-pack"));
});

await run("inspect accepts built-in pack names", async () => {
  process.chdir(repoRoot);
  const payload = await inspectBundle("repo-onboarding-pack");

  assert.equal(payload.name, "repo-onboarding-pack");
  assert.equal(payload.source, "repo-onboarding-pack");
  assert.ok(payload.skills.some((skill) => skill.name === "repo-map"));
});

await run("install built-in pack writes manifest entry and list installed returns it", async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "skillcast-v0-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempRepo);
    await installBundle("debug-triage-pack");
    const bundles = await getInstalledBundles();

    assert.ok(bundles.some((bundle) =>
      bundle.bundle === "debug-triage-pack" &&
      bundle.bundleVersion === "0.1.0" &&
      bundle.sourceType === "builtin" &&
      bundle.skillDir === ".skillcast/skills" &&
      bundle.installedSkills.includes("bug-triage")
    ));
    assert.ok(await fs.pathExists(path.join(tempRepo, ".skillcast", "skills", "bug-triage", "SKILL.md")));
    assert.ok(await fs.pathExists(path.join(tempRepo, ".skillcast", "skills", "fix-verification", "SKILL.md")));

    const bugTriageSkill = await fs.readFile(
      path.join(tempRepo, ".skillcast", "skills", "bug-triage", "SKILL.md"),
      "utf8"
    );
    assert.match(bugTriageSkill, /# bug-triage/);
    assert.match(bugTriageSkill, /## Instructions/);
    assert.match(bugTriageSkill, /Bundle: debug-triage-pack@0\.1\.0/);
  } finally {
    process.chdir(previousCwd);
    await fs.remove(tempRepo);
  }
});

console.log("Smoke tests passed.");

async function run(name: string, task: () => Promise<void>): Promise<void> {
  try {
    await task();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
