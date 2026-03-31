#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Command } from "commander";
import fs from "fs-extra";
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

type SourceType = "builtin" | "path";
type DiffStatus = "new" | "unchanged" | "source-changed" | "local-modified" | "conflict" | "removed" | "missing";

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
    sourceType: SourceType;
  };
};

type ManifestEntry = {
  bundle: string;
  bundleVersion: string;
  source: string;
  sourceType: SourceType;
  installedSkills: string[];
  installedAt: string;
  updatedAt: string;
  skillDir: string;
  skills: InstalledSkillEntry[];
};

type ManifestData = {
  manifestVersion: number;
  bundles: ManifestEntry[];
};

type ResolvedBundleReference = {
  input: string;
  rootPath: string;
  referenceType: SourceType;
  displaySource: string;
};

type CatalogEntry = {
  name: string;
  path: string;
  description: string;
  category: string;
  tags: string[];
  featured: boolean;
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
  sourceType: SourceType;
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
  skillDir: string;
  manifestPath: string;
  changedSkills: string[];
  removedSkills: string[];
  warnings: string[];
  dryRun: boolean;
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

export type RepairResult = {
  manifestPath: string;
  missingSkills: string[];
  orphanedSkills: string[];
  repaired: boolean;
};

const MANIFEST_VERSION = 2;
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
    sourceType: z.enum(["builtin", "path"]).default("path")
  })
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

program
  .name("skillcast")
  .description("CLI for reusable agent skill bundles")
  .version("0.1.0");

program
  .command("validate")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .description("Validate a skill bundle")
  .action(async (bundleRef: string) => {
    const bundle = await validateBundle(bundleRef);
    console.log(`Bundle ${bundle.config.name}@${bundle.config.version} is valid.`);
    console.log(`Skills: ${bundle.skills.map((skill) => skill.config.name).join(", ")}`);
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
    const bundleName = path.basename(resolvedTarget);
    const skillName = "example-skill";
    const skillDir = path.join(resolvedTarget, "skills", skillName);

    await fs.ensureDir(skillDir);

    const bundleYaml = YAML.stringify({
      name: bundleName,
      version: "0.1.0",
      description: "Describe this bundle",
      skills: [
        {
          name: skillName,
          path: `./skills/${skillName}`
        }
      ],
      targets: ["generic-agent"]
    });

    const skillYaml = YAML.stringify({
      id: `org.example.${bundleName}.${skillName}`,
      name: skillName,
      version: "0.1.0",
      description: "Describe this skill",
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
        runtimes: ["generic-agent"]
      }
    });

    const instructions = [
      "You are a reusable skill.",
      "",
      "Define the behavior, constraints, and output contract here."
    ].join("\n");

    await fs.writeFile(path.join(resolvedTarget, "bundle.yaml"), bundleYaml, "utf8");
    await fs.writeFile(path.join(skillDir, "skill.yaml"), skillYaml, "utf8");
    await fs.writeFile(path.join(skillDir, "instructions.md"), instructions, "utf8");

    console.log(`Initialized bundle scaffold at ${resolvedTarget}`);
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

  const manifest = manifestV2Schema.parse(raw);

  return {
    manifestVersion: MANIFEST_VERSION,
    bundles: sortManifestEntries(manifest.bundles.map((entry) => normalizeManifestEntry({
      ...entry,
      source: normalizeSourceDisplay(entry.source, entry.sourceType)
    })))
  };
}

async function writeManifest(manifestPath: string, manifest: ManifestData): Promise<void> {
  if (manifest.bundles.length === 0) {
    await cleanupSkillcastDirectory(path.dirname(manifestPath));
    return;
  }

  const manifestDir = path.dirname(manifestPath);
  const tmpManifestPath = path.join(manifestDir, `manifest.${process.pid}.${Date.now()}.tmp`);
  await fs.ensureDir(manifestDir);
  await fs.writeJson(tmpManifestPath, {
    manifestVersion: MANIFEST_VERSION,
    bundles: sortManifestEntries(manifest.bundles.map(normalizeManifestEntry))
  }, { spaces: 2 });
  await fs.move(tmpManifestPath, manifestPath, { overwrite: true });
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
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
  return validateBundleRoot(resolved.rootPath);
}

async function resolveBundleReference(bundleRef: string): Promise<ResolvedBundleReference> {
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

  const explicitRoot = path.resolve(process.cwd(), bundleRef);
  if (await fs.pathExists(path.join(explicitRoot, "bundle.yaml"))) {
    return {
      input: bundleRef,
      rootPath: explicitRoot,
      referenceType: "path",
      displaySource: toDisplayPath(explicitRoot)
    };
  }

  throw new Error(
    `Bundle '${bundleRef}' was not found as a built-in pack or bundle path.`
  );
}

function normalizeSourceDisplay(source: string, sourceType: SourceType): string {
  if (sourceType === "path" && path.basename(source).toLowerCase() === "bundle.yaml") {
    return toDisplayPath(path.dirname(source));
  }

  return source;
}

function normalizeManifestEntry(entry: ManifestEntry): ManifestEntry {
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
    skills
  };
}

function sortManifestEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return entries
    .slice()
    .sort((left, right) => left.bundle.localeCompare(right.bundle));
}

async function listPacks(searchRoot: string, preferCatalog: boolean): Promise<PackListItem[]> {
  const catalog = preferCatalog ? await readBuiltInCatalog(searchRoot) : [];

  if (catalog.length > 0) {
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

export async function validateBundle(bundleRef: string): Promise<ValidatedBundle> {
  return resolveAndValidateBundle(bundleRef);
}

export async function inspectBundle(bundleRef: string, options: { installed?: boolean } = {}): Promise<InspectPayload> {
  const resolved = await resolveBundleReference(bundleRef);
  const bundle = await validateBundleRoot(resolved.rootPath);

  const payload: InspectPayload = {
    name: bundle.config.name,
    version: bundle.config.version,
    description: bundle.config.description,
    source: resolved.displaySource,
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
}

export async function diffBundle(bundleRef: string): Promise<DiffPayload> {
  const resolved = await resolveBundleReference(bundleRef);
  const bundle = await validateBundleRoot(resolved.rootPath);
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
  return withSkillcastLock(process.cwd(), async () => installBundleUnlocked(bundleRef, options));
}

async function installBundleUnlocked(bundleRef: string, options: InstallOptions = {}): Promise<InstallResult> {
  const resolved = await resolveBundleReference(bundleRef);
  const bundle = await validateBundleRoot(resolved.rootPath);
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
    throw new Error(`Bundle '${bundle.config.name}' is already installed. Use 'skillcast install ${bundleRef} --update' to refresh it.`);
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
      skills: desiredRecords
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
  const resolved = await resolveBundleReference(bundleRef);
  const bundle = await validateBundleRoot(resolved.rootPath);
  return {
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
  };
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
  const timeoutMs = 5000;
  const retryDelayMs = 100;
  const startedAt = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      await fs.ensureDir(repoRoot);
      await fs.writeFile(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
      acquired = true;
    } catch (error) {
      if (isAlreadyExistsError(error) && Date.now() - startedAt < timeoutMs) {
        await wait(retryDelayMs);
        continue;
      }
      throw new Error(`Could not acquire Skillcast lock at ${toDisplayPath(lockPath)}.`);
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
