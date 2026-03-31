import assert from "node:assert/strict";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffBundle,
  getInstalledBundles,
  getInstalledSkills,
  getPackList,
  inspectBundle,
  installBundle,
  repairInstallState,
  uninstallAll,
  uninstallBundleOrSkill
} from "../index.js";

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
  const payload = await inspectBundle("repo-onboarding-pack", { installed: true });

  assert.equal(payload.name, "repo-onboarding-pack");
  assert.equal(payload.source, "repo-onboarding-pack");
  assert.ok(payload.skills.some((skill) => skill.name === "repo-map"));
  assert.ok(payload.installedState);
});

await run("install built-in pack writes manifest v2 entry and list installed returns it", async () => {
  await withTempRepo(async () => {
    await installBundle("debug-triage-pack");
    const bundles = await getInstalledBundles();
    const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));

    assert.equal(manifest.manifestVersion, 2);
    assert.ok(Array.isArray(manifest.bundles[0]?.skills));
    assert.ok(bundles.some((bundle) =>
      bundle.bundle === "debug-triage-pack" &&
      bundle.bundleVersion === "0.1.0" &&
      bundle.sourceType === "builtin" &&
      bundle.skillDir === ".skillcast/skills" &&
      bundle.installedSkills.includes("bug-triage")
    ));
    assert.ok(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "bug-triage", "SKILL.md")));
    assert.ok(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "fix-verification", "SKILL.md")));

    const bugTriageSkill = await fs.readFile(
      path.join(process.cwd(), ".skillcast", "skills", "bug-triage", "SKILL.md"),
      "utf8"
    );
    assert.match(bugTriageSkill, /# bug-triage/);
    assert.match(bugTriageSkill, /## Instructions/);
    assert.match(bugTriageSkill, /Bundle: debug-triage-pack@0\.1\.0/);
  });
});

await run("uninstall bundle removes all installed skills and manifest entry", async () => {
  await withTempRepo(async () => {
    await installBundle("debug-triage-pack");

    const result = await uninstallBundleOrSkill("debug-triage-pack");
    const bundles = await getInstalledBundles();

    assert.equal(result.removedType, "bundle");
    assert.deepEqual(result.removedSkills, [
      "bug-triage",
      "failing-test-diagnosis",
      "fix-verification",
      "log-investigation",
      "minimal-repro-plan"
    ]);
    assert.equal(bundles.length, 0);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "bug-triage")), false);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "fix-verification")), false);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast")), false);
  });
});

await run("uninstall single skill removes only that skill and keeps bundle manifest valid", async () => {
  await withTempRepo(async () => {
    await installBundle("debug-triage-pack");

    const result = await uninstallBundleOrSkill("bug-triage");
    const bundles = await getInstalledBundles();

    assert.equal(result.removedType, "skill");
    assert.deepEqual(result.removedSkills, ["bug-triage"]);
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0]?.bundle, "debug-triage-pack");
    assert.equal(bundles[0]?.installedSkills.includes("bug-triage"), false);
    assert.ok(bundles[0]?.installedSkills.includes("fix-verification"));
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "bug-triage")), false);
    assert.ok(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "fix-verification", "SKILL.md")));
  });
});

await run("install --update refreshes installed skill content and manifest metadata", async () => {
  await withTempRepo(async () => {
    const bundlePath = await createBundle({
      bundleName: "local-pack",
      bundleVersion: "0.1.0",
      skillName: "alpha-skill",
      skillId: "org.example.alpha",
      description: "Initial alpha skill",
      instructions: "Initial instructions"
    });

    await installBundle(bundlePath);

    await createBundle({
      rootDir: bundlePath,
      bundleName: "local-pack",
      bundleVersion: "0.2.0",
      skillName: "alpha-skill",
      skillId: "org.example.alpha",
      description: "Updated alpha skill",
      instructions: "Updated instructions"
    });

    const result = await installBundle(bundlePath, { update: true });
    const installedFile = await fs.readFile(path.join(process.cwd(), ".skillcast", "skills", "alpha-skill", "SKILL.md"), "utf8");
    const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));

    assert.equal(result.action, "updated");
    assert.match(installedFile, /Updated instructions/);
    assert.equal(manifest.bundles[0]?.bundleVersion, "0.2.0");
    assert.equal(manifest.bundles[0]?.skills[0]?.id, "org.example.alpha");
    assert.ok(typeof manifest.bundles[0]?.skills[0]?.fileHash === "string");
  });
});

