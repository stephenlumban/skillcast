import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "fs-extra";
import http from "node:http";
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
  listBundleSkills,
  parseRemoteBundleReference,
  repairInstallState,
  uninstallAll,
  uninstallBundleOrSkill,
  validateBundle
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

await run("install built-in pack writes manifest v3 entry and list installed returns it", async () => {
  await withTempRepo(async () => {
    await installBundle("debug-triage-pack");
    const bundles = await getInstalledBundles();
    const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));

    assert.equal(manifest.manifestVersion, 3);
    assert.ok(Array.isArray(manifest.bundles[0]?.skills));
    assert.equal(manifest.bundles[0]?.resolution, undefined);
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

await run("manifest v2 is migrated through lifecycle reads", async () => {
  await withTempRepo(async () => {
    await fs.ensureDir(path.join(process.cwd(), ".skillcast", "skills", "legacy-skill"));
    await fs.writeFile(
      path.join(process.cwd(), ".skillcast", "skills", "legacy-skill", "SKILL.md"),
      "# legacy-skill\n\nlegacy\n",
      "utf8"
    );
    await fs.writeJson(path.join(process.cwd(), ".skillcast", "manifest.json"), {
      manifestVersion: 2,
      bundles: [
        {
          bundle: "legacy-pack",
          bundleVersion: "0.1.0",
          source: "./legacy-pack",
          sourceType: "path",
          installedSkills: ["legacy-skill"],
          installedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          skillDir: ".skillcast/skills",
          skills: [
            {
              id: "legacy.skill",
              name: "legacy-skill",
              version: "0.1.0",
              relativePath: ".skillcast/skills/legacy-skill/SKILL.md",
              fileHash: "",
              sourceHash: "",
              installedAt: "2026-03-31T00:00:00.000Z",
              updatedAt: "2026-03-31T00:00:00.000Z",
              ownership: {
                bundle: "legacy-pack",
                source: "./legacy-pack",
                sourceType: "path"
              }
            }
          ]
        }
      ]
    }, { spaces: 2 });

    const bundles = await getInstalledBundles();
    const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));

    assert.equal(bundles[0]?.bundle, "legacy-pack");
    assert.equal(manifest.manifestVersion, 2);
  });
});

await run("registry-style remote references are no longer parsed", async () => {
  assert.equal(parseRemoteBundleReference("skillcast:acme/repo-onboarding"), null);
  assert.equal(parseRemoteBundleReference("skillcast:acme/repo-onboarding@1.4.2"), null);
  assert.equal(parseRemoteBundleReference("skillcast://registry.skillcast.dev/acme/repo-onboarding@stable"), null);
  assert.equal(parseRemoteBundleReference("./local-pack"), null);
});

await run("inspect supports remote bundle references through registry resolution", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: artifact
  });

  try {
    const payload = await inspectBundle(`skillcast://${registry.registryHost}/acme/repo-onboarding`);

    assert.equal(payload.name, "remote-pack");
    assert.equal(payload.version, "1.4.2");
    assert.equal(payload.source, `skillcast://${registry.registryHost}/acme/repo-onboarding`);
    assert.equal(payload.resolvedVersion, "1.4.2");
    assert.ok(typeof payload.resolvedDigest === "string");
    assert.ok(payload.skills.some((skill) => skill.id === "acme.repo.repo-map"));
  } finally {
    await registry.close();
  }
});

await run("inspect supports direct artifact URLs", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "url-pack",
    bundleVersion: "1.0.0",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Direct URL onboarding skill",
    instructions: "Direct URL instructions"
  });
  const server = await startArtifactServer({ artifactBody: artifact });

  try {
    const payload = await inspectBundle(server.artifactUrl);

    assert.equal(payload.name, "url-pack");
    assert.equal(payload.version, "1.0.0");
    assert.equal(payload.source, server.artifactUrl);
    assert.equal(payload.resolvedVersion, undefined);
    assert.equal(payload.resolvedDigest, undefined);
    assert.ok(payload.skills.some((skill) => skill.id === "acme.repo.repo-map"));
  } finally {
    await server.close();
  }
});

