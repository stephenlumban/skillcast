#!/usr/bin/env node
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

type ManifestEntry = {
  bundle: string;
  bundleVersion: string;
  source: string;
  sourceType: "builtin" | "path";
  installedSkills: string[];
  installedAt: string;
  skillDir: string;
};

type ResolvedBundleReference = {
  input: string;
  rootPath: string;
  referenceType: "builtin" | "path";
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
};

export type InstalledListItem = {
  bundle: string;
  bundleVersion: string;
  source: string;
  sourceType: "builtin" | "path";
  installedSkills: string[];
  installedAt: string;
  skillDir: string;
};

const MANIFEST_VERSION = 1;
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
  .description("Inspect a skill bundle")
  .action(async (bundleRef: string, options: { json?: boolean }) => {
    const payload = await inspectBundle(bundleRef);

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
  });

program
  .command("install")
  .argument("<bundleRef>", "path to bundle or built-in pack name")
  .description("Install a bundle into the current repository")
  .action(async (bundleRef: string) => {
    const result = await installBundle(bundleRef);
    console.log(`Installed ${result.name}@${result.version}`);
    console.log(`Source: ${result.source}`);
    console.log(`Skill Dir: ${result.skillDir}`);
    console.log(`Manifest: ${result.manifestPath}`);
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

  return {
    rootPath,
    bundlePath,
    config,
    skills
  };
}

async function readManifest(manifestPath: string): Promise<{ manifestVersion: number; bundles: ManifestEntry[] }> {
  if (!(await fs.pathExists(manifestPath))) {
    return {
      manifestVersion: MANIFEST_VERSION,
      bundles: []
    };
  }

  const raw = await fs.readJson(manifestPath);
  const manifest = z.object({
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
  }).parse(raw);

  return {
    manifestVersion: manifest.manifestVersion,
    bundles: manifest.bundles.map(normalizeManifestEntry)
  };
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
      console.log(`  Path: ${bundle.path || "."}`);
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
      console.log(`${bundle.bundle}@${bundle.bundleVersion}`);
      console.log(`  Installed: ${bundle.installedAt}`);
      console.log(`  Source: ${bundle.source} (${bundle.sourceType})`);
      console.log(`  Skill Dir: ${bundle.skillDir}`);
      console.log(`  Skills: ${bundle.installedSkills.join(", ")}`);
    }
    return;
  }

  if (subject === "skills") {
    const pathArg = positional[1];
    if (!pathArg) {
      throw new Error("Bundle path is required for 'list skills'.");
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
      console.log(`  Path: ${skill.path}`);
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

function normalizeManifestEntry(entry: ManifestEntry): ManifestEntry {
  if (entry.sourceType === "path" && path.basename(entry.source).toLowerCase() === "bundle.yaml") {
    return {
      ...entry,
      source: toDisplayPath(path.dirname(entry.source))
    };
  }

  return entry;
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

export async function inspectBundle(bundleRef: string): Promise<InspectPayload> {
  const resolved = await resolveBundleReference(bundleRef);
  const bundle = await validateBundleRoot(resolved.rootPath);

  return {
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
}

export async function installBundle(bundleRef: string): Promise<{
  name: string;
  version: string;
  source: string;
  skillDir: string;
  manifestPath: string;
}> {
  const resolved = await resolveBundleReference(bundleRef);
  const bundle = await validateBundleRoot(resolved.rootPath);
  const repoRoot = process.cwd();
  const skillcastDir = path.join(repoRoot, ".skillcast");
  const installedSkillsDir = path.join(skillcastDir, "skills");

  await fs.ensureDir(installedSkillsDir);
  await projectInstalledSkills(bundle, repoRoot);

  const manifestPath = path.join(skillcastDir, "manifest.json");
  const manifest = await readManifest(manifestPath);
  const entry: ManifestEntry = {
    bundle: bundle.config.name,
    bundleVersion: bundle.config.version,
    source: resolved.displaySource,
    sourceType: resolved.referenceType,
    installedSkills: bundle.skills.map((skill) => skill.config.name),
    installedAt: new Date().toISOString(),
    skillDir: toPosix(path.relative(repoRoot, installedSkillsDir))
  };

  manifest.bundles = manifest.bundles.filter((item) => item.bundle !== entry.bundle);
  manifest.bundles.push(entry);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });

  return {
    name: bundle.config.name,
    version: bundle.config.version,
    source: resolved.displaySource,
    skillDir: toPosix(path.relative(repoRoot, installedSkillsDir)),
    manifestPath: toPosix(path.relative(repoRoot, manifestPath))
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
      skillDir: bundle.skillDir
    }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Unknown error");
    }
    process.exitCode = 1;
  });
}

async function projectInstalledSkills(bundle: ValidatedBundle, repoRoot: string): Promise<void> {
  const installedSkillsDir = path.join(repoRoot, ".skillcast", "skills");

  for (const skill of bundle.skills) {
    const skillFolder = path.join(installedSkillsDir, skill.config.name);
    const canonicalSkillPath = path.join(installedSkillsDir, skill.config.name);

    await fs.ensureDir(skillFolder);
    await fs.writeFile(
      path.join(skillFolder, "SKILL.md"),
      await renderInstalledSkill(bundle, skill, canonicalSkillPath),
      "utf8"
    );
  }
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