await run("update warns and stops before overwriting locally modified skills without force", async () => {
  await withTempRepo(async () => {
    const bundlePath = await createBundle({
      bundleName: "local-pack",
      bundleVersion: "0.1.0",
      skillName: "alpha-skill",
      skillId: "org.example.alpha",
      description: "Initial alpha skill",
      instructions: "Initial instructions"
    });

    await installBundle(bundlePath);

    await fs.appendFile(path.join(process.cwd(), ".skillcast", "skills", "alpha-skill", "SKILL.md"), "\nLocal edit\n", "utf8");

    await createBundle({
      rootDir: bundlePath,
      bundleName: "local-pack",
      bundleVersion: "0.2.0",
      skillName: "alpha-skill",
      skillId: "org.example.alpha",
      description: "Updated alpha skill",
      instructions: "Updated instructions"
    });

    await assert.rejects(
      installBundle(bundlePath, { update: true }),
      /modified locally/
    );
  });
});

await run("collision handling blocks duplicate skill names from different bundles unless forced", async () => {
  await withTempRepo(async () => {
    const firstBundle = await createBundle({
      bundleName: "bundle-one",
      bundleVersion: "0.1.0",
      skillName: "shared-skill",
      skillId: "org.example.one.shared",
      description: "First shared skill",
      instructions: "First bundle instructions"
    });
    const secondBundle = await createBundle({
      bundleName: "bundle-two",
      bundleVersion: "0.1.0",
      skillName: "shared-skill",
      skillId: "org.example.two.shared",
      description: "Second shared skill",
      instructions: "Second bundle instructions"
    });

    await installBundle(firstBundle);
    await assert.rejects(installBundle(secondBundle), /Skill collision/);

    const forced = await installBundle(secondBundle, { force: true });
    const bundles = await getInstalledBundles();
    const installedFile = await fs.readFile(path.join(process.cwd(), ".skillcast", "skills", "shared-skill", "SKILL.md"), "utf8");

    assert.equal(forced.action, "installed");
    assert.equal(bundles.some((bundle) => bundle.bundle === "bundle-one"), false);
    assert.equal(bundles.some((bundle) => bundle.bundle === "bundle-two"), true);
    assert.match(installedFile, /Second bundle instructions/);
  });
});

await run("diff reports source and local modifications for installed bundles", async () => {
  await withTempRepo(async () => {
    const bundlePath = await createBundle({
      bundleName: "local-pack",
      bundleVersion: "0.1.0",
      skillName: "alpha-skill",
      skillId: "org.example.alpha",
      description: "Initial alpha skill",
      instructions: "Initial instructions"
    });

    await installBundle(bundlePath);
    await fs.appendFile(path.join(process.cwd(), ".skillcast", "skills", "alpha-skill", "SKILL.md"), "\nLocal edit\n", "utf8");

    const diff = await diffBundle(bundlePath);
    assert.equal(diff.installed, true);
    assert.equal(diff.changes[0]?.status, "local-modified");
  });
});

await run("manifest v1 is migrated through lifecycle reads", async () => {
  await withTempRepo(async () => {
    await fs.ensureDir(path.join(process.cwd(), ".skillcast", "skills", "legacy-skill"));
    await fs.writeFile(
      path.join(process.cwd(), ".skillcast", "skills", "legacy-skill", "SKILL.md"),
      "# legacy-skill\n\nlegacy\n",
      "utf8"
    );
    await fs.writeJson(path.join(process.cwd(), ".skillcast", "manifest.json"), {
      manifestVersion: 1,
      bundles: [
        {
          bundle: "legacy-pack",
          bundleVersion: "0.1.0",
          source: "./legacy-pack",
          sourceType: "path",
          installedSkills: ["legacy-skill"],
          installedAt: "2026-03-31T00:00:00.000Z",
          skillDir: ".skillcast/skills"
        }
      ]
    }, { spaces: 2 });

    const bundles = await getInstalledBundles();
    assert.equal(bundles[0]?.updatedAt, "2026-03-31T00:00:00.000Z");

    const result = await uninstallBundleOrSkill("legacy-pack");
    assert.equal(result.removedType, "bundle");
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast")), false);
  });
});

