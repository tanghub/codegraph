/**
 * Tests for codegraph_multi_search and the project-registry module.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite');
import {
  scanForProjects,
  loadRegistry,
  saveRegistry,
  deleteRegistry,
  isCacheValid,
  getDefaultScanDepth,
  getRegistryPath,
  MultiSearchState,
  type ProjectEntry,
  type ProjectRegistryData,
  REGISTRY_VERSION,
} from '../src/mcp/project-registry';
import { ToolHandler } from '../src/mcp/tools';

// ---------------------------------------------------------------------------
// project-registry module
// ---------------------------------------------------------------------------

describe('project-registry', () => {
  const tmpDir = path.join(os.tmpdir(), `codegraph-test-registry-${Date.now()}`);
  const originalHome = process.env.HOME;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Point the registry to a temp home so we don't clobber the user's cache
    process.env.HOME = tmpDir;
    // Clean up any leftover registry
    try { fs.unlinkSync(getRegistryPath()); } catch { /* ok */ }
    try { fs.rmSync(path.join(tmpDir, '.codegraph'), { recursive: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  });

  /**
   * Create a fake .codegraph/codegraph.db in the given directory. Since 1.6.x
   * `isInitialized()` probes the file with SQLite and requires the codegraph
   * schema (a `nodes` table) — an empty file no longer counts.
   */
  function createFakeProject(dir: string): void {
    const codegraphDir = path.join(dir, '.codegraph');
    fs.mkdirSync(codegraphDir, { recursive: true });
    const db = new DatabaseSync(path.join(codegraphDir, 'codegraph.db'));
    db.exec('CREATE TABLE nodes(id TEXT PRIMARY KEY);');
    db.close();
  }

  describe('scanForProjects', () => {
    it('discovers projects at depth 1', () => {
      const projA = path.join(tmpDir, 'proj-a');
      const projB = path.join(tmpDir, 'proj-b');
      fs.mkdirSync(projA, { recursive: true });
      fs.mkdirSync(projB, { recursive: true });
      createFakeProject(projA);
      createFakeProject(projB);

      const results = scanForProjects([tmpDir], 1);
      const names = results.map(r => r.name).sort();
      expect(names).toContain('proj-a');
      expect(names).toContain('proj-b');
    });

    it('discovers projects under monorepo convention dirs', () => {
      const packagesDir = path.join(tmpDir, 'packages');
      const projA = path.join(packagesDir, 'proj-a');
      fs.mkdirSync(projA, { recursive: true });
      createFakeProject(projA);

      const results = scanForProjects([tmpDir], 1);
      const names = results.map(r => r.name);
      expect(names).toContain('proj-a');
    });

    it('respects scan depth', () => {
      const deep = path.join(tmpDir, 'level1', 'level2', 'proj-deep');
      fs.mkdirSync(deep, { recursive: true });
      createFakeProject(deep);

      // depth 2 should NOT find it (it's 3 levels down from the root)
      const shallow = scanForProjects([tmpDir], 2);
      expect(shallow.map(r => r.name)).not.toContain('proj-deep');

      // depth 3 SHOULD find it
      const deepResults = scanForProjects([tmpDir], 3);
      expect(deepResults.map(r => r.name)).toContain('proj-deep');
    });

    it('skips dot-directories', () => {
      const hidden = path.join(tmpDir, '.hidden-proj');
      fs.mkdirSync(hidden, { recursive: true });
      createFakeProject(hidden);

      const results = scanForProjects([tmpDir], 2);
      expect(results.map(r => r.name)).not.toContain('.hidden-proj');
    });

    it('handles non-existent roots gracefully', () => {
      const results = scanForProjects(['/nonexistent/path/12345'], 2);
      expect(results).toEqual([]);
    });

    it('deduplicates when the same project is reachable from multiple roots', () => {
      const proj = path.join(tmpDir, 'shared-proj');
      fs.mkdirSync(proj, { recursive: true });
      createFakeProject(proj);

      const results = scanForProjects([tmpDir, tmpDir], 2);
      const matching = results.filter(r => r.name === 'shared-proj');
      expect(matching.length).toBe(1);
    });
  });

  describe('disk cache', () => {
    it('saves and loads a registry', () => {
      const data: ProjectRegistryData = {
        version: REGISTRY_VERSION,
        updatedAt: new Date().toISOString(),
        scanRoots: ['/tmp'],
        scanDepth: 3,
        projects: [
          { rootPath: '/tmp/proj-a', name: 'proj-a' },
        ],
      };
      saveRegistry(data);
      const loaded = loadRegistry();
      expect(loaded).not.toBeNull();
      expect(loaded!.projects).toEqual(data.projects);
      expect(loaded!.scanDepth).toBe(3);
    });

    it('returns null for missing registry', () => {
      expect(loadRegistry()).toBeNull();
    });

    it('returns null for wrong version', () => {
      const data: ProjectRegistryData = {
        version: 999,
        updatedAt: new Date().toISOString(),
        scanRoots: [],
        scanDepth: 3,
        projects: [],
      };
      saveRegistry(data);
      expect(loadRegistry()).toBeNull();
    });

    it('deletes the registry', () => {
      saveRegistry({
        version: REGISTRY_VERSION,
        updatedAt: new Date().toISOString(),
        scanRoots: [],
        scanDepth: 3,
        projects: [],
      });
      expect(loadRegistry()).not.toBeNull();
      deleteRegistry();
      expect(loadRegistry()).toBeNull();
    });
  });

  describe('isCacheValid', () => {
    it('is valid when roots match and depth is sufficient', () => {
      const cached: ProjectRegistryData = {
        version: REGISTRY_VERSION,
        updatedAt: '',
        scanRoots: ['/a', '/b'],
        scanDepth: 5,
        projects: [],
      };
      expect(isCacheValid(cached, ['/a', '/b'], 3)).toBe(true);
      expect(isCacheValid(cached, ['/a'], 5)).toBe(true);
    });

    it('is invalid when roots are missing', () => {
      const cached: ProjectRegistryData = {
        version: REGISTRY_VERSION,
        updatedAt: '',
        scanRoots: ['/a'],
        scanDepth: 3,
        projects: [],
      };
      expect(isCacheValid(cached, ['/a', '/b'], 3)).toBe(false);
    });

    it('is invalid when depth is insufficient', () => {
      const cached: ProjectRegistryData = {
        version: REGISTRY_VERSION,
        updatedAt: '',
        scanRoots: ['/a'],
        scanDepth: 2,
        projects: [],
      };
      expect(isCacheValid(cached, ['/a'], 3)).toBe(false);
    });
  });

  describe('getDefaultScanDepth', () => {
    it('returns 3 by default', () => {
      delete process.env.CODEGRAPH_SCAN_DEPTH;
      expect(getDefaultScanDepth()).toBe(3);
    });

    it('reads from env var', () => {
      process.env.CODEGRAPH_SCAN_DEPTH = '4';
      expect(getDefaultScanDepth()).toBe(4);
      delete process.env.CODEGRAPH_SCAN_DEPTH;
    });

    it('clamps to [1, 5]', () => {
      process.env.CODEGRAPH_SCAN_DEPTH = '0';
      expect(getDefaultScanDepth()).toBe(1);
      process.env.CODEGRAPH_SCAN_DEPTH = '10';
      expect(getDefaultScanDepth()).toBe(5);
      delete process.env.CODEGRAPH_SCAN_DEPTH;
    });
  });
});