await run("validate and list skills support remote bundle references", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: artifact
  });

  try {
    const ref = `skillcast://${registry.registryHost}/acme/repo-onboarding`;
    const bundle = await validateBundle(ref);
    const payload = await listBundleSkills(ref);

    assert.equal(bundle.config.name, "remote-pack");
    assert.equal(payload.bundle, "remote-pack");
    assert.ok(payload.skills.some((skill) => skill.id === "acme.repo.repo-map"));
  } finally {
    await registry.close();
  }
});

await run("direct artifact URL install writes manifest url source metadata and updates cleanly", async () => {
  const initialArtifact = createRemoteArtifact({
    bundleName: "url-pack",
    bundleVersion: "1.0.0",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Direct URL onboarding skill",
    instructions: "Direct URL instructions"
  });
  const updatedArtifact = createRemoteArtifact({
    bundleName: "url-pack",
    bundleVersion: "1.1.0",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Direct URL onboarding skill",
    instructions: "Updated direct URL instructions"
  });
  const server = await startArtifactServer({ artifactBody: initialArtifact });

  try {
    await withTempRepo(async () => {
      const result = await installBundle(server.artifactUrl);
      const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));

      assert.equal(result.action, "installed");
      assert.equal(result.resolvedVersion, undefined);
      assert.equal(result.resolvedDigest, undefined);
      assert.equal(manifest.bundles[0]?.sourceType, "url");
      assert.equal(manifest.bundles[0]?.source, server.artifactUrl);
      assert.equal(manifest.bundles[0]?.resolution, undefined);

      server.update({ artifactBody: updatedArtifact });

      const updated = await installBundle(server.artifactUrl, { update: true });
      const installedFile = await fs.readFile(path.join(process.cwd(), ".skillcast", "skills", "repo-map", "SKILL.md"), "utf8");

      assert.equal(updated.action, "updated");
      assert.match(installedFile, /Updated direct URL instructions/);
    });
  } finally {
    await server.close();
  }
});

await run("inspect rejects remote artifacts with mismatched digest", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: artifact,
    digest: "sha256:deadbeef"
  });

  try {
    await assert.rejects(
      inspectBundle(`skillcast://${registry.registryHost}/acme/repo-onboarding`),
      /Digest mismatch/
    );
  } finally {
    await registry.close();
  }
});

await run("remote install writes manifest resolution metadata and inspect installed state works", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: artifact
  });

  try {
    await withTempRepo(async () => {
      const ref = `skillcast://${registry.registryHost}/acme/repo-onboarding`;
      const result = await installBundle(ref);
      const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));
      const payload = await inspectBundle(ref, { installed: true });

      assert.equal(result.action, "installed");
      assert.equal(result.resolvedVersion, "1.4.2");
      assert.ok(typeof result.resolvedDigest === "string");
      assert.equal(manifest.manifestVersion, 3);
      assert.equal(manifest.bundles[0]?.sourceType, "registry");
      assert.equal(manifest.bundles[0]?.resolution?.requestedRef, ref);
      assert.equal(manifest.bundles[0]?.resolution?.resolvedVersion, "1.4.2");
      assert.equal(payload.installedState?.installed, true);
      assert.equal(payload.installedState?.changedSkills.every((skill) => skill.status === "unchanged"), true);
    });
  } finally {
    await registry.close();
  }
});

await run("default registry config resolves skillcast refs without explicit host", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: artifact
  });

  try {
    await withTempRepo(async () => {
      await fs.writeJson(path.join(process.cwd(), "skillcast.config.json"), {
        defaultRegistry: `http://${registry.registryHost}`
      }, { spaces: 2 });

      const payload = await inspectBundle("skillcast:acme/repo-onboarding");
      assert.equal(payload.name, "remote-pack");
      assert.equal(payload.resolvedVersion, "1.4.2");
    });
  } finally {
    await registry.close();
  }
});

