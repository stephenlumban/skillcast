#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Command } from "commander";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const program = new Command();

const inputSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean().optional().default(false)
});

const outputSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1)
});

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  entry: z.object({
    instructions: z.string().min(1)
  }),
  inputs: z.array(inputSchema).default([]),
  outputs: z.array(outputSchema).default([]),
  compatibility: z.object({
    runtimes: z.array(z.string().min(1)).min(1)
  })
});

const bundleSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  skills: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1)
  })).min(1),
  targets: z.array(z.string().min(1)).min(1)
});

type SkillConfig = z.infer<typeof skillSchema>;
type BundleConfig = z.infer<typeof bundleSchema>;

type ValidatedSkill = {
  directory: string;
  config: SkillConfig;
  instructionsPath: string;
};

type ValidatedBundle = {
  rootPath: string;
  bundlePath: string;
  config: BundleConfig;
  skills: ValidatedSkill[];
};

type SourceType = "builtin" | "path" | "store";
type ManifestSourceType = SourceType | "registry" | "url";
type DiffStatus = "new" | "unchanged" | "source-changed" | "local-modified" | "conflict" | "removed" | "missing";

type RemoteBundleArtifact = {
  files: Array<{
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
  }>;
};

type InstalledSkillEntry = {
  id: string;
  name: string;
  version: string;
  relativePath: string;
  fileHash: string;
  sourceHash: string;
  installedAt: string;
  updatedAt: string;
  ownership: {
    bundle: string;
    source: string;
    sourceType: ManifestSourceType;
  };
};

type RegistryResolution = {
  requestedRef: string;
  mode: "floating" | "tag" | "version";
  tag?: string;
  package: {
    registry: string;
    namespace: string;
    name: string;
  };
  resolvedVersion: string;
  digest: string;
  publishedAt?: string;
  artifactUrl: string;
};

type ManifestEntry = {
  bundle: string;
  bundleVersion: string;
  source: string;
  sourceType: ManifestSourceType;
  installedSkills: string[];
  installedAt: string;
  updatedAt: string;
  skillDir: string;
  skills: InstalledSkillEntry[];
  resolution?: RegistryResolution;
};

type ManifestData = {
  manifestVersion: number;
  bundles: ManifestEntry[];
};

type LocalBundleReference = {
  input: string;
  rootPath: string;
  referenceType: "builtin" | "path";
  displaySource: string;
};

type StoreBundleReference = {
  input: string;
  referenceType: "store";
  displaySource: string;
  bundleName: string;
  requestedVersion?: string;
  baseUrl: string;
};

type RegistryBundleReference = {
  input: string;
  referenceType: "registry";
  displaySource: string;
  requestedRef: string;
  registry: string;
  namespace: string;
  bundleName: string;
  selector: {
    mode: "floating" | "tag" | "version";
    value?: string;
  };
};

type UrlBundleReference = {
  input: string;
  referenceType: "url";
  displaySource: string;
  artifactUrl: string;
};

type ResolvedBundleReference = LocalBundleReference | StoreBundleReference | RegistryBundleReference | UrlBundleReference;

type LoadedValidatedBundle = {
  resolved: ResolvedBundleReference;
  bundle: ValidatedBundle;
  resolvedVersion?: string;
  resolvedDigest?: string;
  resolution?: RegistryResolution;
};

type SkillcastConfig = {
  defaultRegistry?: string;
  defaultBundleStoreUrl?: string;
};

type CatalogEntry = {
  name: string;
  path: string;
  description: string;
  category: string;
  tags: string[];
  featured: boolean;
};

type RemoteStoreCatalogEntry = {
  name: string;
  description: string;
  latestVersion: string;
  versions: string[];
};

export type PackListItem = {
  name: string;
  version: string;
  description: string;
  path: string;
  skills: string[];
  category?: string;
  tags?: string[];
  featured?: boolean;
};

export type InspectPayload = {
  name: string;
  version: string;
  description: string;
  source: string;
  resolvedVersion?: string;
  resolvedDigest?: string;
  targets: string[];
  skills: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    path: string;
    instructions: string;
    runtimes: string[];
    inputs: SkillConfig["inputs"];
    outputs: SkillConfig["outputs"];
  }>;
  installedState?: {
    installed: boolean;
    installedAt?: string;
    updatedAt?: string;
    changedSkills: DiffSkillPayload[];
  };
};

export type InstalledListItem = {
  bundle: string;
  bundleVersion: string;
  source: string;
  sourceType: ManifestSourceType;
  installedSkills: string[];
  installedAt: string;
  updatedAt: string;
  skillDir: string;
};

export type InstallResult = {
  action: "installed" | "updated";
  name: string;
  version: string;
  source: string;
  resolvedVersion?: string;
  resolvedDigest?: string;
  skillDir: string;
  manifestPath: string;
  changedSkills: string[];
  removedSkills: string[];
  warnings: string[];
  dryRun: boolean;
  summary: string;
};

export type PublishResult = {
  name: string;
  version: string;
  storeUrl: string;
  bundlePath: string;
  catalogPath: string;
  publishedFiles: string[];
  dryRun: boolean;
  summary: string;
};

export type UnpublishResult = {
  name: string;
  version: string;
  storeUrl: string;
  bundlePath: string;
  catalogPath: string;
  removedBundle: boolean;
  dryRun: boolean;
  summary: string;
};

export type AddSkillResult = {
  bundle: string;
  skill: string;
  bundlePath: string;
  skillPath: string;
  summary: string;
};

export type UninstallResult = {
  removedType: "bundle" | "skill";
  removedTarget: string;
  removedSkills: string[];
  manifestPath?: string;
  message: string;
  warnings: string[];
};

export type DiffSkillPayload = {
  id: string;
  name: string;
  status: DiffStatus;
  path: string;
  details: string;
  ownershipBundle?: string;
};

export type DiffPayload = {
  bundle: string;
  version: string;
  source: string;
  installed: boolean;
  installedAt?: string;
  updatedAt?: string;
  changes: DiffSkillPayload[];
};

type InstallOptions = {
  update?: boolean;
  force?: boolean;
  dryRun?: boolean;
};

type UninstallOptions = {
  dryRun?: boolean;
};

type PublishOptions = {
  storeUrl?: string;
  region?: string;
  dryRun?: boolean;
};

type UnpublishOptions = {
  storeUrl?: string;
  region?: string;
  version?: string;
  dryRun?: boolean;
};

type S3StoreTarget = {
  baseUrl: string;
  bucket: string;
  prefix: string;
  region: string;
};

type BundleStoreClient = {
  getText: (key: string) => Promise<string | null>;
  putText: (key: string, content: string, contentType: string) => Promise<void>;
  exists: (key: string) => Promise<boolean>;
  listKeys: (prefix: string) => Promise<string[]>;
  deleteKeys: (keys: string[]) => Promise<void>;
};

export type RepairResult = {
  manifestPath: string;
  missingSkills: string[];
  orphanedSkills: string[];
  repaired: boolean;
};

const MANIFEST_VERSION = 3;
const builtInCatalogSchema = z.object({
  catalogVersion: z.number().int().positive(),
  packs: z.array(z.object({
    name: z.string().min(1),
    path: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
    featured: z.boolean().default(false)
  }))
});

const remoteStoreCatalogSchema = z.object({
  catalogVersion: z.number().int().positive(),
  bundles: z.array(z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    latestVersion: z.string().min(1),
    versions: z.array(z.string().min(1)).min(1)
  }))
});

const manifestSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).default("unknown"),
  relativePath: z.string().min(1),
  fileHash: z.string().default(""),
  sourceHash: z.string().default(""),
  installedAt: z.string(),
  updatedAt: z.string(),
  ownership: z.object({
    bundle: z.string().min(1),
    source: z.string().min(1),
    sourceType: z.enum(["builtin", "path", "registry", "url", "store"]).default("path")
  })
});

const manifestResolutionSchema = z.object({
  requestedRef: z.string().min(1),
  mode: z.enum(["floating", "tag", "version"]),
  tag: z.string().min(1).optional(),
  package: z.object({
    registry: z.string().min(1),
    namespace: z.string().min(1),
    name: z.string().min(1)
  }),
  resolvedVersion: z.string().min(1),
  digest: z.string().min(1),
  publishedAt: z.string().min(1).optional(),
  artifactUrl: z.string().min(1)
});

const manifestV1Schema = z.object({
  manifestVersion: z.number().int().positive(),
  bundles: z.array(z.object({
    bundle: z.string(),
    bundleVersion: z.string(),
    source: z.string(),
    sourceType: z.enum(["builtin", "path"]).default("path"),
    installedSkills: z.array(z.string()).default([]),
    installedAt: z.string(),
    skillDir: z.string()
  }))
});

const manifestV2Schema = z.object({
  manifestVersion: z.number().int().positive(),
  bundles: z.array(z.object({
    bundle: z.string(),
    bundleVersion: z.string(),
    source: z.string(),
    sourceType: z.enum(["builtin", "path"]).default("path"),
    installedSkills: z.array(z.string()).default([]),
    installedAt: z.string(),
    updatedAt: z.string(),
    skillDir: z.string(),
    skills: z.array(manifestSkillSchema).default([])
  }))
});

const manifestV3Schema = z.object({
  manifestVersion: z.number().int().positive(),
  bundles: z.array(z.object({
    bundle: z.string(),
    bundleVersion: z.string(),
    source: z.string(),
    sourceType: z.enum(["builtin", "path", "registry", "url", "store"]).default("path"),
    installedSkills: z.array(z.string()).default([]),
    installedAt: z.string(),
    updatedAt: z.string(),
    skillDir: z.string(),
    skills: z.array(manifestSkillSchema).default([]),
    resolution: manifestResolutionSchema.optional()
  }))
});

program
  .name("skillcast")
  .description("CLI for reusable agent skill bundles")
  .version("0.1.0");

program
  .command("validate")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .description("Validate a skill bundle")
  .action(async (bundleRef: string) => {
    const payload = await inspectBundle(bundleRef);
    const suffix = payload.resolvedVersion ? ` (resolved ${payload.resolvedVersion})` : "";
    console.log(`Bundle ${payload.name}@${payload.version} is valid.${suffix}`);
    console.log(`Skills: ${payload.skills.map((skill) => skill.name).join(", ")}`);
  });

program
  .command("inspect")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .option("--json", "output machine-readable JSON")
  .option("--installed", "include installed state and diff against the local install")
  .description("Inspect a skill bundle")
  .action(async (bundleRef: string, options: { json?: boolean; installed?: boolean }) => {
    const payload = await inspectBundle(bundleRef, { installed: options.installed });

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`${payload.name}@${payload.version}`);
    console.log(payload.description);
    console.log(`Source: ${payload.source}`);
    if (payload.resolvedVersion) {
      console.log(`Resolved Version: ${payload.resolvedVersion}`);
    }
    if (payload.resolvedDigest) {
      console.log(`Resolved Digest: ${payload.resolvedDigest}`);
    }
    console.log(`Targets: ${payload.targets.join(", ")}`);
    console.log("Skills:");
    for (const skill of payload.skills) {
      console.log(`- ${skill.name} (${skill.id})`);
      console.log(`  Version: ${skill.version}`);
      console.log(`  Path: ${skill.path}`);
      console.log(`  Instructions: ${skill.instructions}`);
    }

    if (payload.installedState) {
      console.log(`Installed: ${payload.installedState.installed ? "yes" : "no"}`);
      if (payload.installedState.installedAt) {
        console.log(`Installed At: ${payload.installedState.installedAt}`);
      }
      if (payload.installedState.updatedAt) {
        console.log(`Updated At: ${payload.installedState.updatedAt}`);
      }
      if (payload.installedState.changedSkills.length > 0) {
        console.log("Installed State:");
        for (const change of payload.installedState.changedSkills) {
          console.log(`- ${change.name}: ${change.status}`);
          console.log(`  Path: ${change.path}`);
          console.log(`  Details: ${change.details}`);
        }
      }
    }
  });