// ---------------------------------------------------------------------------
// MultiSearchState
// ---------------------------------------------------------------------------

describe('MultiSearchState', () => {
  const originalHome = process.env.HOME;
  const tmpDir = path.join(os.tmpdir(), `codegraph-test-mss-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    try { fs.rmSync(path.join(tmpDir, '.codegraph'), { recursive: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.CODEGRAPH_SCAN_DEPTH;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  });

  it('setWorkspaceRoots and getWorkspaceRoots', () => {
    const state = new MultiSearchState();
    expect(state.getWorkspaceRoots()).toEqual([]);
    state.setWorkspaceRoots(['/a', '/b']);
    expect(state.getWorkspaceRoots()).toEqual(['/a', '/b']);
  });

  it('reset clears all state', () => {
    const state = new MultiSearchState();
    state.setWorkspaceRoots(['/a']);
    state.reset();
    expect(state.getWorkspaceRoots()).toEqual([]);
  });

  it('returns no-projects message when nothing is indexed', async () => {
    const state = new MultiSearchState();
    state.setWorkspaceRoots([tmpDir]);
    const result = await state.execute(
      { query: 'test' },
      () => { throw new Error('should not be called'); },
      null,
    );
    expect(result.content[0].text).toMatch(/No indexed projects found/);
  });

  it('validates query is a non-empty string', async () => {
    const state = new MultiSearchState();
    state.setWorkspaceRoots([tmpDir]);
    const result = await state.execute(
      { query: '' },
      () => { throw new Error('should not be called'); },
      null,
    );
    expect(result.isError).toBe(true);
  });

  it('validates projects[] entries are strings', async () => {
    const state = new MultiSearchState();
    state.setWorkspaceRoots([tmpDir]);
    const result = await state.execute(
      { query: 'test', projects: [123] },
      () => { throw new Error('should not be called'); },
      null,
    );
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolHandler codegraph_multi_search integration
// ---------------------------------------------------------------------------

describe('ToolHandler codegraph_multi_search', () => {
  const originalHome = process.env.HOME;
  const tmpDir = path.join(os.tmpdir(), `codegraph-test-multi-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.HOME = tmpDir;
    try { fs.rmSync(path.join(tmpDir, '.codegraph'), { recursive: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    delete process.env.CODEGRAPH_SCAN_DEPTH;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
  });

  it('returns no-projects message when nothing is indexed', async () => {
    const handler = new ToolHandler(null);
    handler.setWorkspaceRoots([tmpDir]);
    const result = await handler.execute('codegraph_multi_search', { query: 'test' });
    expect(result.content[0].text).toMatch(/No indexed projects found/);
  });

  it('returns error when no workspace roots configured', async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_multi_search', { query: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No workspace roots configured/);
  });

  it('is rejected by the allowlist when not included', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = 'search';
    const handler = new ToolHandler(null);
    const result = await handler.execute('codegraph_multi_search', { query: 'test' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/disabled via CODEGRAPH_MCP_TOOLS/);
    delete process.env.CODEGRAPH_MCP_TOOLS;
  });

  it('is not in the default tool surface but appears when allowlisted', () => {
    // The default tool surface was pared down to codegraph_explore alone (#818,
    // f82a662), so multi_search is not exposed by default — but it must remain
    // reachable when an operator opts in via CODEGRAPH_MCP_TOOLS.
    delete process.env.CODEGRAPH_MCP_TOOLS;
    const handler = new ToolHandler(null);
    expect(handler.getTools().map(t => t.name)).not.toContain('codegraph_multi_search');

    process.env.CODEGRAPH_MCP_TOOLS = 'multi_search';
    const allowlisted = new ToolHandler(null).getTools().map(t => t.name);
    expect(allowlisted).toContain('codegraph_multi_search');
    delete process.env.CODEGRAPH_MCP_TOOLS;
  });

  it('validates query is a non-empty string', async () => {
    const handler = new ToolHandler(null);
    handler.setWorkspaceRoots([tmpDir]);
    const result = await handler.execute('codegraph_multi_search', { query: '' });
    expect(result.isError).toBe(true);
  });

  it('validates projects[] entries are strings', async () => {
    const handler = new ToolHandler(null);
    handler.setWorkspaceRoots([tmpDir]);
    const result = await handler.execute('codegraph_multi_search', {
      query: 'test',
      projects: [123],
    });
    expect(result.isError).toBe(true);
  });
});