await run("default bundle store resolves bare bundle names and exposes latest version in pack list", async () => {
  const store = await startMockBundleStore({
    bundles: [
      createStoreBundleVersion({
        bundleName: "team-onboarding-pack",
        bundleVersion: "1.4.2",
        skillName: "repo-map",
        skillId: "acme.repo.repo-map",
        description: "Remote onboarding skill",
        instructions: "Remote instructions"
      })
    ]
  });

  try {
    await withTempRepo(async () => {
      await fs.writeJson(path.join(process.cwd(), "skillcast.config.json"), {
        defaultBundleStoreUrl: store.baseUrl
      }, { spaces: 2 });

      const payload = await inspectBundle("team-onboarding-pack@1.4.2");
      const packs = await getPackList();

      assert.equal(payload.name, "team-onboarding-pack");
      assert.equal(payload.resolvedVersion, "1.4.2");
      assert.ok(packs.some((pack) => pack.name === "team-onboarding-pack" && pack.version === "1.4.2" && pack.path === "store:team-onboarding-pack"));
    });
  } finally {
    await store.close();
  }
});

await run("default bundle store install resolves latest and supports explicit version pins", async () => {
  const store = await startMockBundleStore({
    bundles: [
      createStoreBundleVersion({
        bundleName: "team-onboarding-pack",
        bundleVersion: "1.4.1",
        skillName: "repo-map",
        skillId: "acme.repo.repo-map",
        description: "Remote onboarding skill",
        instructions: "Older remote instructions"
      }),
      createStoreBundleVersion({
        bundleName: "team-onboarding-pack",
        bundleVersion: "1.4.2",
        skillName: "repo-map",
        skillId: "acme.repo.repo-map",
        description: "Remote onboarding skill",
        instructions: "Latest remote instructions"
      })
    ]
  });

  try {
    await withTempRepo(async () => {
      await fs.writeJson(path.join(process.cwd(), "skillcast.config.json"), {
        defaultBundleStoreUrl: store.baseUrl
      }, { spaces: 2 });

      const result = await installBundle("team-onboarding-pack");
      const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));
      const installedFile = await fs.readFile(path.join(process.cwd(), ".skillcast", "skills", "repo-map", "SKILL.md"), "utf8");

      assert.equal(result.resolvedVersion, "1.4.2");
      assert.equal(manifest.bundles[0]?.sourceType, "store");
      assert.equal(manifest.bundles[0]?.bundleVersion, "1.4.2");
      assert.match(installedFile, /Latest remote instructions/);

      const pinned = await inspectBundle("team-onboarding-pack@1.4.1");
      assert.equal(pinned.resolvedVersion, "1.4.1");
    });
  } finally {
    await store.close();
  }
});

await run("remote inspect populates local artifact cache by digest", async () => {
  const artifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const digest = `sha256:${createHash("sha256").update(artifact, "utf8").digest("hex")}`;
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: artifact,
    digest
  });

  try {
    const cachePath = path.join(os.homedir(), ".skillcast", "cache", "artifacts", `${digest.slice("sha256:".length)}.json`);
    await fs.remove(cachePath);
    await inspectBundle(`skillcast://${registry.registryHost}/acme/repo-onboarding`);
    assert.equal(await fs.pathExists(cachePath), true);
  } finally {
    await registry.close();
  }
});