program
  .command("diff")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .option("--json", "output machine-readable JSON")
  .description("Compare a bundle source to the locally installed version")
  .action(async (bundleRef: string, options: { json?: boolean }) => {
    const payload = await diffBundle(bundleRef);

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`${payload.bundle}@${payload.version}`);
    console.log(`Source: ${payload.source}`);
    console.log(`Installed: ${payload.installed ? "yes" : "no"}`);
    if (payload.installedAt) {
      console.log(`Installed At: ${payload.installedAt}`);
    }
    if (payload.updatedAt) {
      console.log(`Updated At: ${payload.updatedAt}`);
    }

    if (payload.changes.length === 0) {
      console.log("No changes detected.");
      return;
    }

    for (const change of payload.changes) {
      console.log(`- ${change.name}: ${change.status}`);
      console.log(`  Path: ${change.path}`);
      console.log(`  Details: ${change.details}`);
    }
  });

program
  .command("install")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .option("--update", "refresh an existing installation from source")
  .option("--force", "allow explicit overwrites for collisions or locally modified skills")
  .option("--dry-run", "report changes without writing files")
  .option("--verbose", "show detailed install output")
  .description("Install a bundle into the current repository")
  .action(async (bundleRef: string, options: InstallOptions & { verbose?: boolean }) => {
    const result = await installBundle(bundleRef, options);
    console.log(result.summary);
    if (options.verbose) {
      console.log(`Source: ${result.source}`);
      if (result.resolvedVersion) {
        console.log(`Resolved Version: ${result.resolvedVersion}`);
      }
      if (result.resolvedDigest) {
        console.log(`Resolved Digest: ${result.resolvedDigest}`);
      }
      console.log(`Skill Dir: ${result.skillDir}`);
      console.log(`Manifest: ${result.manifestPath}`);
      if (result.changedSkills.length > 0) {
        console.log(`Changed Skills: ${result.changedSkills.join(", ")}`);
      }
      if (result.removedSkills.length > 0) {
        console.log(`Removed Skills: ${result.removedSkills.join(", ")}`);
      }
    }
    for (const warning of result.warnings) {
      console.log(`Warning: ${warning}`);
    }
  });

program
  .command("publish")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .option("--store-url <url>", "S3-backed bundle store base URL to publish into")
  .option("--region <region>", "AWS region override for the S3 bucket")
  .option("--dry-run", "report publish changes without writing files")
  .option("--verbose", "show detailed publish output")
  .description("Publish a bundle directly into an S3-backed bundle store")
  .action(async (bundleRef: string, options: PublishOptions & { verbose?: boolean }) => {
    const result = await publishBundle(bundleRef, options);
    console.log(result.summary);
    if (options.verbose) {
      console.log(`Store URL: ${result.storeUrl}`);
      console.log(`Bundle Path: ${result.bundlePath}`);
      console.log(`Catalog: ${result.catalogPath}`);
      console.log(`Published Files: ${result.publishedFiles.join(", ")}`);
    }
  });

program
  .command("unpublish")
  .argument("<bundleRefOrName>", "local bundle path, built-in pack name, or bundle name")
  .option("--version <version>", "exact bundle version to remove when passing a bundle name")
  .option("--store-url <url>", "S3-backed bundle store base URL to remove from")
  .option("--region <region>", "AWS region override for the S3 bucket")
  .option("--dry-run", "report unpublish changes without writing files")
  .description("Remove a published bundle version from an S3-backed bundle store")
  .action(async (bundleRefOrName: string, options: UnpublishOptions) => {
    const result = await unpublishBundle(bundleRefOrName, options);
    console.log(result.summary);
  });

program
  .command("uninstall")
  .argument("[bundleOrSkill]", "installed bundle name, skill name, or skill id")
  .option("--all", "remove all installed bundles and clean the .skillcast directory")
  .option("--dry-run", "report removals without deleting files or changing the manifest")
  .description("Uninstall an installed bundle or single skill from the current repository")
  .action(async (bundleOrSkill: string | undefined, options: { all?: boolean; dryRun?: boolean }) => {
    if (options.all && bundleOrSkill) {
      throw new Error("Use either '<bundleOrSkill>' or '--all', not both.");
    }
    if (!options.all && !bundleOrSkill) {
      throw new Error("Missing uninstall target. Provide '<bundleOrSkill>' or use '--all'.");
    }

    const result = options.all
      ? await uninstallAll({ dryRun: options.dryRun })
      : await uninstallBundleOrSkill(bundleOrSkill!, { dryRun: options.dryRun });
    console.log(result.message);
    console.log(`Removed Skills: ${result.removedSkills.join(", ")}`);
    if (result.manifestPath) {
      console.log(`Manifest: ${result.manifestPath}`);
    }
    for (const warning of result.warnings) {
      console.log(`Warning: ${warning}`);
    }
  });

program
  .command("repair")
  .option("--write", "apply safe manifest repairs for missing installed skills")
  .option("--json", "output machine-readable JSON")
  .description("Inspect .skillcast state and repair missing manifest entries")
  .action(async (options: { write?: boolean; json?: boolean }) => {
    const result = await repairInstallState({ write: options.write });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(result.repaired ? "Repaired .skillcast state." : "Checked .skillcast state.");
    console.log(`Manifest: ${result.manifestPath}`);
    if (result.missingSkills.length === 0) {
      console.log("Missing Skills: none");
    } else {
      console.log(`Missing Skills: ${result.missingSkills.join(", ")}`);
    }
    if (result.orphanedSkills.length === 0) {
      console.log("Orphaned Skills: none");
    } else {
      console.log(`Orphaned Skills: ${result.orphanedSkills.join(", ")}`);
    }
  });

program
  .command("init")
  .argument("[targetDir]", "directory to scaffold", ".")
  .description("Scaffold a new bundle")
  .action(async (targetDir: string) => {
    const resolvedTarget = path.resolve(process.cwd(), targetDir);
    await initBundleScaffold(resolvedTarget);
    console.log(`Initialized bundle scaffold at ${resolvedTarget}`);
  });

program
  .command("add-skill")
  .argument("<bundlePath>", "existing bundle root directory")
  .argument("<skillName>", "skill folder and skill name to add")
  .description("Add a new skill scaffold into an existing bundle")
  .action(async (bundlePath: string, skillName: string) => {
    const result = await addSkillToBundle(bundlePath, skillName);
    console.log(result.summary);
  });

program
  .command("help")
  .argument("[commandName]", "optional command name")
  .description("Show help for Skillcast or a specific command")
  .action((commandName?: string) => {
    if (!commandName) {
      program.outputHelp();
      return;
    }

    const command = program.commands.find((entry) => entry.name() === commandName || entry.aliases().includes(commandName));
    if (!command) {
      throw new Error(`Unknown command '${commandName}'.`);
    }

    command.outputHelp();
  });

async function validateBundleRoot(rootPath: string): Promise<ValidatedBundle> {
  const bundlePath = path.join(rootPath, "bundle.yaml");

  if (!(await fs.pathExists(rootPath))) {
    throw new Error(`Bundle path does not exist: ${rootPath}`);
  }

  if (!(await fs.pathExists(bundlePath))) {
    throw new Error(`Missing bundle.yaml in ${rootPath}`);
  }

  const bundleDocument = YAML.parse(await fs.readFile(bundlePath, "utf8"));
  const config = bundleSchema.parse(bundleDocument);
  const skills: ValidatedSkill[] = [];

  for (const skillRef of config.skills) {
    const skillDirectory = path.resolve(rootPath, skillRef.path);
    const skillYamlPath = path.join(skillDirectory, "skill.yaml");

    if (!(await fs.pathExists(skillDirectory))) {
      throw new Error(`Missing skill directory for ${skillRef.name}: ${skillDirectory}`);
    }

    if (!(await fs.pathExists(skillYamlPath))) {
      throw new Error(`Missing skill.yaml for ${skillRef.name}: ${skillYamlPath}`);
    }

    const skillDocument = YAML.parse(await fs.readFile(skillYamlPath, "utf8"));
    const skillConfig = skillSchema.parse(skillDocument);
    const instructionsPath = path.resolve(skillDirectory, skillConfig.entry.instructions);

    if (!(await fs.pathExists(instructionsPath))) {
      throw new Error(`Missing instructions for ${skillConfig.name}: ${instructionsPath}`);
    }

    if (skillConfig.name !== skillRef.name) {
      throw new Error(
        `Skill name mismatch for ${skillRef.name}: bundle.yaml references ${skillRef.name} but skill.yaml says ${skillConfig.name}`
      );
    }

    skills.push({
      directory: skillDirectory,
      config: skillConfig,
      instructionsPath
    });
  }

  for (const target of config.targets) {
    for (const skill of skills) {
      if (!skill.config.compatibility.runtimes.includes(target)) {
        throw new Error(`Skill ${skill.config.name} does not support target ${target}`);
      }
    }
  }

  ensureUniqueSkillIdentity(skills, rootPath);

  return {
    rootPath,
    bundlePath,
    config,
    skills
  };
}

async function readManifest(manifestPath: string): Promise<ManifestData> {
  if (!(await fs.pathExists(manifestPath))) {
    return {
      manifestVersion: MANIFEST_VERSION,
      bundles: []
    };
  }

  const raw = await fs.readJson(manifestPath);

  if (raw?.manifestVersion === 1) {
    const manifest = manifestV1Schema.parse(raw);
    const bundles: ManifestEntry[] = [];

    for (const entry of manifest.bundles) {
      const normalizedSource = normalizeSourceDisplay(entry.source, entry.sourceType);
      const installedSkills = uniqueSkillNames(entry.installedSkills);
      const skills: InstalledSkillEntry[] = [];

      for (const skillName of installedSkills) {
        const relativePath = toPosix(path.join(entry.skillDir, skillName, "SKILL.md"));
        const fileHash = await hashPathIfExists(path.resolve(process.cwd(), relativePath));
        skills.push({
          id: skillName,
          name: skillName,
          version: entry.bundleVersion,
          relativePath,
          fileHash: fileHash ?? "",
          sourceHash: fileHash ?? "",
          installedAt: entry.installedAt,
          updatedAt: entry.installedAt,
          ownership: {
            bundle: entry.bundle,
            source: normalizedSource,
            sourceType: entry.sourceType
          }
        });
      }

      bundles.push(normalizeManifestEntry({
        bundle: entry.bundle,
        bundleVersion: entry.bundleVersion,
        source: normalizedSource,
        sourceType: entry.sourceType,
        installedSkills,
        installedAt: entry.installedAt,
        updatedAt: entry.installedAt,
        skillDir: entry.skillDir,
        skills
      }));
    }

    return {
      manifestVersion: MANIFEST_VERSION,
      bundles: sortManifestEntries(bundles)
    };
  }

  if (raw?.manifestVersion === 2) {
    const manifest = manifestV2Schema.parse(raw);

    return {
      manifestVersion: MANIFEST_VERSION,
      bundles: sortManifestEntries(manifest.bundles.map((entry) => normalizeManifestEntry({
        ...entry,
        source: normalizeSourceDisplay(entry.source, entry.sourceType)
      })))
    };
  }

  const manifest = manifestV3Schema.parse(raw);

  return {
    manifestVersion: MANIFEST_VERSION,
    bundles: sortManifestEntries(manifest.bundles.map((entry) => normalizeManifestEntry({
      ...entry,
      source: normalizeSourceDisplay(entry.source, entry.sourceType)
    })))
  };
}

async function initBundleScaffold(targetDir: string): Promise<void> {
  const bundleName = path.basename(targetDir);
  const skillName = "example-skill";
  const skillDir = path.join(targetDir, "skills", skillName);

  await fs.ensureDir(skillDir);
  await fs.writeFile(path.join(targetDir, "bundle.yaml"), renderBundleYaml({
    name: bundleName,
    version: "0.1.0",
    description: "Describe this bundle",
    skills: [{ name: skillName, path: `./skills/${skillName}` }],
    targets: ["generic-agent"]
  }), "utf8");
  await fs.writeFile(path.join(skillDir, "skill.yaml"), renderSkillYaml({
    skillId: buildDefaultSkillId(bundleName, skillName),
    skillName,
    skillVersion: "0.1.0",
    description: "Describe this skill",
    runtimes: ["generic-agent"]
  }), "utf8");
  await fs.writeFile(path.join(skillDir, "instructions.md"), defaultSkillInstructions(), "utf8");
}

