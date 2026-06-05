/**
 * Project Registry — persistent multi-project discovery for MCP tools.
 *
 * Scans filesystem for directories containing `.codegraph/codegraph.db` and
 * caches the results in `~/.codegraph/projects.json`. The cache persists
 * across MCP sessions so repeated server starts skip directory scanning.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { findNearestCodeGraphRoot } from '../directory';

/** A discovered project with its root path and short name. */
export interface ProjectEntry {
  rootPath: string;
  name: string;
}

/** On-disk format for the project registry cache. */
export interface ProjectRegistryData {
  version: number;
  updatedAt: string;
  scanRoots: string[];
  scanDepth: number;
  projects: ProjectEntry[];
}

/** Current schema version — bump when the format changes. */
export const REGISTRY_VERSION = 1;

/** Monorepo convention directories that merit an extra depth level. */
const MONOREPO_SUBDIRS = new Set(['packages', 'apps', 'services', 'libs', 'modules']);

/** Default scan depth when not overridden. */
const DEFAULT_SCAN_DEPTH = 3;

/** Maximum allowed scan depth to prevent runaway scans. */
const MAX_SCAN_DEPTH = 5;

/**
 * Resolve the path to `~/.codegraph/projects.json`.
 */
export function getRegistryPath(): string {
  return path.join(os.homedir(), '.codegraph', 'projects.json');
}

/**
 * Resolve the default scan depth, allowing the `CODEGRAPH_SCAN_DEPTH`
 * environment variable to override it. Clamped to [1, MAX_SCAN_DEPTH].
 */
export function getDefaultScanDepth(): number {
  const env = process.env.CODEGRAPH_SCAN_DEPTH;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && Number.isInteger(n)) {
      return Math.max(1, Math.min(n, MAX_SCAN_DEPTH));
    }
  }
  return DEFAULT_SCAN_DEPTH;
}

/**
 * Load the project registry from disk. Returns `null` if the file does not
 * exist, is unreadable, or has an incompatible version.
 */
