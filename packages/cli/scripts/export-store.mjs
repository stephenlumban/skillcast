import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const defaultSourceDir = path.join(repoRoot, "examples", "bundles");
const defaultOutputDir = path.join(repoRoot, ".bundle-store-export");

const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(repoRoot, args.source ?? defaultSourceDir);
const outputDir = path.resolve(repoRoot, args.output ?? defaultOutputDir);

const bundleRoots = await resolveBundleRoots(sourceDir);
const exportedBundles = [];

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(path.join(outputDir, "bundles"), { recursive: true });

for (const bundleRoot of bundleRoots) {
  const bundlePath = path.join(bundleRoot, "bundle.yaml");
  const bundleDocument = YAML.parse(await fs.readFile(bundlePath, "utf8"));
  const bundle = validateBundleShape(bundleDocument, bundlePath);
  const versionRoot = path.join(outputDir, "bundles", bundle.name, bundle.version);

  await fs.mkdir(versionRoot, { recursive: true });
  await fs.cp(bundleRoot, versionRoot, { recursive: true });

  exportedBundles.push({
    name: bundle.name,
    version: bundle.version,
    description: bundle.description
  });
}

const catalog = buildCatalog(exportedBundles);
await fs.writeFile(
  path.join(outputDir, "catalog.json"),
  `${JSON.stringify(catalog, null, 2)}\n`,
  "utf8"
);

console.log(`Exported ${exportedBundles.length} bundle version(s) to ${outputDir}`);
console.log(`Catalog: ${path.join(outputDir, "catalog.json")}`);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      parsed.source = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--output") {
      parsed.output = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument '${arg}'. Supported flags: --source, --output.`);
  }

  return parsed;
}

async function resolveBundleRoots(sourceDir) {
  const catalogPath = path.join(sourceDir, "catalog.json");
  if (await pathExists(catalogPath)) {
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
    const packs = Array.isArray(catalog.packs) ? catalog.packs : [];
    return packs.map((pack) => path.resolve(sourceDir, pack.path));
  }

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const bundleRoot = path.join(sourceDir, entry.name);
    if (await pathExists(path.join(bundleRoot, "bundle.yaml"))) {
      roots.push(bundleRoot);
    }
  }

  roots.sort((left, right) => left.localeCompare(right));
  return roots;
}

function validateBundleShape(bundle, bundlePath) {
  if (!bundle || typeof bundle !== "object") {
    throw new Error(`Invalid bundle.yaml at ${bundlePath}`);
  }
  if (typeof bundle.name !== "string" || bundle.name.length === 0) {
    throw new Error(`Bundle at ${bundlePath} is missing 'name'.`);
  }
  if (typeof bundle.version !== "string" || bundle.version.length === 0) {
    throw new Error(`Bundle '${bundle.name}' is missing 'version'.`);
  }
  if (typeof bundle.description !== "string" || bundle.description.length === 0) {
    throw new Error(`Bundle '${bundle.name}' is missing 'description'.`);
  }

  return {
    name: bundle.name,
    version: bundle.version,
    description: bundle.description
  };
}

function buildCatalog(bundles) {
  const grouped = new Map();

  for (const bundle of bundles) {
    const existing = grouped.get(bundle.name) ?? {
      name: bundle.name,
      description: bundle.description,
      versions: []
    };
    existing.description = bundle.description;
    existing.versions.push(bundle.version);
    grouped.set(bundle.name, existing);
  }

  const catalogBundles = [...grouped.values()]
    .map((bundle) => {
      const versions = [...new Set(bundle.versions)].sort(compareVersions);
      return {
        name: bundle.name,
        description: bundle.description,
        latestVersion: versions[versions.length - 1],
        versions
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    catalogVersion: 1,
    bundles: catalogBundles
  };
}

function compareVersions(left, right) {
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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