export async function addSkillToBundle(bundlePath: string, skillName: string): Promise<AddSkillResult> {
  const resolvedBundlePath = path.resolve(process.cwd(), bundlePath);
  const bundle = await validateBundleRoot(resolvedBundlePath);
  const normalizedSkillName = skillName.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalizedSkillName)) {
    throw new Error(`Invalid skill name '${skillName}'. Use letters, numbers, dots, dashes, or underscores.`);
  }

  if (bundle.skills.some((skill) => skill.config.name === normalizedSkillName)) {
    throw new Error(`Bundle '${bundle.config.name}' already contains a skill named '${normalizedSkillName}'.`);
  }

  const skillDir = path.join(resolvedBundlePath, "skills", normalizedSkillName);
  if (await fs.pathExists(skillDir)) {
    throw new Error(`Skill directory already exists: ${toDisplayPath(skillDir)}`);
  }

  const nextBundleConfig: BundleConfig = {
    ...bundle.config,
    skills: [
      ...bundle.config.skills,
      {
        name: normalizedSkillName,
        path: `./skills/${normalizedSkillName}`
      }
    ]
  };

  await fs.ensureDir(skillDir);
  await fs.writeFile(bundle.bundlePath, renderBundleYaml(nextBundleConfig), "utf8");
  await fs.writeFile(path.join(skillDir, "skill.yaml"), renderSkillYaml({
    skillId: buildDefaultSkillId(bundle.config.name, normalizedSkillName),
    skillName: normalizedSkillName,
    skillVersion: bundle.config.version,
    description: `Describe the ${normalizedSkillName} skill`,
    runtimes: bundle.config.targets
  }), "utf8");
  await fs.writeFile(path.join(skillDir, "instructions.md"), defaultSkillInstructions(), "utf8");

  return {
    bundle: bundle.config.name,
    skill: normalizedSkillName,
    bundlePath: toPosix(path.relative(process.cwd(), bundle.bundlePath)),
    skillPath: toPosix(path.relative(process.cwd(), skillDir)),
    summary: `Added skill '${normalizedSkillName}' to bundle '${bundle.config.name}'.`
  };
}

async function writeManifest(manifestPath: string, manifest: ManifestData): Promise<void> {
  if (manifest.bundles.length === 0) {
    await cleanupSkillcastDirectory(path.dirname(manifestPath));
    return;
  }

  await writeJsonFileAtomic(manifestPath, {
    manifestVersion: MANIFEST_VERSION,
    bundles: sortManifestEntries(manifest.bundles.map(normalizeManifestEntry))
  });
}