await run("remote install update refreshes resolved version and diff state", async () => {
  const initialArtifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.4.2",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Remote instructions"
  });
  const updatedArtifact = createRemoteArtifact({
    bundleName: "remote-pack",
    bundleVersion: "1.5.0",
    skillName: "repo-map",
    skillId: "acme.repo.repo-map",
    description: "Remote onboarding skill",
    instructions: "Updated remote instructions"
  });
  const registry = await startMockRegistry({
    packageName: "repo-onboarding",
    version: "1.4.2",
    artifactBody: initialArtifact
  });

  try {
    await withTempRepo(async () => {
      const ref = `skillcast://${registry.registryHost}/acme/repo-onboarding`;
      await installBundle(ref);

      registry.update({
        version: "1.5.0",
        artifactBody: updatedArtifact
      });

      const result = await installBundle(ref, { update: true });
      const manifest = await fs.readJson(path.join(process.cwd(), ".skillcast", "manifest.json"));
      const installedFile = await fs.readFile(path.join(process.cwd(), ".skillcast", "skills", "repo-map", "SKILL.md"), "utf8");
      const diff = await diffBundle(ref);

      assert.equal(result.action, "updated");
      assert.equal(manifest.bundles[0]?.bundleVersion, "1.5.0");
      assert.equal(manifest.bundles[0]?.resolution?.resolvedVersion, "1.5.0");
      assert.match(installedFile, /Updated remote instructions/);
      assert.equal(diff.changes[0]?.status, "unchanged");
    });
  } finally {
    await registry.close();
  }
});