export function loadRegistry(): ProjectRegistryData | null {
  const registryPath = getRegistryPath();
  try {
    if (!fs.existsSync(registryPath)) return null;
    const raw = fs.readFileSync(registryPath, 'utf-8');
    const data = JSON.parse(raw) as ProjectRegistryData;
    if (data.version !== REGISTRY_VERSION) return null;
    if (!Array.isArray(data.projects)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Save the project registry to disk. Uses atomic write (write to tmp then
 * rename) so a crash never leaves a corrupt file.
 */
export function saveRegistry(data: ProjectRegistryData): void {
  const registryPath = getRegistryPath();
  const dir = path.dirname(registryPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = registryPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, registryPath);
  } catch {
    // Best-effort — if we can't write the cache, the tool still works
    // (it just won't persist across sessions).
  }
}

/**
 * Delete the on-disk registry cache. Used when `refreshDiscovery` is true.
 */
export function deleteRegistry(): void {
  try {
    const registryPath = getRegistryPath();
    if (fs.existsSync(registryPath)) {
      fs.unlinkSync(registryPath);
    }
  } catch {
    // Ignore — best-effort cleanup.
  }
}

/**
 * Scan filesystem roots for CodeGraph projects.
 *
 * For each root, recursively descends up to `depth` levels looking for
 * directories that contain `.codegraph/codegraph.db`. When a monorepo
 * convention directory (`packages/`, `apps/`, etc.) is encountered, it
 * gets an extra depth level.
 *
 * @param roots  Candidate root directories to scan from.
 * @param depth  Maximum recursion depth (1-5, default 3).
 * @returns Discovered project entries.
 */
export function scanForProjects(roots: string[], depth?: number): ProjectEntry[] {
  const maxDepth = clampDepth(depth ?? getDefaultScanDepth());
  const seen = new Set<string>();
  const projects: ProjectEntry[] = [];

  function scan(dir: string, currentDepth: number): void {
    if (currentDepth > maxDepth + 1) return;
    if (seen.has(dir)) return;
    seen.add(dir);

    // Check if this directory itself is a project
    const root = findNearestCodeGraphRoot(dir);
    if (root && !projects.some(p => p.rootPath === root)) {
      projects.push({ rootPath: root, name: path.basename(root) });
    }

    // Don't recurse further from a project root — its children won't be
    // separate projects (they share the same .codegraph/).
    if (root === path.resolve(dir)) return;

    if (currentDepth > maxDepth) return;

    // Scan children
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission error — skip.
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const childPath = path.join(dir, entry.name);

      if (MONOREPO_SUBDIRS.has(entry.name)) {
        // Monorepo convention dir: scan with an extra depth budget
        scan(childPath, currentDepth);
      } else {
        scan(childPath, currentDepth + 1);
      }
    }
  }

  for (const root of roots) {
    try {
      const resolved = path.resolve(root);
      if (fs.existsSync(resolved)) {
        scan(resolved, 1);
      }
    } catch {
      // Skip unresolvable roots.
    }
  }

  return projects;
}

/**
 * Check whether a cached registry is still valid for the current set of
 * workspace roots and desired scan depth.
 */
export function isCacheValid(
  cached: ProjectRegistryData,
  currentRoots: string[],
  desiredDepth: number
): boolean {
  // Version check already done by loadRegistry, but be defensive.
  if (cached.version !== REGISTRY_VERSION) return false;

  // The cached roots must be a superset of current roots.
  const cachedSet = new Set(cached.scanRoots);
  for (const root of currentRoots) {
    if (!cachedSet.has(root)) return false;
  }

  // The cached depth must be >= desired depth.
  if (cached.scanDepth < desiredDepth) return false;

  return true;
}

function clampDepth(d: number): number {
  return Math.max(1, Math.min(d, MAX_SCAN_DEPTH));
}

/**
 * Maximum projects to search in a single multi_search call.
 */
export const MAX_MULTI_SEARCH_PROJECTS = 10;

/**
 * Default result limit per project for multi_search.
 */
export const DEFAULT_MULTI_SEARCH_LIMIT = 5;

/**
 * Maximum output for multi_search (characters).
 */
export const MAX_MULTI_SEARCH_OUTPUT = 15000;

/**
 * Maximum length for path-like string inputs.
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * Encapsulates multi-search state and logic, keeping the footprint in
 * ToolHandler minimal. Only instantiated when workspace roots are provided.
 */
export class MultiSearchState {
  private projectRegistry: Map<string, ProjectEntry> = new Map();
  private registryPopulated = false;
  private workspaceRoots: string[] = [];

  /** Set workspace roots from MCP client (roots/list + workspaceFolders). */
  setWorkspaceRoots(roots: string[]): void {
    this.workspaceRoots = roots;
  }

  /** Get the current workspace roots. */
  getWorkspaceRoots(): string[] {
    return this.workspaceRoots;
  }

  /** Reset all state (called on close). */
  reset(): void {
    this.projectRegistry.clear();
    this.registryPopulated = false;
    this.workspaceRoots = [];
  }

  /**
   * Ensure the project registry is populated. Tries the on-disk cache first;
   * falls back to scanning the filesystem.
   */
  ensureProjectRegistry(
    scanDepth?: number,
    defaultProjectHint?: string | null,
  ): void {
    if (this.registryPopulated) return;

    const desiredDepth = scanDepth ?? getDefaultScanDepth();
    const scanRoots = this.workspaceRoots.length > 0
      ? this.workspaceRoots
      : [defaultProjectHint ?? process.cwd()];

    const cached = loadRegistry();
    if (cached && isCacheValid(cached, scanRoots, desiredDepth)) {
      for (const p of cached.projects) {
        this.projectRegistry.set(p.rootPath, p);
      }
      this.registryPopulated = true;
      return;
    }

    const projects = scanForProjects(scanRoots, desiredDepth);
    for (const p of projects) {
      this.projectRegistry.set(p.rootPath, p);
    }

    saveRegistry({
      version: REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      scanRoots,
      scanDepth: desiredDepth,
      projects,
    });

    this.registryPopulated = true;
  }

  /**
   * Resolve a project specifier (name or path) to registry entries.
   * Names are matched case-insensitively against directory basenames.
   * Absolute paths match directly.
   */
  resolveProjects(specifier: string): ProjectEntry[] {
    if (specifier.startsWith('/')) {
      const root = findNearestCodeGraphRoot(specifier);
      if (root) {
        return [{ rootPath: root, name: path.basename(root) }];
      }
      for (const entry of this.projectRegistry.values()) {
        if (entry.rootPath === specifier || entry.rootPath.startsWith(specifier + '/')) {
          return [entry];
        }
      }
      return [];
    }

    const lower = specifier.toLowerCase();
    const matches: ProjectEntry[] = [];
    for (const entry of this.projectRegistry.values()) {
      if (entry.name.toLowerCase() === lower) {
        matches.push(entry);
      }
    }
    return matches;
  }

  /**
   * Execute codegraph_multi_search — concurrent search across multiple projects.
   *
   * @param args - Tool arguments (query, projects, kind, limitPerProject, refreshDiscovery, scanDepth)
   * @param getCodeGraph - Function to get a CodeGraph instance for a given project path
   * @param defaultProjectHint - The directory the server resolved its default project from
   */
  async execute(
    args: Record<string, unknown>,
    getCodeGraph: (projectPath: string) => import('../index').default,
    defaultProjectHint: string | null,
  ): Promise<import('./tools').ToolResult> {
    const query = validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const kind = args.kind as string | undefined;
    const limitPerProject = clampVal(
      Number(args.limitPerProject) || DEFAULT_MULTI_SEARCH_LIMIT,
      1, 20,
    );
    const refreshDiscovery = args.refreshDiscovery === true;
    const scanDepth = clampVal(
      Number(args.scanDepth) || getDefaultScanDepth(),
      1, 5,
    );

    if (refreshDiscovery) {
      this.projectRegistry.clear();
      this.registryPopulated = false;
      deleteRegistry();
      this.ensureProjectRegistry(scanDepth, defaultProjectHint);
    } else {
      this.ensureProjectRegistry(undefined, defaultProjectHint);
    }

    // Resolve which projects to search
    const projectsArg = args.projects as string[] | undefined;
    let entries: ProjectEntry[];
    if (!projectsArg || projectsArg.length === 0 ||
        (projectsArg.length === 1 && projectsArg[0] === 'all')) {
      entries = [...this.projectRegistry.values()];
    } else {
      entries = [];
      for (const spec of projectsArg) {
        const v = validateString(spec, 'projects[]', MAX_PATH_LENGTH);
        if (typeof v !== 'string') return v;
        const resolved = this.resolveProjects(v);
        entries.push(...resolved);
      }
      const seen = new Set<string>();
      entries = entries.filter(e => {
        if (seen.has(e.rootPath)) return false;
        seen.add(e.rootPath);
        return true;
      });
    }

    if (entries.length === 0) {
      return textResult(
        'No indexed projects found. Ensure workspace folders contain ' +
        'projects with .codegraph/ initialized, or pass explicit project paths.',
      );
    }

    const searched = entries.slice(0, MAX_MULTI_SEARCH_PROJECTS);
    const skipped = entries.slice(MAX_MULTI_SEARCH_PROJECTS);

    const sections: string[] = [];
    let totalResults = 0;

    for (const entry of searched) {
      try {
        const cg = getCodeGraph(entry.rootPath);
        const searchResults = cg.searchNodes(query, {
          limit: limitPerProject,
          kinds: kind ? [kind as import('../types').NodeKind] : undefined,
        });
        const ranked = [...searchResults].sort((a, b) => {
          const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
          const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
          return aGen - bGen;
        }).slice(0, limitPerProject);

        totalResults += ranked.length;
        if (ranked.length === 0) {
          sections.push(`### ${entry.name} (${entry.rootPath})\n  No results.`);
        } else {
          const lines = ranked.map(r =>
            `  - ${r.node.name} (${r.node.kind}) — ${r.node.filePath}:${r.node.startLine}`
          );
          sections.push(`### ${entry.name} (${entry.rootPath})\n${lines.join('\n')}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sections.push(`### ${entry.name} (${entry.rootPath})\n  ⚠ Error: ${msg}`);
      }
    }

    let output = `## Multi-Project Search: "${query}" (${searched.length} projects, ${totalResults} results)\n\n`;
    output += sections.join('\n\n');

    if (skipped.length > 0) {
      output += `\n\n⚠ ${skipped.length} project(s) skipped (max ${MAX_MULTI_SEARCH_PROJECTS}): ${skipped.map(e => e.name).join(', ')}`;
    }

    output += '\n\n---\nSearched ' + searched.length + ' projects. Use codegraph_explore with projectPath for deeper results in a specific project.';

    return textResult(truncateOutput(output, MAX_MULTI_SEARCH_OUTPUT));
  }
}

// --- Internal helpers (kept local to this module) ---

function clampVal(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(n, max));
}

function validateString(
  value: unknown,
  name: string,
  maxLength: number = 10_000,
): string | import('./tools').ToolResult {
  if (typeof value !== 'string' || value.length === 0) {
    return errorResult(`${name} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    return errorResult(
      `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
    );
  }
  return value;
}

function truncateOutput(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastNewline = truncated.lastIndexOf('\n');
  return (lastNewline > maxLength * 0.5 ? truncated.slice(0, lastNewline) : truncated) +
    '\n\n... (output truncated)';
}

function textResult(text: string): import('./tools').ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): import('./tools').ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// Lazy import to avoid circular dependency at module load time.
// isGeneratedFile is only needed when multi_search actually runs.
let _isGeneratedFile: typeof import('../extraction/generated-detection').isGeneratedFile | null = null;
function isGeneratedFile(filePath: string): boolean {
  if (!_isGeneratedFile) {
    _isGeneratedFile = (require('../extraction/generated-detection') as typeof import('../extraction/generated-detection')).isGeneratedFile;
  }
  return _isGeneratedFile(filePath);
}