async function writeJsonFileAtomic(targetPath: string, value: unknown): Promise<void> {
  const targetDir = path.dirname(targetPath);
  const tmpPath = path.join(targetDir, `${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.ensureDir(targetDir);
  await fs.writeJson(tmpPath, value, { spaces: 2 });
  await fs.move(tmpPath, targetPath, { overwrite: true });
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[-+]/)[0].split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(/[-+]/)[0].split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return left.localeCompare(right);
}

function renderBundleYaml(config: {
  name: string;
  version: string;
  description: string;
  skills: Array<{ name: string; path: string }>;
  targets: string[];
}): string {
  return YAML.stringify({
    name: config.name,
    version: config.version,
    description: config.description,
    skills: config.skills,
    targets: config.targets
  });
}

function renderSkillYaml(options: {
  skillId: string;
  skillName: string;
  skillVersion: string;
  description: string;
  runtimes: string[];
}): string {
  return YAML.stringify({
    id: options.skillId,
    name: options.skillName,
    version: options.skillVersion,
    description: options.description,
    entry: {
      instructions: "./instructions.md"
    },
    inputs: [
      {
        name: "input",
        type: "string",
        required: true
      }
    ],
    outputs: [
      {
        name: "result",
        type: "string"
      }
    ],
    compatibility: {
      runtimes: options.runtimes
    }
  });
}

function defaultSkillInstructions(): string {
  return [
    "You are a reusable skill.",
    "",
    "Define the behavior, constraints, and output contract here."
  ].join("\n");
}

function buildDefaultSkillId(bundleName: string, skillName: string): string {
  return `org.example.${normalizeIdentifierSegment(bundleName)}.${normalizeIdentifierSegment(skillName)}`;
}

function normalizeIdentifierSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "skill";
}

async function findBundles(searchPathInput: string): Promise<ValidatedBundle[]> {
  const searchRoot = path.resolve(process.cwd(), searchPathInput);

  if (!(await fs.pathExists(searchRoot))) {
    throw new Error(`Search path does not exist: ${searchRoot}`);
  }

  const bundleRoots = await collectBundleRoots(searchRoot);
  const bundles: ValidatedBundle[] = [];

  for (const bundleRoot of bundleRoots) {
    bundles.push(await validateBundleRoot(bundleRoot));
  }

  bundles.sort((left, right) => left.config.name.localeCompare(right.config.name));
  return bundles;
}

async function collectBundleRoots(searchRoot: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(searchRoot, { withFileTypes: true });
  const hasBundleYaml = entries.some((entry) => entry.isFile() && entry.name === "bundle.yaml");

  if (hasBundleYaml) {
    results.push(searchRoot);
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".skillcast") {
      continue;
    }

    const childPath = path.join(searchRoot, entry.name);
    results.push(...await collectBundleRoots(childPath));
  }

  return results;
}

async function resolvePackSearchPath(searchPathInput?: string): Promise<string> {
  if (searchPathInput) {
    return path.resolve(process.cwd(), searchPathInput);
  }

  const packageBuiltinPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "builtin");
  if (await fs.pathExists(packageBuiltinPath)) {
    return packageBuiltinPath;
  }

  const repoBuiltinPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/bundles");
  if (await fs.pathExists(repoBuiltinPath)) {
    return repoBuiltinPath;
  }

  return process.cwd();
}

function toDisplayPath(targetPath: string): string {
  const relative = path.relative(process.cwd(), targetPath);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return toPosix(relative || ".");
  }

  return toPosix(targetPath);
}

async function run(): Promise<void> {
  if (process.argv[2] === "list") {
    await handleListCommand(process.argv.slice(3));
    return;
  }

  await program.parseAsync(process.argv);
}

async function handleListCommand(args: string[]): Promise<void> {
  const subject = args.find((arg) => !arg.startsWith("-"));
  const positional = args.filter((arg) => !arg.startsWith("-"));
  const json = args.includes("--json");
  const verbose = args.includes("--verbose");

  if (!subject) {
    throw new Error("Missing list subject. Use 'packs' or 'skills'.");
  }

  if (subject === "packs") {
    const pathArg = positional[1];
    const resolvedSearchPath = await resolvePackSearchPath(pathArg);
    const payload = await getPackList(pathArg);

    if (json) {
      console.log(JSON.stringify({
        source: toDisplayPath(resolvedSearchPath),
        packs: payload
      }, null, 2));
      return;
    }

    if (payload.length === 0) {
      console.log(`No bundles found in ${toDisplayPath(resolvedSearchPath)}.`);
      return;
    }

    console.log(`Source: ${toDisplayPath(resolvedSearchPath)}`);
    for (const bundle of payload) {
      console.log(`${bundle.name}@${bundle.version}`);
      if (verbose) {
        console.log(`  Path: ${bundle.path || "."}`);
      }
      console.log(`  Skills: ${bundle.skills.join(", ")}`);
      console.log(`  Description: ${bundle.description}`);
    }
    return;
  }

  if (subject === "installed") {
    const manifestPath = path.join(process.cwd(), ".skillcast", "manifest.json");
    const payload = await getInstalledBundles();

    if (json) {
      console.log(JSON.stringify({
        manifest: toDisplayPath(manifestPath),
        bundles: payload
      }, null, 2));
      return;
    }

    if (payload.length === 0) {
      console.log("No installed bundles found.");
      return;
    }

    console.log(`Manifest: ${toDisplayPath(manifestPath)}`);
    for (const bundle of payload) {
      if (verbose) {
        console.log(`${bundle.bundle}@${bundle.bundleVersion}`);
        console.log(`  Installed: ${bundle.installedAt}`);
        console.log(`  Updated: ${bundle.updatedAt}`);
        console.log(`  Source: ${bundle.source} (${bundle.sourceType})`);
        console.log(`  Skill Dir: ${bundle.skillDir}`);
        console.log(`  Skills: ${bundle.installedSkills.join(", ")}`);
        continue;
      }

      console.log(`${bundle.bundle}@${bundle.bundleVersion} (${bundle.installedSkills.length} skills)`);
    }
    return;
  }

  if (subject === "skills") {
    const installed = args.includes("-i") || args.includes("--installed");
    const pathArg = positional[1];

    if (installed) {
      if (pathArg) {
        throw new Error("Use either 'list skills <bundleRef>' or 'list skills --installed', not both.");
      }

      const payload = await getInstalledSkills();

      if (json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (payload.length === 0) {
        console.log("No installed skills found.");
        return;
      }

      for (const skill of payload) {
        console.log(`${skill.name} (${skill.id})`);
        if (verbose) {
          console.log(`  Bundle: ${skill.bundle}`);
          console.log(`  Version: ${skill.version}`);
          console.log(`  Path: ${skill.path}`);
        }
      }
      return;
    }

    if (!pathArg) {
      throw new Error("Bundle reference is required for 'list skills'. Example: 'cast list skills repo-onboarding-pack'.");
    }

    const payload = await listBundleSkills(pathArg);

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`${payload.bundle}@${payload.version}`);
    console.log(`Source: ${payload.source}`);
    for (const skill of payload.skills) {
      console.log(`- ${skill.name} (${skill.id})`);
      console.log(`  Version: ${skill.version}`);
      if (verbose) {
        console.log(`  Path: ${skill.path}`);
      }
      console.log(`  Description: ${skill.description}`);
    }
    return;
  }

  throw new Error(`Unknown list subject '${subject}'. Use 'packs', 'skills', or 'installed'.`);
}

async function resolveAndValidateBundle(bundleRef: string): Promise<ValidatedBundle> {
  const resolved = await resolveBundleReference(bundleRef);
  assertLocalBundleReference(resolved);
  return validateBundleRoot(resolved.rootPath);
}

async function withResolvedValidatedBundle<T>(
  bundleRef: string,
  task: (loaded: LoadedValidatedBundle) => Promise<T>
): Promise<T> {
  const resolved = await resolveBundleReference(bundleRef);
  if (resolved.referenceType === "builtin" || resolved.referenceType === "path") {
    const bundle = await validateBundleRoot(resolved.rootPath);
    return task({ resolved, bundle });
  }

  if (resolved.referenceType === "store") {
    const storeResolution = await resolveStoreBundle(resolved);
    return withMaterializedStoreBundle(storeResolution, async (bundleRoot) => {
      const bundle = await validateBundleRoot(bundleRoot);
      if (bundle.config.version !== storeResolution.resolvedVersion) {
        throw new Error(
          `Resolved store version '${storeResolution.resolvedVersion}' does not match bundle version '${bundle.config.version}' for '${resolved.displaySource}'.`
        );
      }

      return task({
        resolved,
        bundle,
        resolvedVersion: storeResolution.resolvedVersion
      });
    });
  }

  if (resolved.referenceType === "registry") {
    const resolution = await resolveRegistryBundle(resolved);
    return withMaterializedArtifactBundle(
      resolution.requestedRef,
      resolution.artifactUrl,
      async (bundleRoot) => {
        const bundle = await validateBundleRoot(bundleRoot);
        if (bundle.config.version !== resolution.resolvedVersion) {
          throw new Error(
            `Resolved registry version '${resolution.resolvedVersion}' does not match bundle version '${bundle.config.version}' for '${resolved.displaySource}'.`
          );
        }

        return task({
          resolved,
          bundle,
          resolvedVersion: resolution.resolvedVersion,
          resolvedDigest: resolution.digest,
          resolution
        });
      },
      {
        expectedDigest: resolution.digest,
        cacheDigest: resolution.digest
      }
    );
  }

  if (resolved.referenceType === "url") {
    return withMaterializedArtifactBundle(
      resolved.displaySource,
      resolved.artifactUrl,
      async (bundleRoot) => {
        const bundle = await validateBundleRoot(bundleRoot);
        return task({ resolved, bundle });
      }
    );
  }

  throw new Error(`Unsupported bundle reference: ${bundleRef}`);
}

async function resolveBundleReference(bundleRef: string): Promise<ResolvedBundleReference> {
  const explicitRoot = path.resolve(process.cwd(), bundleRef);
  if (await fs.pathExists(path.join(explicitRoot, "bundle.yaml"))) {
    return {
      input: bundleRef,
      rootPath: explicitRoot,
      referenceType: "path",
      displaySource: toDisplayPath(explicitRoot)
    };
  }

  const remoteRef = parseResolvedRemoteBundleReference(bundleRef);
  if (remoteRef) {
    return remoteRef;
  }

  if (/^https?:\/\//.test(bundleRef)) {
    return {
      input: bundleRef,
      referenceType: "url",
      displaySource: bundleRef,
      artifactUrl: bundleRef
    };
  }

  const storeRef = parseDefaultStoreBundleReference(bundleRef);
  if (storeRef) {
    return storeRef;
  }

  const builtInRoot = await resolvePackSearchPath();
  const catalog = await readBuiltInCatalog(builtInRoot);
  const catalogMatch = catalog.find((entry) => entry.name === bundleRef);

  if (catalogMatch) {
    return {
      input: bundleRef,
      rootPath: path.resolve(builtInRoot, catalogMatch.path),
      referenceType: "builtin",
      displaySource: bundleRef
    };
  }

  throw new Error(
    `Bundle '${bundleRef}' was not found as a local bundle path, configured bundle store entry, or built-in pack.`
  );
}

function assertLocalBundleReference(reference: ResolvedBundleReference): asserts reference is LocalBundleReference {
  if (reference.referenceType !== "builtin" && reference.referenceType !== "path") {
    throw new Error(
      `Remote bundle references are not supported by this local-only code path: ${reference.displaySource}`
    );
  }
}

function parseDefaultStoreBundleReference(input: string): StoreBundleReference | null {
  const baseUrl = getDefaultBundleStoreBaseUrl();
  if (!baseUrl) {
    return null;
  }

  const match = parseBundleNameAndOptionalVersion(input);
  if (!match) {
    return null;
  }

  return {
    input,
    referenceType: "store",
    displaySource: input,
    bundleName: match.name,
    requestedVersion: match.version,
    baseUrl
  };
}

function parseBundleNameAndOptionalVersion(input: string): { name: string; version?: string } | null {
  const match = input.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?))?$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1],
    version: match[2]
  };
}

function parseBundleNameAndVersion(input: string): { name: string; version: string } | null {
  const parsed = parseBundleNameAndOptionalVersion(input);
  if (!parsed?.version) {
    return null;
  }

  return {
    name: parsed.name,
    version: parsed.version
  };
}

export function parseRemoteBundleReference(_input: string): null {
  return null;
}

function parseResolvedRemoteBundleReference(input: string): RegistryBundleReference | null {
  let registry = "default";
  let namespace = "";
  let bundleName = "";
  let selectorValue: string | undefined;

  const explicitMatch = input.match(/^skillcast:\/\/([^/]+)\/([^/]+)\/([^@/]+)(?:@(.+))?$/);
  if (explicitMatch) {
    [, registry, namespace, bundleName, selectorValue] = explicitMatch;
  } else {
    const implicitMatch = input.match(/^skillcast:([^/]+)\/([^@/]+)(?:@(.+))?$/);
    if (!implicitMatch) {
      return null;
    }
    [, namespace, bundleName, selectorValue] = implicitMatch;
  }

  const selector = !selectorValue
    ? { mode: "floating" as const }
    : isExactVersionSelector(selectorValue)
      ? { mode: "version" as const, value: selectorValue }
      : { mode: "tag" as const, value: selectorValue };

  return {
    input,
    referenceType: "registry",
    displaySource: input,
    requestedRef: input,
    registry,
    namespace,
    bundleName,
    selector
  };
}

function isExactVersionSelector(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

async function resolveRegistryBundle(reference: RegistryBundleReference): Promise<RegistryResolution> {
  const baseUrl = getRegistryBaseUrl(reference.registry);
  const url = new URL(`${baseUrl}/v0/resolve/${encodeURIComponent(reference.namespace)}/${encodeURIComponent(reference.bundleName)}`);
  if (reference.selector.mode === "version" && reference.selector.value) {
    url.searchParams.set("version", reference.selector.value);
  } else if (reference.selector.mode === "tag" && reference.selector.value) {
    url.searchParams.set("tag", reference.selector.value);
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(await buildRegistryError(response, reference.requestedRef));
  }

  const payload = z.object({
    resolution: manifestResolutionSchema
  }).parse(await response.json());

  return payload.resolution;
}

async function resolveStoreBundle(reference: StoreBundleReference): Promise<{
  bundleName: string;
  requestedRef: string;
  resolvedVersion: string;
  rootUrl: string;
}> {
  const catalog = await fetchRemoteStoreCatalog(reference.baseUrl);
  const bundle = catalog.find((entry) => entry.name === reference.bundleName);
  if (!bundle) {
    throw new Error(`Bundle '${reference.bundleName}' was not found in the default bundle store.`);
  }

  const resolvedVersion = reference.requestedVersion ?? bundle.latestVersion;
  if (!bundle.versions.includes(resolvedVersion)) {
    throw new Error(
      `Version '${resolvedVersion}' was not found for bundle '${reference.bundleName}' in the default bundle store.`
    );
  }

  return {
    bundleName: reference.bundleName,
    requestedRef: reference.displaySource,
    resolvedVersion,
    rootUrl: `${reference.baseUrl}/bundles/${encodeURIComponent(reference.bundleName)}/${encodeURIComponent(resolvedVersion)}`
  };
}

async function withMaterializedStoreBundle<T>(
  resolution: {
    bundleName: string;
    requestedRef: string;
    resolvedVersion: string;
    rootUrl: string;
  },
  task: (bundleRoot: string) => Promise<T>
): Promise<T> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillcast-store-"));

  try {
    await materializeStoreBundleFiles(tempRoot, resolution);
    return await task(tempRoot);
  } finally {
    await fs.remove(tempRoot);
  }
}

async function withMaterializedArtifactBundle<T>(
  requestedRef: string,
  artifactUrl: string,
  task: (bundleRoot: string) => Promise<T>,
  options: {
    expectedDigest?: string;
    cacheDigest?: string;
  } = {}
): Promise<T> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillcast-remote-"));

  try {
    const artifactBuffer = await fetchArtifactBytes(requestedRef, artifactUrl, options.cacheDigest);
    if (options.expectedDigest) {
      verifyArtifactDigest(artifactBuffer, options.expectedDigest, requestedRef);
    }
    const artifact = z.object({
      files: z.array(z.object({
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional()
      })).min(1)
    }).parse(JSON.parse(artifactBuffer.toString("utf8"))) as RemoteBundleArtifact;

    await writeArtifactFiles(tempRoot, artifact);
    return await task(tempRoot);
  } finally {
    await fs.remove(tempRoot);
  }
}

async function fetchArtifactBytes(requestedRef: string, artifactUrl: string, cacheDigest?: string): Promise<Buffer> {
  if (cacheDigest) {
    const cachePath = getArtifactCachePath(cacheDigest);
    if (await fs.pathExists(cachePath)) {
      return fs.readFile(cachePath);
    }
  }

  const response = await fetch(artifactUrl, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(await buildArtifactFetchError(response, requestedRef));
  }

  const artifactBuffer = Buffer.from(await response.arrayBuffer());
  if (cacheDigest) {
    const cachePath = getArtifactCachePath(cacheDigest);
    await fs.ensureDir(path.dirname(cachePath));
    await fs.writeFile(cachePath, artifactBuffer);
  }
  return artifactBuffer;
}

async function writeArtifactFiles(rootPath: string, artifact: RemoteBundleArtifact): Promise<void> {
  for (const file of artifact.files) {
    const relativePath = toPosix(file.path);
    const pathSegments = relativePath.split("/").filter(Boolean);
    if (relativePath.startsWith("/") || pathSegments.includes("..")) {
      throw new Error(`Registry artifact contains invalid file path '${file.path}'.`);
    }

    const targetPath = path.resolve(rootPath, relativePath);
    if (!isPathWithin(targetPath, rootPath)) {
      throw new Error(`Registry artifact contains path outside bundle root: '${file.path}'.`);
    }

    await fs.ensureDir(path.dirname(targetPath));
    const content = file.encoding === "base64"
      ? Buffer.from(file.content, "base64")
      : file.content;
    await fs.writeFile(targetPath, content);
  }
}

async function materializeStoreBundleFiles(
  rootPath: string,
  resolution: {
    bundleName: string;
    requestedRef: string;
    resolvedVersion: string;
    rootUrl: string;
  }
): Promise<void> {
  const bundleYaml = await fetchRemoteText(
    `${resolution.rootUrl}/bundle.yaml`,
    resolution.requestedRef
  );
  await fs.writeFile(path.join(rootPath, "bundle.yaml"), bundleYaml, "utf8");

  const bundleDocument = bundleSchema.parse(YAML.parse(bundleYaml));
  for (const skillRef of bundleDocument.skills) {
    const skillDir = path.posix.normalize(skillRef.path.replace(/^\.\//, ""));
    const skillYamlRelativePath = `${skillDir}/skill.yaml`;
    const skillYaml = await fetchRemoteText(`${resolution.rootUrl}/${skillYamlRelativePath}`, resolution.requestedRef);
    const skillDocument = skillSchema.parse(YAML.parse(skillYaml));
    const instructionsRelativePath = path.posix.normalize(path.posix.join(skillDir, skillDocument.entry.instructions));
    const instructions = await fetchRemoteText(`${resolution.rootUrl}/${instructionsRelativePath}`, resolution.requestedRef);

    await ensureSafeRemoteWrite(rootPath, skillYamlRelativePath, skillYaml);
    await ensureSafeRemoteWrite(rootPath, instructionsRelativePath, instructions);
  }
}

async function ensureSafeRemoteWrite(rootPath: string, relativePath: string, content: string): Promise<void> {
  const normalizedRelativePath = toPosix(relativePath);
  const pathSegments = normalizedRelativePath.split("/").filter(Boolean);
  if (normalizedRelativePath.startsWith("/") || pathSegments.includes("..")) {
    throw new Error(`Remote bundle contains invalid file path '${relativePath}'.`);
  }

  const targetPath = path.resolve(rootPath, normalizedRelativePath);
  if (!isPathWithin(targetPath, rootPath)) {
    throw new Error(`Remote bundle contains path outside bundle root: '${relativePath}'.`);
  }

  await fs.ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, "utf8");
}

async function fetchRemoteText(url: string, requestedRef: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/plain, application/x-yaml, text/yaml, text/markdown, application/json"
    }
  });

  if (!response.ok) {
    throw new Error(await buildArtifactFetchError(response, requestedRef));
  }

  return response.text();
}

function verifyArtifactDigest(bytes: Buffer, digest: string, requestedRef: string): void {
  const expected = normalizeDigest(digest);
  const actual = createHash("sha256").update(bytes).digest("hex");

  if (expected !== actual) {
    throw new Error(`Digest mismatch for remote bundle '${requestedRef}'.`);
  }
}

function normalizeDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

function getRegistryBaseUrl(registry: string): string {
  if (registry === "default") {
    return process.env.SKILLCAST_REGISTRY_BASE_URL
      ?? readSkillcastConfigSync().defaultRegistry
      ?? "https://registry.skillcast.dev";
  }

  if (registry.startsWith("http://") || registry.startsWith("https://")) {
    return registry;
  }

  if (registry.startsWith("localhost:") || registry.startsWith("127.0.0.1:")) {
    return `http://${registry}`;
  }

  return `https://${registry}`;
}

function getDefaultBundleStoreBaseUrl(): string | undefined {
  return normalizeConfiguredBaseUrl(
    process.env.SKILLCAST_BUNDLE_STORE_URL
    ?? readSkillcastConfigSync().defaultBundleStoreUrl
  );
}