await run("uninstall all removes every bundle and cleans the .skillcast directory", async () => {
  await withTempRepo(async () => {
    await installBundle("repo-onboarding-pack");
    await installBundle("pr-workflow-pack");

    const result = await uninstallAll();
    const bundles = await getInstalledBundles();

    assert.equal(result.removedTarget, "--all");
    assert.equal(result.removedSkills.length, 10);
    assert.equal(bundles.length, 0);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast")), false);
  });
});

await run("installed skills listing returns repo-local installed skills", async () => {
  await withTempRepo(async () => {
    await installBundle("repo-onboarding-pack");

    const skills = await getInstalledSkills();

    assert.equal(skills.length, 5);
    assert.ok(skills.some((skill) => skill.name === "repo-map" && skill.bundle === "repo-onboarding-pack"));
    assert.ok(skills.every((skill) => skill.path.startsWith(".skillcast/skills/")));
  });
});

await run("uninstall dry-run reports removals without changing files", async () => {
  await withTempRepo(async () => {
    await installBundle("repo-onboarding-pack");

    const result = await uninstallBundleOrSkill("repo-onboarding-pack", { dryRun: true });

    assert.match(result.message, /Dry run/);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast", "manifest.json")), true);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "repo-map", "SKILL.md")), true);
  });
});

await run("repair detects missing and orphaned installed skills and can repair missing manifest entries", async () => {
  await withTempRepo(async () => {
    await installBundle("repo-onboarding-pack");
    await fs.remove(path.join(process.cwd(), ".skillcast", "skills", "repo-map"));
    await fs.ensureDir(path.join(process.cwd(), ".skillcast", "skills", "orphaned-skill"));
    await fs.writeFile(path.join(process.cwd(), ".skillcast", "skills", "orphaned-skill", "SKILL.md"), "# orphaned", "utf8");

    const report = await repairInstallState();
    assert.ok(report.missingSkills.some((skill) => skill.includes("repo-map")));
    assert.ok(report.orphanedSkills.includes("orphaned-skill"));

    const repaired = await repairInstallState({ write: true });
    const bundles = await getInstalledBundles();

    assert.equal(repaired.repaired, true);
    assert.equal(bundles[0]?.installedSkills.includes("repo-map"), false);
    assert.equal(await fs.pathExists(path.join(process.cwd(), ".skillcast", "skills", "orphaned-skill", "SKILL.md")), true);
  });
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

async function withTempRepo(task: () => Promise<void>): Promise<void> {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), "skillcast-v0-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(tempRepo);
    await task();
  } finally {
    process.chdir(previousCwd);
    await fs.remove(tempRepo);
  }
}

async function createBundle(options: {
  rootDir?: string;
  bundleName: string;
  bundleVersion: string;
  skillName: string;
  skillId: string;
  description: string;
  instructions: string;
}): Promise<string> {
  const rootDir = options.rootDir ?? path.join(process.cwd(), `${options.bundleName}-${Math.random().toString(16).slice(2)}`);
  const skillDir = path.join(rootDir, "skills", options.skillName);

  await fs.ensureDir(skillDir);
  await fs.writeFile(path.join(rootDir, "bundle.yaml"), [
    `name: ${options.bundleName}`,
    `version: ${options.bundleVersion}`,
    `description: ${options.description}`,
    "skills:",
    `  - name: ${options.skillName}`,
    `    path: ./skills/${options.skillName}`,
    "targets:",
    "  - generic-agent",
    ""
  ].join("\n"), "utf8");

  await fs.writeFile(path.join(skillDir, "skill.yaml"), [
    `id: ${options.skillId}`,
    `name: ${options.skillName}`,
    `version: ${options.bundleVersion}`,
    `description: ${options.description}`,
    "entry:",
    "  instructions: ./instructions.md",
    "inputs:",
    "  - name: input",
    "    type: string",
    "    required: true",
    "outputs:",
    "  - name: result",
    "    type: string",
    "compatibility:",
    "  runtimes:",
    "    - generic-agent",
    ""
  ].join("\n"), "utf8");

  await fs.writeFile(path.join(skillDir, "instructions.md"), options.instructions, "utf8");
  return rootDir;
}