await run("registry manifest entries require resolution metadata", async () => {
  await withTempRepo(async () => {
    await fs.ensureDir(path.join(process.cwd(), ".skillcast", "skills", "repo-map"));
    await fs.writeFile(
      path.join(process.cwd(), ".skillcast", "skills", "repo-map", "SKILL.md"),
      "# repo-map\n",
      "utf8"
    );
    await fs.writeJson(path.join(process.cwd(), ".skillcast", "manifest.json"), {
      manifestVersion: 3,
      bundles: [
        {
          bundle: "repo-onboarding",
          bundleVersion: "1.4.2",
          source: "skillcast:acme/repo-onboarding",
          sourceType: "registry",
          installedSkills: ["repo-map"],
          installedAt: "2026-03-31T00:00:00.000Z",
          updatedAt: "2026-03-31T00:00:00.000Z",
          skillDir: ".skillcast/skills",
          skills: [
            {
              id: "acme.repo.repo-map",
              name: "repo-map",
              version: "1.4.2",
              relativePath: ".skillcast/skills/repo-map/SKILL.md",
              fileHash: "",
              sourceHash: "",
              installedAt: "2026-03-31T00:00:00.000Z",
              updatedAt: "2026-03-31T00:00:00.000Z",
              ownership: {
                bundle: "repo-onboarding",
                source: "skillcast:acme/repo-onboarding",
                sourceType: "registry"
              }
            }
          ]
        }
      ]
    }, { spaces: 2 });

    await assert.rejects(
      getInstalledBundles(),
      /missing required resolution metadata/
    );
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

function createRemoteArtifact(options: {
  bundleName: string;
  bundleVersion: string;
  skillName: string;
  skillId: string;
  description: string;
  instructions: string;
}): string {
  return JSON.stringify({
    files: [
      {
        path: "bundle.yaml",
        content: [
          `name: ${options.bundleName}`,
          `version: ${options.bundleVersion}`,
          `description: ${options.description}`,
          "skills:",
          `  - name: ${options.skillName}`,
          `    path: ./skills/${options.skillName}`,
          "targets:",
          "  - generic-agent",
          ""
        ].join("\n")
      },
      {
        path: `skills/${options.skillName}/skill.yaml`,
        content: [
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
        ].join("\n")
      },
      {
        path: `skills/${options.skillName}/instructions.md`,
        content: options.instructions
      }
    ]
  });
}

async function startMockRegistry(options: {
  packageName: string;
  version: string;
  artifactBody: string;
  digest?: string;
}): Promise<{
  registryHost: string;
  update: (next: { version?: string; artifactBody?: string; digest?: string }) => void;
  close: () => Promise<void>;
}> {
  const state = {
    version: options.version,
    artifactBody: options.artifactBody,
    digest: options.digest ?? `sha256:${createHash("sha256").update(options.artifactBody, "utf8").digest("hex")}`
  };
  let registryHost = "";

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(500);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === `/v0/resolve/acme/${options.packageName}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        resolution: {
          requestedRef: `skillcast://${registryHost}/acme/${options.packageName}`,
          mode: "floating",
          resolvedVersion: state.version,
          digest: state.digest,
          package: {
            registry: registryHost,
            namespace: "acme",
            name: options.packageName
          },
          resolvedAt: "2026-03-31T00:00:00.000Z",
          artifactUrl: `http://${registryHost}/artifacts/${options.packageName}`
        }
      }));
      return;
    }

    if (url.pathname === `/artifacts/${options.packageName}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(state.artifactBody);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: {
        code: "not_found",
        message: "missing route"
      }
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine mock registry address.");
  }

  registryHost = `127.0.0.1:${address.port}`;

  return {
    registryHost,
    update: (next) => {
      if (next.version) {
        state.version = next.version;
      }
      if (next.artifactBody) {
        state.artifactBody = next.artifactBody;
        state.digest = next.digest ?? `sha256:${createHash("sha256").update(next.artifactBody, "utf8").digest("hex")}`;
      } else if (next.digest) {
        state.digest = next.digest;
      }
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

async function startArtifactServer(options: {
  artifactBody: string;
}): Promise<{
  artifactUrl: string;
  update: (next: { artifactBody: string }) => void;
  close: () => Promise<void>;
}> {
  const state = {
    artifactBody: options.artifactBody
  };
  let artifactUrl = "";

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(500);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/artifact.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(state.artifactBody);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing route");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine artifact server address.");
  }

  artifactUrl = `http://127.0.0.1:${address.port}/artifact.json`;

  return {
    artifactUrl,
    update: (next) => {
      state.artifactBody = next.artifactBody;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function createStoreBundleVersion(options: {
  bundleName: string;
  bundleVersion: string;
  skillName: string;
  skillId: string;
  description: string;
  instructions: string;
}): {
  name: string;
  version: string;
  description: string;
  files: Record<string, string>;
} {
  return {
    name: options.bundleName,
    version: options.bundleVersion,
    description: options.description,
    files: {
      "bundle.yaml": [
        `name: ${options.bundleName}`,
        `version: ${options.bundleVersion}`,
        `description: ${options.description}`,
        "skills:",
        `  - name: ${options.skillName}`,
        `    path: ./skills/${options.skillName}`,
        "targets:",
        "  - generic-agent",
        ""
      ].join("\n"),
      [`skills/${options.skillName}/skill.yaml`]: [
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
      ].join("\n"),
      [`skills/${options.skillName}/instructions.md`]: options.instructions
    }
  };
}

async function startMockBundleStore(options: {
  bundles: Array<{
    name: string;
    version: string;
    description: string;
    files: Record<string, string>;
  }>;
}): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  let baseUrl = "";

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(500);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/catalog.json") {
      const bundles = [...new Set(options.bundles.map((bundle) => bundle.name))]
        .map((name) => {
          const matching = options.bundles
            .filter((bundle) => bundle.name === name)
            .sort((left, right) => left.version.localeCompare(right.version));
          const latest = matching[matching.length - 1];
          return {
            name,
            description: latest.description,
            latestVersion: latest.version,
            versions: matching.map((bundle) => bundle.version)
          };
        });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        catalogVersion: 1,
        bundles
      }));
      return;
    }

    const match = url.pathname.match(/^\/bundles\/([^/]+)\/([^/]+)\/(.+)$/);
    if (match) {
      const [, bundleName, version, relativePath] = match;
      const bundle = options.bundles.find((entry) => entry.name === decodeURIComponent(bundleName) && entry.version === decodeURIComponent(version));
      const file = bundle?.files[decodeURIComponent(relativePath)];
      if (!bundle || file === undefined) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("missing file");
        return;
      }

      res.writeHead(200, { "content-type": relativePath.endsWith(".md") ? "text/markdown" : "text/plain" });
      res.end(file);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing route");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine bundle store address.");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}