let bundleStoreClientFactory: ((target: S3StoreTarget) => BundleStoreClient | Promise<BundleStoreClient>) | null = null;

export function setBundleStoreClientFactoryForTests(
  factory: ((target: S3StoreTarget) => BundleStoreClient | Promise<BundleStoreClient>) | null
): void {
  bundleStoreClientFactory = factory;
}

async function createBundleStoreClient(target: S3StoreTarget): Promise<BundleStoreClient> {
  if (bundleStoreClientFactory) {
    return bundleStoreClientFactory(target);
  }

  const client = new S3Client({ region: target.region });

  return {
    getText: async (key) => {
      try {
        const response = await client.send(new GetObjectCommand({
          Bucket: target.bucket,
          Key: key
        }));
        return response.Body ? await response.Body.transformToString() : "";
      } catch (error) {
        if (isS3NotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
    putText: async (key, content, contentType) => {
      await client.send(new PutObjectCommand({
        Bucket: target.bucket,
        Key: key,
        Body: content,
        ContentType: contentType
      }));
    },
    exists: async (key) => {
      try {
        await client.send(new HeadObjectCommand({
          Bucket: target.bucket,
          Key: key
        }));
        return true;
      } catch (error) {
        if (isS3NotFoundError(error)) {
          return false;
        }
        throw error;
      }
    },
    listKeys: async (prefix) => {
      const keys: string[] = [];
      let continuationToken: string | undefined;

      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: target.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        }));
        for (const item of response.Contents ?? []) {
          if (item.Key) {
            keys.push(item.Key);
          }
        }
        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      return keys;
    },
    deleteKeys: async (keys) => {
      if (keys.length === 0) {
        return;
      }

      for (let index = 0; index < keys.length; index += 1000) {
        const batch = keys.slice(index, index + 1000);
        await client.send(new DeleteObjectsCommand({
          Bucket: target.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true
          }
        }));
      }
    }
  };
}

function normalizeConfiguredBaseUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/\/+$/, "");
}

function getArtifactCachePath(digest: string): string {
  const normalized = normalizeDigest(digest);
  return path.join(os.homedir(), ".skillcast", "cache", "artifacts", `${normalized}.json`);
}

function readSkillcastConfigSync(): SkillcastConfig {
  const candidates = [
    path.join(process.cwd(), "skillcast.config.json"),
    path.join(process.cwd(), ".skillcast", "config.json")
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }

    const parsed = z.object({
      defaultRegistry: z.string().min(1).optional(),
      defaultBundleStoreUrl: z.string().min(1).optional()
    }).safeParse(fs.readJsonSync(candidate));
    if (parsed.success) {
      return parsed.data;
    }
  }

  return {};
}

async function fetchRemoteStoreCatalog(baseUrl: string): Promise<RemoteStoreCatalogEntry[]> {
  const response = await fetch(`${baseUrl}/catalog.json`, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(await buildArtifactFetchError(response, `${baseUrl}/catalog.json`));
  }

  const catalog = remoteStoreCatalogSchema.parse(await response.json());
  return catalog.bundles;
}

async function buildRegistryError(response: Response, requestedRef: string): Promise<string> {
  let detail = "";

  try {
    const payload = await response.json();
    const parsed = z.object({
      error: z.object({
        code: z.string().min(1),
        message: z.string().min(1).optional()
      })
    }).safeParse(payload);
    if (parsed.success) {
      detail = parsed.data.error.message
        ? `${parsed.data.error.code}: ${parsed.data.error.message}`
        : parsed.data.error.code;
    }
  } catch {
    // Fall back to status text.
  }

  return detail
    ? `Registry request failed for '${requestedRef}': ${detail}`
    : `Registry request failed for '${requestedRef}' with status ${response.status}.`;
}

async function buildArtifactFetchError(response: Response, requestedRef: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return buildRegistryError(response, requestedRef);
  }

  return `Artifact request failed for '${requestedRef}' with status ${response.status}.`;
}

function normalizeSourceDisplay(source: string, sourceType: ManifestSourceType): string {
  if (sourceType === "path" && path.basename(source).toLowerCase() === "bundle.yaml") {
    return toDisplayPath(path.dirname(source));
  }

  return source;
}

function normalizeManifestEntry(entry: ManifestEntry): ManifestEntry {
  if (entry.sourceType === "registry" && !entry.resolution) {
    throw new Error(`Manifest entry for bundle '${entry.bundle}' is missing required resolution metadata.`);
  }

  const skills = entry.skills
    .map((skill) => ({
      ...skill,
      relativePath: toPosix(skill.relativePath),
      ownership: {
        ...skill.ownership,
        source: normalizeSourceDisplay(skill.ownership.source, skill.ownership.sourceType)
      }
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    ...entry,
    source: normalizeSourceDisplay(entry.source, entry.sourceType),
    installedSkills: uniqueSkillNames(skills.map((skill) => skill.name)),
    skillDir: toPosix(entry.skillDir),
    skills,
    resolution: entry.resolution
  };
}

function sortManifestEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return entries
    .slice()
    .sort((left, right) => left.bundle.localeCompare(right.bundle));
}

async function listPacks(searchRoot: string, preferCatalog: boolean): Promise<PackListItem[]> {
  const catalog = preferCatalog ? await readBuiltInCatalog(searchRoot) : [];
  const remoteCatalog = preferCatalog ? await readDefaultStoreCatalog() : [];

  if (catalog.length > 0 || remoteCatalog.length > 0) {
    const payload = [];
    for (const entry of catalog) {
      const bundle = await validateBundleRoot(path.resolve(searchRoot, entry.path));
      payload.push({
        name: bundle.config.name,
        version: bundle.config.version,
        description: entry.description,
        path: toDisplayPath(bundle.rootPath),
        skills: bundle.skills.map((skill) => skill.config.name),
        category: entry.category,
        tags: entry.tags,
        featured: entry.featured
      });
    }

    for (const entry of remoteCatalog) {
      payload.push({
        name: entry.name,
        version: entry.latestVersion,
        description: entry.description,
        path: `store:${entry.name}`,
        skills: []
      });
    }

    payload.sort((left, right) => left.name.localeCompare(right.name));
    return payload;
  }

  const bundles = await findBundles(searchRoot);
  return bundles.map((bundle) => ({
    name: bundle.config.name,
    version: bundle.config.version,
    description: bundle.config.description,
    path: toDisplayPath(bundle.rootPath),
    skills: bundle.skills.map((skill) => skill.config.name)
  }));
}

async function readBuiltInCatalog(searchRoot: string): Promise<CatalogEntry[]> {
  const catalogPath = path.join(searchRoot, "catalog.json");
  if (!(await fs.pathExists(catalogPath))) {
    return [];
  }

  const raw = await fs.readJson(catalogPath);
  const catalog = builtInCatalogSchema.parse(raw);
  return catalog.packs;
}

async function readDefaultStoreCatalog(): Promise<RemoteStoreCatalogEntry[]> {
  const baseUrl = getDefaultBundleStoreBaseUrl();
  if (!baseUrl) {
    return [];
  }

  try {
    return await fetchRemoteStoreCatalog(baseUrl);
  } catch {
    return [];
  }
}

export async function validateBundle(bundleRef: string): Promise<ValidatedBundle> {
  const loaded = await withResolvedValidatedBundle(bundleRef, async (result) => result);
  return loaded.bundle;
}

export async function inspectBundle(bundleRef: string, options: { installed?: boolean } = {}): Promise<InspectPayload> {
  return withResolvedValidatedBundle(bundleRef, async ({ resolved, bundle, resolvedVersion, resolvedDigest }) => {
    const payload: InspectPayload = {
      name: bundle.config.name,
      version: bundle.config.version,
      description: bundle.config.description,
      source: resolved.displaySource,
      resolvedVersion,
      resolvedDigest,
      targets: bundle.config.targets,
      skills: bundle.skills.map((skill) => ({
        id: skill.config.id,
        name: skill.config.name,
        version: skill.config.version,
        description: skill.config.description,
        path: toPosix(path.relative(bundle.rootPath, skill.directory)),
        instructions: toPosix(path.relative(bundle.rootPath, skill.instructionsPath)),
        runtimes: skill.config.compatibility.runtimes,
        inputs: skill.config.inputs,
        outputs: skill.config.outputs
      }))
    };

    if (options.installed) {
      const diff = await diffBundle(bundleRef);
      payload.installedState = {
        installed: diff.installed,
        installedAt: diff.installedAt,
        updatedAt: diff.updatedAt,
        changedSkills: diff.changes
      };
    }

    return payload;
  });
}

export async function diffBundle(bundleRef: string): Promise<DiffPayload> {
  return withResolvedValidatedBundle(bundleRef, async ({ resolved, bundle }) => diffValidatedBundle(bundle, resolved));
}

async function diffValidatedBundle(bundle: ValidatedBundle, resolved: ResolvedBundleReference): Promise<DiffPayload> {
  const repoRoot = process.cwd();
  const installedSkillsDir = path.join(repoRoot, ".skillcast", "skills");
  const manifest = await readManifest(path.join(repoRoot, ".skillcast", "manifest.json"));
  const installedEntry = manifest.bundles.find((entry) => entry.bundle === bundle.config.name);
  const changes: DiffSkillPayload[] = [];

  for (const skill of bundle.skills) {
    const desiredRelativePath = getInstalledSkillRelativePath(skill.config.name);
    const desiredContent = await renderInstalledSkill(bundle, skill, getInstalledSkillDirectory(installedSkillsDir, skill.config.name));
    const desiredHash = hashContent(desiredContent);
    const existingRecord = installedEntry ? findSkillRecordInBundle(installedEntry, skill.config.id, skill.config.name) : undefined;

    if (!existingRecord) {
      changes.push({
        id: skill.config.id,
        name: skill.config.name,
        status: "new",
        path: desiredRelativePath,
        details: "Skill is present in the source bundle but not installed locally."
      });
      continue;
    }

    const currentHash = await hashPathIfExists(path.resolve(repoRoot, existingRecord.relativePath));
    const localModified = currentHash !== null && existingRecord.fileHash !== "" && currentHash !== existingRecord.fileHash;
    const sourceChanged = existingRecord.sourceHash !== desiredHash;

    if (currentHash === null) {
      changes.push({
        id: skill.config.id,
        name: skill.config.name,
        status: "missing",
        path: existingRecord.relativePath,
        details: "Manifest entry exists but the installed SKILL.md file is missing."
      });
    } else if (localModified && sourceChanged) {
      changes.push({
        id: skill.config.id,
        name: skill.config.name,
        status: "conflict",
        path: existingRecord.relativePath,
        details: "Both the installed file and the source bundle changed since the last install."
      });
    } else if (localModified) {
      changes.push({
        id: skill.config.id,
        name: skill.config.name,
        status: "local-modified",
        path: existingRecord.relativePath,
        details: "Installed SKILL.md was modified locally after installation."
      });
    } else if (sourceChanged) {
      changes.push({
        id: skill.config.id,
        name: skill.config.name,
        status: "source-changed",
        path: existingRecord.relativePath,
        details: "Source bundle differs from the installed version."
      });
    } else {
      changes.push({
        id: skill.config.id,
        name: skill.config.name,
        status: "unchanged",
        path: existingRecord.relativePath,
        details: "Installed skill matches the current source bundle."
      });
    }
  }

  if (installedEntry) {
    for (const installedSkill of installedEntry.skills) {
      const stillPresent = bundle.skills.some((skill) => skill.config.id === installedSkill.id || skill.config.name === installedSkill.name);
      if (!stillPresent) {
        changes.push({
          id: installedSkill.id,
          name: installedSkill.name,
          status: "removed",
          path: installedSkill.relativePath,
          details: "Skill exists in the local install but is no longer present in the source bundle."
        });
      }
    }
  }

  return {
    bundle: bundle.config.name,
    version: bundle.config.version,
    source: resolved.displaySource,
    installed: Boolean(installedEntry),
    installedAt: installedEntry?.installedAt,
    updatedAt: installedEntry?.updatedAt,
    changes: changes.sort((left, right) => left.name.localeCompare(right.name))
  };
}

export async function installBundle(bundleRef: string, options: InstallOptions = {}): Promise<InstallResult> {
  return withResolvedValidatedBundle(bundleRef, async (loaded) =>
    withSkillcastLock(process.cwd(), async () => installLoadedBundleUnlocked(loaded, options))
  );
}

export async function publishBundle(bundleRef: string, options: PublishOptions = {}): Promise<PublishResult> {
  return withResolvedValidatedBundle(bundleRef, async ({ resolved, bundle }) => {
    assertLocalBundleReference(resolved);
    const target = resolveS3StoreTarget(options.storeUrl, options.region);
    const client = await createBundleStoreClient(target);
    const bundleRootKey = buildStoreBundleVersionKeyPrefix(bundle.config.name, bundle.config.version, target.prefix);
    const bundleYamlKey = `${bundleRootKey}/bundle.yaml`;
    const catalogKey = buildStoreCatalogKey(target.prefix);
    const publishedFiles = await collectPublishBundleFiles(bundle);

    const existingCatalog = await readStoreCatalogFromClient(client, catalogKey);
    const existingBundle = existingCatalog.find((entry) => entry.name === bundle.config.name);
    if (existingBundle?.versions.includes(bundle.config.version) || await client.exists(bundleYamlKey)) {
      throw new Error(
        `Bundle '${bundle.config.name}@${bundle.config.version}' already exists in the bundle store at ${target.baseUrl}.`
      );
    }

    if (!options.dryRun) {
      for (const file of publishedFiles) {
        await client.putText(
          `${bundleRootKey}/${file.path}`,
          file.content,
          file.path.endsWith(".md")
            ? "text/markdown; charset=utf-8"
            : file.path.endsWith(".yaml")
              ? "text/yaml; charset=utf-8"
              : "text/plain; charset=utf-8"
        );
      }
      await writeStoreCatalogToClient(client, catalogKey, updateStoreCatalog(existingCatalog, bundle));
    }

    return {
      name: bundle.config.name,
      version: bundle.config.version,
      storeUrl: target.baseUrl,
      bundlePath: toPosix(bundleRootKey),
      catalogPath: toPosix(catalogKey),
      publishedFiles: publishedFiles.map((file) => file.path),
      dryRun: Boolean(options.dryRun),
      summary: options.dryRun
        ? `Dry run: would publish ${bundle.config.name}@${bundle.config.version} to ${target.baseUrl}.`
        : `Published ${bundle.config.name}@${bundle.config.version} to ${target.baseUrl}.`
    };
  });
}

function buildStoreCatalogKey(prefix: string): string {
  return prefix ? `${prefix}/catalog.json` : "catalog.json";
}

function buildStoreBundleVersionKeyPrefix(bundleName: string, version: string, prefix: string): string {
  const relative = toPosix(path.posix.join("bundles", bundleName, version));
  return prefix ? `${prefix}/${relative}` : relative;
}

function isS3NotFoundError(error: unknown): boolean {
  return error instanceof Error && (
    "name" in error && (error as Error & { name?: string }).name === "NotFound"
    || "Code" in (error as object) && (error as { Code?: string }).Code === "NotFound"
    || "Code" in (error as object) && (error as { Code?: string }).Code === "NoSuchKey"
    || "$metadata" in (error as object) && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
  );
}

export async function unpublishBundle(bundleRefOrName: string, options: UnpublishOptions = {}): Promise<UnpublishResult> {
  const targetBundle = await resolveUnpublishTarget(bundleRefOrName, options.version);
  const target = resolveS3StoreTarget(options.storeUrl, options.region);
  const client = await createBundleStoreClient(target);
  const versionPrefix = buildStoreBundleVersionKeyPrefix(targetBundle.name, targetBundle.version, target.prefix);
  const bundleYamlKey = `${versionPrefix}/bundle.yaml`;
  const catalogKey = buildStoreCatalogKey(target.prefix);

  const existingCatalog = await readStoreCatalogFromClient(client, catalogKey);
  const existingBundle = existingCatalog.find((entry) => entry.name === targetBundle.name);
  if (!existingBundle || !existingBundle.versions.includes(targetBundle.version) || !(await client.exists(bundleYamlKey))) {
    throw new Error(
      `Bundle '${targetBundle.name}@${targetBundle.version}' was not found in the bundle store at ${target.baseUrl}.`
    );
  }

  const nextCatalog = removeStoreCatalogVersion(existingCatalog, targetBundle.name, targetBundle.version);
  const objectKeys = await client.listKeys(`${versionPrefix}/`);

  if (!options.dryRun) {
    if (objectKeys.length > 0) {
      await client.deleteKeys(objectKeys);
    }

    if (nextCatalog.length === 0) {
      if (await client.exists(catalogKey)) {
        await client.deleteKeys([catalogKey]);
      }
    } else {
      await writeStoreCatalogToClient(client, catalogKey, nextCatalog);
    }
  }

  return {
    name: targetBundle.name,
    version: targetBundle.version,
    storeUrl: target.baseUrl,
    bundlePath: toPosix(versionPrefix),
    catalogPath: toPosix(catalogKey),
    removedBundle: !nextCatalog.some((entry) => entry.name === targetBundle.name),
    dryRun: Boolean(options.dryRun),
    summary: options.dryRun
      ? `Dry run: would unpublish ${targetBundle.name}@${targetBundle.version} from ${target.baseUrl}.`
      : `Unpublished ${targetBundle.name}@${targetBundle.version} from ${target.baseUrl}.`
  };
}

async function installBundleUnlocked(bundleRef: string, options: InstallOptions = {}): Promise<InstallResult> {
  const resolved = await resolveBundleReference(bundleRef);
  assertLocalBundleReference(resolved);
  const bundle = await validateBundleRoot(resolved.rootPath);
  return installLoadedBundleUnlocked({ resolved, bundle }, options);
}

async function installLoadedBundleUnlocked(
  loaded: LoadedValidatedBundle,
  options: InstallOptions = {}
): Promise<InstallResult> {
  const { resolved, bundle, resolvedVersion, resolvedDigest, resolution } = loaded;
  const repoRoot = process.cwd();
  const skillcastDir = path.join(repoRoot, ".skillcast");
  const installedSkillsDir = path.join(skillcastDir, "skills");
  const manifestPath = path.join(skillcastDir, "manifest.json");
  const manifest = await readManifest(manifestPath);
  const existingBundle = manifest.bundles.find((entry) => entry.bundle === bundle.config.name);
  const now = new Date().toISOString();
  const warnings: string[] = [];
  const changedSkills: string[] = [];
  const desiredRecords: InstalledSkillEntry[] = [];
  const existingBundleMatchKeys = new Set<string>();
  const overwrittenOwners = new Map<string, { bundle: ManifestEntry; skill: InstalledSkillEntry }>();

  if (existingBundle && !options.update) {
    throw new Error(`Bundle '${bundle.config.name}' is already installed. Use 'skillcast install ${resolved.displaySource} --update' to refresh it.`);
  }

  if (!existingBundle && options.update) {
    throw new Error(`Bundle '${bundle.config.name}' is not installed yet. Remove '--update' to install it for the first time.`);
  }

  await fs.ensureDir(installedSkillsDir);

  for (const skill of bundle.skills) {
    const skillFolder = getInstalledSkillDirectory(installedSkillsDir, skill.config.name);
    const skillFilePath = getInstalledSkillFilePath(installedSkillsDir, skill.config.name);
    const rendered = await renderInstalledSkill(bundle, skill, skillFolder);
    const sourceHash = hashContent(rendered);
    const owner = findManifestSkillOwner(manifest.bundles, skill.config.id, skill.config.name);
    const existingRecord = existingBundle ? findSkillRecordInBundle(existingBundle, skill.config.id, skill.config.name) : undefined;
    const currentHash = await hashPathIfExists(skillFilePath);

    if (existingRecord) {
      existingBundleMatchKeys.add(skillRecordKey(existingRecord));
    }

    if (owner && owner.bundle.bundle !== bundle.config.name) {
      const ownerCurrentHash = await hashPathIfExists(path.resolve(repoRoot, owner.skill.relativePath));
      const ownerModified = ownerCurrentHash !== null && owner.skill.fileHash !== "" && ownerCurrentHash !== owner.skill.fileHash;
      if (!options.force) {
        throw new Error(
          `Skill collision for '${skill.config.name}' (${skill.config.id}). It is already owned by bundle '${owner.bundle.bundle}'. Re-run with '--force' to overwrite explicitly.`
        );
      }
      warnings.push(ownerModified
        ? `Overwriting locally modified skill '${owner.skill.name}' owned by bundle '${owner.bundle.bundle}'.`
        : `Overwriting skill '${owner.skill.name}' owned by bundle '${owner.bundle.bundle}'.`);
      overwrittenOwners.set(skillRecordKey(owner.skill), owner);
    } else if (!owner && currentHash !== null && !options.force) {
      throw new Error(
        `Skill path collision for '${skill.config.name}'. ${getInstalledSkillRelativePath(skill.config.name)} already exists but is not tracked in the manifest. Re-run with '--force' to overwrite it explicitly.`
      );
    } else if (!owner && currentHash !== null && options.force) {
      warnings.push(`Overwriting unmanaged skill file at ${getInstalledSkillRelativePath(skill.config.name)}.`);
    }

    if (existingRecord) {
      const localModified = currentHash !== null && existingRecord.fileHash !== "" && currentHash !== existingRecord.fileHash;
      if (localModified && !options.force) {
        throw new Error(
          `Installed skill '${existingRecord.name}' was modified locally. Re-run with '--force' to overwrite local changes.`
        );
      }
      if (localModified) {
        warnings.push(`Overwriting locally modified skill '${existingRecord.name}'.`);
      }
    }

    changedSkills.push(skill.config.name);
    desiredRecords.push({
      id: skill.config.id,
      name: skill.config.name,
      version: skill.config.version,
      relativePath: getInstalledSkillRelativePath(skill.config.name),
      fileHash: sourceHash,
      sourceHash,
      installedAt: existingRecord?.installedAt ?? now,
      updatedAt: now,
      ownership: {
        bundle: bundle.config.name,
        source: resolved.displaySource,
        sourceType: resolved.referenceType
      }
    });
  }

  const removedRecords = existingBundle
    ? existingBundle.skills.filter((record) => !existingBundleMatchKeys.has(skillRecordKey(record)))
    : [];
  const removedSkills = uniqueSkillNames(removedRecords.map((record) => record.name));

  for (const record of removedRecords) {
    const currentHash = await hashPathIfExists(path.resolve(repoRoot, record.relativePath));
    const localModified = currentHash !== null && record.fileHash !== "" && currentHash !== record.fileHash;
    if (localModified && !options.force) {
      throw new Error(
        `Installed skill '${record.name}' would be removed by update, but it was modified locally. Re-run with '--force' to remove it explicitly.`
      );
    }
    if (localModified) {
      warnings.push(`Removing locally modified skill '${record.name}' because it no longer exists in the source bundle.`);
    }
  }

  if (!options.dryRun) {
    const nextManifestBundles = manifest.bundles.map((entry) => ({
      ...entry,
      installedSkills: entry.installedSkills.slice(),
      skills: entry.skills.slice()
    }));

    for (const overwritten of overwrittenOwners.values()) {
      const ownerEntry = nextManifestBundles.find((entry) => entry.bundle === overwritten.bundle.bundle);
      if (!ownerEntry) {
        continue;
      }

      ownerEntry.skills = ownerEntry.skills.filter((record) => skillRecordKey(record) !== skillRecordKey(overwritten.skill));
      ownerEntry.installedSkills = uniqueSkillNames(ownerEntry.skills.map((record) => record.name));
      ownerEntry.updatedAt = now;
    }

    for (const record of removedRecords) {
      await removeInstalledSkillByRecord(repoRoot, installedSkillsDir, record);
    }

    for (const skill of bundle.skills) {
      const skillFolder = getInstalledSkillDirectory(installedSkillsDir, skill.config.name);
      await fs.ensureDir(skillFolder);
      await fs.writeFile(
        getInstalledSkillFilePath(installedSkillsDir, skill.config.name),
        await renderInstalledSkill(bundle, skill, skillFolder),
        "utf8"
      );
    }

    const nextBundleEntry: ManifestEntry = normalizeManifestEntry({
      bundle: bundle.config.name,
      bundleVersion: bundle.config.version,
      source: resolved.displaySource,
      sourceType: resolved.referenceType,
      installedSkills: desiredRecords.map((record) => record.name),
      installedAt: existingBundle?.installedAt ?? now,
      updatedAt: now,
      skillDir: toPosix(path.relative(repoRoot, installedSkillsDir)),
      skills: desiredRecords,
      resolution
    });

    const filteredBundles = nextManifestBundles
      .filter((entry) => entry.bundle !== bundle.config.name)
      .filter((entry) => entry.skills.length > 0);
    filteredBundles.push(nextBundleEntry);

    await writeManifest(manifestPath, {
      manifestVersion: MANIFEST_VERSION,
      bundles: filteredBundles
    });
  }

  return {
    action: existingBundle ? "updated" : "installed",
    name: bundle.config.name,
    version: bundle.config.version,
    source: resolved.displaySource,
    resolvedVersion,
    resolvedDigest,
    skillDir: toPosix(path.relative(repoRoot, installedSkillsDir)),
    manifestPath: toPosix(path.relative(repoRoot, manifestPath)),
    changedSkills: uniqueSkillNames(changedSkills),
    removedSkills,
    warnings: uniqueStrings(warnings),
    dryRun: Boolean(options.dryRun),
    summary: options.dryRun
      ? `Dry run: ${(existingBundle ? "updated" : "installed")} ${bundle.config.name}@${bundle.config.version}.`
      : `${existingBundle ? "Updated" : "Installed"} ${bundle.config.name}@${bundle.config.version}.`
  };
}

function resolveS3StoreTarget(explicitUrl?: string, explicitRegion?: string): S3StoreTarget {
  const baseUrl = normalizeConfiguredBaseUrl(explicitUrl ?? readSkillcastConfigSync().defaultBundleStoreUrl);
  if (!baseUrl) {
    throw new Error("Missing bundle store URL. Pass '--store-url <url>' or set 'defaultBundleStoreUrl' in skillcast.config.json.");
  }

  const parsed = new URL(baseUrl);
  const match = parsed.hostname.match(/^(.+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i)
    ?? parsed.hostname.match(/^(.+)\.s3\.amazonaws\.com$/i);
  if (!match) {
    if (bundleStoreClientFactory && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
      return {
        baseUrl,
        bucket: parsed.hostname,
        prefix: parsed.pathname.replace(/^\/+|\/+$/g, ""),
        region: explicitRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1"
      };
    }

    throw new Error(`Bundle store URL must target an S3 bucket host: ${baseUrl}`);
  }

  const bucket = match[1];
  const inferredRegion = match[2];
  const region = explicitRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? inferredRegion;
  if (!region) {
    throw new Error(`Could not determine AWS region for bundle store URL '${baseUrl}'. Pass '--region <region>' or set AWS_REGION.`);
  }

  return {
    baseUrl,
    bucket,
    prefix: parsed.pathname.replace(/^\/+|\/+$/g, ""),
    region
  };
}

async function resolveUnpublishTarget(input: string, explicitVersion?: string): Promise<{ name: string; version: string }> {
  const explicitRoot = path.resolve(process.cwd(), input);
  if (await fs.pathExists(path.join(explicitRoot, "bundle.yaml"))) {
    const bundle = await validateBundleRoot(explicitRoot);
    return {
      name: bundle.config.name,
      version: explicitVersion ?? bundle.config.version
    };
  }

  const builtInRoot = await resolvePackSearchPath();
  const catalog = await readBuiltInCatalog(builtInRoot);
  const catalogMatch = catalog.find((entry) => entry.name === input);
  if (catalogMatch) {
    const bundle = await validateBundleRoot(path.resolve(builtInRoot, catalogMatch.path));
    return {
      name: bundle.config.name,
      version: explicitVersion ?? bundle.config.version
    };
  }

  const parsed = parseBundleNameAndVersion(input);
  if (parsed) {
    return {
      name: parsed.name,
      version: explicitVersion ?? parsed.version
    };
  }

  if (explicitVersion) {
    return {
      name: input,
      version: explicitVersion
    };
  }

  throw new Error("Unpublish requires either a local bundle reference or an exact '<bundle>@<version>' target.");
}

async function collectPublishBundleFiles(bundle: ValidatedBundle): Promise<Array<{ path: string; content: string }>> {
  const publishedFiles = new Map<string, string>();
  publishedFiles.set("bundle.yaml", await fs.readFile(bundle.bundlePath, "utf8"));

  for (const skill of bundle.skills) {
    const skillYamlPath = path.join(skill.directory, "skill.yaml");
    publishedFiles.set(
      toPosix(path.relative(bundle.rootPath, skillYamlPath)),
      await fs.readFile(skillYamlPath, "utf8")
    );
    publishedFiles.set(
      toPosix(path.relative(bundle.rootPath, skill.instructionsPath)),
      await fs.readFile(skill.instructionsPath, "utf8")
    );
  }

  return [...publishedFiles.entries()]
    .map(([filePath, content]) => ({ path: filePath, content }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function updateStoreCatalog(existing: RemoteStoreCatalogEntry[], bundle: ValidatedBundle): RemoteStoreCatalogEntry[] {
  const grouped = new Map(existing.map((entry) => [entry.name, {
    name: entry.name,
    description: entry.description,
    versions: entry.versions.slice()
  }]));

  const current = grouped.get(bundle.config.name) ?? {
    name: bundle.config.name,
    description: bundle.config.description,
    versions: []
  };
  current.description = bundle.config.description;
  current.versions.push(bundle.config.version);
  grouped.set(bundle.config.name, current);

  return [...grouped.values()]
    .map((entry) => {
      const versions = [...new Set(entry.versions)].sort(compareVersions);
      return {
        name: entry.name,
        description: entry.description,
        latestVersion: versions[versions.length - 1],
        versions
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function removeStoreCatalogVersion(existing: RemoteStoreCatalogEntry[], bundleName: string, version: string): RemoteStoreCatalogEntry[] {
  return existing
    .flatMap((entry) => {
      if (entry.name !== bundleName) {
        return [entry];
      }

      const versions = entry.versions
        .filter((candidate) => candidate !== version)
        .sort(compareVersions);
      if (versions.length === 0) {
        return [];
      }

      return [{
        name: entry.name,
        description: entry.description,
        latestVersion: versions[versions.length - 1],
        versions
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function writeStoreCatalogToClient(client: BundleStoreClient, catalogKey: string, bundles: RemoteStoreCatalogEntry[]): Promise<void> {
  await client.putText(catalogKey, `${JSON.stringify({
    catalogVersion: 1,
    bundles
  }, null, 2)}\n`, "application/json; charset=utf-8");
}

async function readStoreCatalogFromClient(client: BundleStoreClient, catalogKey: string): Promise<RemoteStoreCatalogEntry[]> {
  const text = await client.getText(catalogKey);
  if (!text) {
    return [];
  }

  const catalog = remoteStoreCatalogSchema.parse(JSON.parse(text));
  return catalog.bundles;
}

export async function uninstallBundleOrSkill(bundleOrSkill: string, options: UninstallOptions = {}): Promise<UninstallResult> {
  return withSkillcastLock(process.cwd(), async () => uninstallBundleOrSkillUnlocked(bundleOrSkill, options));
}

async function uninstallBundleOrSkillUnlocked(bundleOrSkill: string, options: UninstallOptions = {}): Promise<UninstallResult> {
  const repoRoot = process.cwd();
  const skillcastDir = path.join(repoRoot, ".skillcast");
  const installedSkillsDir = path.join(skillcastDir, "skills");
  const manifestPath = path.join(skillcastDir, "manifest.json");
  const manifest = await readManifest(manifestPath);
  const warnings: string[] = [];
  const bundleMatches = manifest.bundles.filter((entry) => entry.bundle === bundleOrSkill);
  const skillMatches = manifest.bundles.flatMap((entry) =>
    entry.skills
      .filter((skill) => skill.name === bundleOrSkill || skill.id === bundleOrSkill)
      .map((skill) => ({ bundle: entry, skill }))
  );

  if (bundleMatches.length > 0 && skillMatches.some((match) => match.bundle.bundle !== bundleOrSkill)) {
    throw new Error(`Input '${bundleOrSkill}' matches both an installed bundle and an installed skill. Use a unique name or skill id.`);
  }

  if (bundleMatches.length > 0) {
    const removedSkills = uniqueSkillNames(bundleMatches.flatMap((entry) => entry.skills.map((skill) => skill.name)));

    for (const entry of bundleMatches) {
      for (const skill of entry.skills) {
        const currentHash = await hashPathIfExists(path.resolve(repoRoot, skill.relativePath));
        if (currentHash !== null && skill.fileHash !== "" && currentHash !== skill.fileHash) {
          warnings.push(`Removing locally modified skill '${skill.name}'.`);
        }
        if (!options.dryRun) {
          await removeInstalledSkillByRecord(repoRoot, installedSkillsDir, skill);
        }
      }
    }

    if (!options.dryRun) {
      await writeManifest(manifestPath, {
        manifestVersion: MANIFEST_VERSION,
        bundles: manifest.bundles.filter((entry) => entry.bundle !== bundleOrSkill)
      });
    }

    return {
      removedType: "bundle",
      removedTarget: bundleOrSkill,
      removedSkills,
      manifestPath: options.dryRun ? toPosix(path.relative(repoRoot, manifestPath)) : toPosix(path.relative(repoRoot, manifestPath)),
      message: `${options.dryRun ? "Dry run: would uninstall" : "Uninstalled"} bundle ${bundleOrSkill}.`,
      warnings: uniqueStrings(warnings)
    };
  }

  if (skillMatches.length === 0) {
    throw new Error(`No installed bundle or skill named '${bundleOrSkill}' was found.`);
  }

  if (skillMatches.length > 1) {
    throw new Error(
      `Skill '${bundleOrSkill}' is ambiguous because it appears in multiple bundles: ${skillMatches.map((match) => match.bundle.bundle).join(", ")}.`
    );
  }

  const target = skillMatches[0];
  const currentHash = await hashPathIfExists(path.resolve(repoRoot, target.skill.relativePath));
  if (currentHash !== null && target.skill.fileHash !== "" && currentHash !== target.skill.fileHash) {
    warnings.push(`Removing locally modified skill '${target.skill.name}'.`);
  }

  if (!options.dryRun) {
    await removeInstalledSkillByRecord(repoRoot, installedSkillsDir, target.skill);
  }

  const nextBundles = manifest.bundles
    .map((entry) => ({
      ...entry,
      skills: entry.bundle === target.bundle.bundle
        ? entry.skills.filter((record) => skillRecordKey(record) !== skillRecordKey(target.skill))
        : entry.skills
    }))
    .map((entry) => normalizeManifestEntry({
      ...entry,
      installedSkills: entry.skills.map((record) => record.name),
      updatedAt: entry.bundle === target.bundle.bundle ? new Date().toISOString() : entry.updatedAt
    }))
    .filter((entry) => entry.skills.length > 0);

  if (!options.dryRun) {
    await writeManifest(manifestPath, {
      manifestVersion: MANIFEST_VERSION,
      bundles: nextBundles
    });
  }

  return {
    removedType: "skill",
    removedTarget: bundleOrSkill,
    removedSkills: [target.skill.name],
    manifestPath: toPosix(path.relative(repoRoot, manifestPath)),
    message: `${options.dryRun ? "Dry run: would uninstall" : "Uninstalled"} skill ${target.skill.name}.`,
    warnings: uniqueStrings(warnings)
  };
}

export async function uninstallAll(options: UninstallOptions = {}): Promise<UninstallResult> {
  return withSkillcastLock(process.cwd(), async () => uninstallAllUnlocked(options));
}

async function uninstallAllUnlocked(options: UninstallOptions = {}): Promise<UninstallResult> {
  const repoRoot = process.cwd();
  const skillcastDir = path.join(repoRoot, ".skillcast");
  const installedSkillsDir = path.join(skillcastDir, "skills");
  const manifestPath = path.join(skillcastDir, "manifest.json");
  const manifest = await readManifest(manifestPath);
  const warnings: string[] = [];

  if (manifest.bundles.length === 0) {
    if (!options.dryRun) {
      await cleanupSkillcastDirectory(skillcastDir);
    }
    return {
      removedType: "bundle",
      removedTarget: "--all",
      removedSkills: [],
      message: options.dryRun ? "Dry run: no installed bundles found." : "No installed bundles found.",
      warnings
    };
  }

  const installedSkills = manifest.bundles.flatMap((entry) => entry.skills);
  for (const skill of installedSkills) {
    const currentHash = await hashPathIfExists(path.resolve(repoRoot, skill.relativePath));
    if (currentHash !== null && skill.fileHash !== "" && currentHash !== skill.fileHash) {
      warnings.push(`Removing locally modified skill '${skill.name}'.`);
    }
    if (!options.dryRun) {
      await removeInstalledSkillByRecord(repoRoot, installedSkillsDir, skill);
    }
  }

  if (!options.dryRun) {
    await cleanupSkillcastDirectory(skillcastDir);
  }

  return {
    removedType: "bundle",
    removedTarget: "--all",
    removedSkills: uniqueSkillNames(installedSkills.map((skill) => skill.name)),
    message: options.dryRun ? "Dry run: would uninstall all bundles and clean .skillcast." : "Uninstalled all bundles and cleaned .skillcast.",
    warnings: uniqueStrings(warnings)
  };
}

export async function getPackList(searchPathInput?: string): Promise<PackListItem[]> {
  const resolvedSearchPath = await resolvePackSearchPath(searchPathInput);
  return listPacks(resolvedSearchPath, !searchPathInput);
}

export async function listBundleSkills(bundleRef: string): Promise<{
  bundle: string;
  version: string;
  source: string;
  skills: Array<{
    id: string;
    name: string;
    version: string;
    description: string;
    path: string;
  }>;
}> {
  return withResolvedValidatedBundle(bundleRef, async ({ resolved, bundle }) => ({
    bundle: bundle.config.name,
    version: bundle.config.version,
    source: resolved.displaySource,
    skills: bundle.skills.map((skill) => ({
      id: skill.config.id,
      name: skill.config.name,
      version: skill.config.version,
      description: skill.config.description,
      path: toPosix(path.relative(bundle.rootPath, skill.directory))
    }))
  }));
}

export async function getInstalledBundles(): Promise<InstalledListItem[]> {
  const manifestPath = path.join(process.cwd(), ".skillcast", "manifest.json");
  const manifest = await readManifest(manifestPath);
  return manifest.bundles
    .slice()
    .sort((left, right) => left.bundle.localeCompare(right.bundle))
    .map((bundle) => ({
      bundle: bundle.bundle,
      bundleVersion: bundle.bundleVersion,
      source: bundle.source,
      sourceType: bundle.sourceType,
      installedSkills: bundle.installedSkills,
      installedAt: bundle.installedAt,
      updatedAt: bundle.updatedAt,
      skillDir: bundle.skillDir
    }));
}

export async function getInstalledSkills(): Promise<Array<{
  bundle: string;
  id: string;
  name: string;
  version: string;
  path: string;
}>> {
  const manifestPath = path.join(process.cwd(), ".skillcast", "manifest.json");
  const manifest = await readManifest(manifestPath);

  return manifest.bundles
    .flatMap((bundle) =>
      bundle.skills.map((skill) => ({
        bundle: bundle.bundle,
        id: skill.id,
        name: skill.name,
        version: skill.version,
        path: skill.relativePath
      }))
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function repairInstallState(options: { write?: boolean } = {}): Promise<RepairResult> {
  return withSkillcastLock(process.cwd(), async () => {
    const repoRoot = process.cwd();
    const skillcastDir = path.join(repoRoot, ".skillcast");
    const manifestPath = path.join(skillcastDir, "manifest.json");
    const manifest = await readManifest(manifestPath);
    const missingSkills: string[] = [];
    const orphanedSkills: string[] = [];

    const trackedPaths = new Set<string>();
    for (const bundle of manifest.bundles) {
      for (const skill of bundle.skills) {
        trackedPaths.add(toPosix(skill.relativePath));
        if (!(await fs.pathExists(path.resolve(repoRoot, skill.relativePath)))) {
          missingSkills.push(`${skill.name} (${bundle.bundle})`);
        }
      }
    }

    const installedSkillsDir = path.join(skillcastDir, "skills");
    if (await fs.pathExists(installedSkillsDir)) {
      const skillDirs = await fs.readdir(installedSkillsDir, { withFileTypes: true });
      for (const entry of skillDirs) {
        if (!entry.isDirectory()) {
          continue;
        }
        const relativeSkillPath = toPosix(path.join(".skillcast", "skills", entry.name, "SKILL.md"));
        if (!trackedPaths.has(relativeSkillPath) && await fs.pathExists(path.join(installedSkillsDir, entry.name, "SKILL.md"))) {
          orphanedSkills.push(entry.name);
        }
      }
    }

    if (options.write && missingSkills.length > 0) {
      const nextBundles = manifest.bundles
        .map((bundle) => normalizeManifestEntry({
          ...bundle,
          skills: bundle.skills.filter((skill) => trackedPaths.has(toPosix(skill.relativePath)) && fs.existsSync(path.resolve(repoRoot, skill.relativePath))),
          installedSkills: bundle.skills
            .filter((skill) => trackedPaths.has(toPosix(skill.relativePath)) && fs.existsSync(path.resolve(repoRoot, skill.relativePath)))
            .map((skill) => skill.name),
          updatedAt: new Date().toISOString()
        }))
        .filter((bundle) => bundle.skills.length > 0);

      await writeManifest(manifestPath, {
        manifestVersion: MANIFEST_VERSION,
        bundles: nextBundles
      });
    }

    return {
      manifestPath: toPosix(path.relative(repoRoot, manifestPath)),
      missingSkills: missingSkills.sort(),
      orphanedSkills: orphanedSkills.sort(),
      repaired: Boolean(options.write && missingSkills.length > 0)
    };
  });
}

if (process.argv[1] && isCliEntrypoint(process.argv[1], fileURLToPath(import.meta.url))) {
  run().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Unknown error");
    }
    process.exitCode = 1;
  });
}

async function renderInstalledSkill(
  bundle: ValidatedBundle,
  skill: ValidatedSkill,
  canonicalSkillPath: string
): Promise<string> {
  const sections: string[] = [
    `# ${skill.config.name}`,
    "",
    skill.config.description,
    "",
    "## Source",
    "",
    `- Bundle: ${bundle.config.name}@${bundle.config.version}`,
    `- Skill ID: ${skill.config.id}`,
    `- Canonical Path: ${toPosix(canonicalSkillPath)}`,
    `- Compatibility: ${skill.config.compatibility.runtimes.join(", ")}`,
    ""
  ];

  if (skill.config.inputs.length > 0) {
    sections.push("## Inputs", "");
    for (const input of skill.config.inputs) {
      sections.push(`- ${input.name}: ${input.type}${input.required ? " (required)" : ""}`);
    }
    sections.push("");
  }

  if (skill.config.outputs.length > 0) {
    sections.push("## Outputs", "");
    for (const output of skill.config.outputs) {
      sections.push(`- ${output.name}: ${output.type}`);
    }
    sections.push("");
  }

  sections.push("## Instructions", "", (await fs.readFile(skill.instructionsPath, "utf8")).trim(), "");
  return sections.join("\n");
}

function ensureUniqueSkillIdentity(skills: ValidatedSkill[], rootPath: string): void {
  const ids = new Set<string>();
  const names = new Set<string>();

  for (const skill of skills) {
    if (ids.has(skill.config.id)) {
      throw new Error(`Duplicate skill id '${skill.config.id}' in bundle ${rootPath}.`);
    }
    if (names.has(skill.config.name)) {
      throw new Error(`Duplicate skill name '${skill.config.name}' in bundle ${rootPath}.`);
    }

    ids.add(skill.config.id);
    names.add(skill.config.name);
  }
}

function findSkillRecordInBundle(entry: ManifestEntry, skillId: string, skillName: string): InstalledSkillEntry | undefined {
  return entry.skills.find((record) => record.id === skillId || record.name === skillName);
}

function findManifestSkillOwner(
  entries: ManifestEntry[],
  skillId: string,
  skillName: string
): { bundle: ManifestEntry; skill: InstalledSkillEntry } | undefined {
  for (const entry of entries) {
    const skill = entry.skills.find((record) => record.id === skillId || record.name === skillName);
    if (skill) {
      return { bundle: entry, skill };
    }
  }

  return undefined;
}

function getInstalledSkillDirectory(installedSkillsDir: string, skillName: string): string {
  return path.join(installedSkillsDir, skillName);
}

function getInstalledSkillFilePath(installedSkillsDir: string, skillName: string): string {
  return path.join(getInstalledSkillDirectory(installedSkillsDir, skillName), "SKILL.md");
}

function getInstalledSkillRelativePath(skillName: string): string {
  return toPosix(path.join(".skillcast", "skills", skillName, "SKILL.md"));
}

function uniqueSkillNames(skillNames: string[]): string[] {
  return [...new Set(skillNames)].sort((left, right) => left.localeCompare(right));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function skillRecordKey(record: Pick<InstalledSkillEntry, "id" | "name">): string {
  return `${record.id}::${record.name}`;
}

async function removeInstalledSkillByRecord(repoRoot: string, installedSkillsDir: string, record: InstalledSkillEntry): Promise<void> {
  const folderPath = path.resolve(repoRoot, path.dirname(record.relativePath));
  const expectedFolderPath = path.resolve(getInstalledSkillDirectory(installedSkillsDir, record.name));

  if (folderPath !== expectedFolderPath) {
    throw new Error(`Refusing to delete unexpected skill path for '${record.name}': ${record.relativePath}`);
  }

  await removeInstalledSkill(installedSkillsDir, record.name);
}

async function removeInstalledSkill(installedSkillsDir: string, skillName: string): Promise<void> {
  const targetPath = path.resolve(installedSkillsDir, skillName);

  if (!isPathWithin(targetPath, installedSkillsDir)) {
    throw new Error(`Refusing to delete outside Skillcast-managed paths: ${targetPath}`);
  }

  if (!(await fs.pathExists(targetPath))) {
    return;
  }

  await fs.remove(targetPath);
}

async function cleanupSkillcastDirectory(skillcastDir: string): Promise<void> {
  if (!(await fs.pathExists(skillcastDir))) {
    return;
  }

  await fs.remove(skillcastDir);
}

async function withSkillcastLock<T>(repoRoot: string, task: () => Promise<T>): Promise<T> {
  const lockPath = path.join(repoRoot, ".skillcast.lock");
  return withFileLock(lockPath, task);
}

async function withStoreLock<T>(storeRoot: string, task: () => Promise<T>): Promise<T> {
  const lockPath = path.join(storeRoot, ".skillcast-store.lock");
  return withFileLock(lockPath, task);
}

async function withFileLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  const timeoutMs = 5000;
  const retryDelayMs = 100;
  const startedAt = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      await fs.ensureDir(path.dirname(lockPath));
      await fs.writeFile(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
      acquired = true;
    } catch (error) {
      if (isAlreadyExistsError(error) && Date.now() - startedAt < timeoutMs) {
        await wait(retryDelayMs);
        continue;
      }
      throw new Error(`Could not acquire lock at ${toDisplayPath(lockPath)}.`);
    }
  }

  try {
    return await task();
  } finally {
    if (acquired) {
      await fs.remove(lockPath);
    }
  }
}

function isPathWithin(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function hashPathIfExists(filePath: string): Promise<string | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function isCliEntrypoint(argvPath: string, modulePath: string): boolean {
  const resolvedArgvPath = path.resolve(argvPath);
  const resolvedModulePath = path.resolve(modulePath);

  if (resolvedArgvPath === resolvedModulePath) {
    return true;
  }

  try {
    return fs.realpathSync(resolvedArgvPath) === fs.realpathSync(resolvedModulePath);
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
