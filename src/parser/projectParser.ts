/**
 * Multi-file project support.
 *
 * A real AUTOSAR project is never one file: component types, interfaces and
 * compositions live in separate ARXML files (or in per-ECU extracts), and
 * references between them are absolute AUTOSAR paths. This module parses a
 * set of files independently and then *merges* them into a single model:
 *
 *   1. parse each file (independent, so one broken file cannot sink the rest)
 *   2. merge definitions by their AUTOSAR path, first definition wins and
 *      duplicates are reported as issues (same name in two packages is legal,
 *      the same full path twice is not)
 *   3. resolve cross-file references: port interfaces, component type refs of
 *      composition prototypes, connector endpoints
 *   4. report dangling references so the user sees real project breakage
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArxml } from './arxmlParser';
import {
  ArxmlDocument,
  ArxmlProject,
  CompositionInfo,
  ConnectorInfo,
  InterfaceInfo,
  PortInfo,
  ProjectFileInfo,
  ProjectIssue,
  SwcInfo,
} from './model';

export interface ProjectParseOptions {
  excludePattern?: RegExp;
  /** Max bytes per file; larger files are still parsed but flagged. */
  onFileProgress?: (done: number, total: number, file: string) => void;
}

/** Recursively collects .arxml files below the given directories. */
export async function collectArxmlFiles(roots: string[], ignoreGlobs: string[] = []): Promise<string[]> {
  const out: string[] = [];
  const ignore = ignoreGlobs.map((g) => globToRegExp(g));

  const walk = async (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (ignore.some((re) => re.test(full.replace(/\\/g, '/')))) continue;
      if (e.isDirectory()) {
        if (['node_modules', '.git', 'out', 'dist'].includes(e.name)) continue;
        await walk(full, depth + 1);
      } else if (/\.arxml$/i.test(e.name)) {
        out.push(full);
      }
    }
  };

  for (const root of roots) {
    let st: fs.Stats | undefined;
    try {
      st = await fs.promises.stat(root);
    } catch {
      continue;
    }
    if (st.isDirectory()) await walk(root, 0);
    else if (/\.arxml$/i.test(root)) out.push(root);
  }
  return Array.from(new Set(out)).sort();
}

/** Minimal glob -> regexp (supports **, *, ?), enough for ignore patterns. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re);
}

/** Parses many ARXML files and merges them into one project model. */
export async function parseArxmlProject(
  files: string[],
  options: ProjectParseOptions = {}
): Promise<ArxmlProject> {
  const t0 = Date.now();
  const issues: ProjectIssue[] = [];
  const parsed: Array<{ file: string; doc: ArxmlDocument }> = [];
  const fileInfos: ProjectFileInfo[] = [];

  // ---- 1. parse every file independently --------------------------------
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    options.onFileProgress?.(i, files.length, file);
    const name = path.basename(file);
    try {
      const text = await fs.promises.readFile(file, 'utf8');
      if (!text.trim()) {
        fileInfos.push(emptyFileInfo(file, 0));
        issues.push({ severity: 'warning', code: 'EMPTY_FILE', message: `${name} is empty`, files: [file] });
        continue;
      }
      const doc = parseArxml(text, file, { excludePattern: options.excludePattern });
      parsed.push({ file, doc });
      fileInfos.push({
        path: file,
        name,
        schemaVersion: doc.schemaVersion,
        swcCount: doc.swcs.length,
        portCount: doc.swcs.reduce((n, s) => n + s.ports.length, 0),
        connectorCount: doc.connectors.length,
        interfaceCount: doc.interfaces.size,
        elements: doc.stats.elements,
        elapsedMs: doc.stats.elapsedMs,
      });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      fileInfos.push({ ...emptyFileInfo(file, 0), error: message });
      issues.push({ severity: 'error', code: 'PARSE_ERROR', message: `${name}: ${message}`, files: [file] });
    }
  }

  // ---- 2. merge ---------------------------------------------------------
  const merged = mergeDocuments(parsed, issues);

  // ---- 3. cross-file reference resolution -------------------------------
  const dangling = resolveCrossFileReferences(merged);
  for (const d of dangling) issues.push(d);

  // ---- 4. dangling connector endpoints ----------------------------------
  for (const issue of checkConnectorEndpoints(merged)) issues.push(issue);

  return {
    files: fileInfos,
    merged,
    issues,
    stats: {
      fileCount: files.length,
      failedFiles: fileInfos.filter((f) => f.error).length,
      elapsedMs: Date.now() - t0,
    },
  };
}

function emptyFileInfo(file: string, _n: number): ProjectFileInfo {
  return {
    path: file,
    name: path.basename(file),
    schemaVersion: '',
    swcCount: 0,
    portCount: 0,
    connectorCount: 0,
    interfaceCount: 0,
    elements: 0,
    elapsedMs: 0,
  };
}

/**
 * Merges per-file documents. Definitions are keyed by their full AUTOSAR path
 * so that legitimate same-name-in-different-package cases stay distinct,
 * while genuine redefinitions are detected.
 */
function mergeDocuments(
  parsed: Array<{ file: string; doc: ArxmlDocument }>,
  issues: ProjectIssue[]
): ArxmlDocument {
  const merged: ArxmlDocument = {
    filePath: parsed.length === 1 ? parsed[0].file : `${parsed.length} files`,
    schemaVersion: '',
    swcs: [],
    compositions: [],
    connectors: [],
    interfaces: new Map(),
    dataTypes: new Map(),
    stats: { elements: 0, elapsedMs: 0 },
    diagnostics: [],
  };

  const versions = new Set<string>();
  const swcPaths = new Map<string, string[]>(); // path -> files
  const compPaths = new Map<string, string[]>();
  const itfPaths = new Map<string, string[]>();
  const dtPaths = new Map<string, string[]>();

  for (const { file, doc } of parsed) {
    if (doc.schemaVersion) versions.add(doc.schemaVersion);
    merged.stats.elements += doc.stats.elements;
    merged.stats.elapsedMs += doc.stats.elapsedMs;

    for (const swc of doc.swcs) {
      const key = swcPath(swc);
      const owners = swcPaths.get(key) ?? [];
      owners.push(file);
      swcPaths.set(key, owners);
      if (owners.length === 1) merged.swcs.push(swc);
    }

    for (const comp of doc.compositions) {
      const key = `${comp.packagePath}/${comp.name}`;
      const owners = compPaths.get(key) ?? [];
      owners.push(file);
      compPaths.set(key, owners);
      if (owners.length === 1) merged.compositions.push(comp);
    }

    for (const [p, itf] of doc.interfaces) {
      const owners = itfPaths.get(p) ?? [];
      owners.push(file);
      itfPaths.set(p, owners);
      if (owners.length === 1) merged.interfaces.set(p, itf);
      else {
        // A split interface may legally be extended: merge data elements.
        const existing = merged.interfaces.get(p)!;
        for (const de of itf.dataElements) if (!existing.dataElements.includes(de)) existing.dataElements.push(de);
        for (const op of itf.operations) if (!existing.operations.includes(op)) existing.operations.push(op);
      }
    }

    merged.connectors.push(...doc.connectors);

    for (const [p, dt] of doc.dataTypes) {
      const owners = dtPaths.get(p) ?? [];
      owners.push(file);
      dtPaths.set(p, owners);
      if (owners.length === 1) merged.dataTypes.set(p, dt);
    }
  }

  merged.schemaVersion = Array.from(versions).sort().pop() ?? '';

  // report genuine duplicate definitions
  const dupReport = (map: Map<string, string[]>, kind: string) => {
    for (const [p, owners] of map) {
      if (owners.length > 1) {
        const unique = Array.from(new Set(owners));
        issues.push({
          severity: 'warning',
          code: 'DUPLICATE_DEFINITION',
          message: `${kind} "${p}" is defined in ${unique.length} files (kept ${path.basename(unique[0])})`,
          files: unique,
        });
      }
    }
  };
  dupReport(swcPaths, 'SWC');
  dupReport(compPaths, 'Composition');
  dupReport(dtPaths, 'Data type');

  // connectors are deduped by their semantic signature later in viewModel,
  // but identical connectors across files are usually split artefacts -> keep
  // them here and let the view model collapse them.

  return merged;
}

function swcPath(swc: SwcInfo): string {
  // packagePath may be empty when a component sits at the ARXML root
  return `${swc.packagePath || ''}/${swc.name}`.replace(/\/+/g, '/');
}

/**
 * Re-resolves references that could not be satisfied inside a single file:
 * interfaces used by ports, and component types used by composition
 * prototypes. Runs on the merged model so order and file boundaries no longer
 * matter.
 */
function resolveCrossFileReferences(doc: ArxmlDocument): ProjectIssue[] {
  const issues: ProjectIssue[] = [];

  // index components by short name (cross-file type refs use the short name)
  const swcByName = new Map<string, SwcInfo>();
  for (const swc of doc.swcs) if (!swcByName.has(swc.name)) swcByName.set(swc.name, swc);
  const compByName = new Map<string, CompositionInfo>();
  for (const comp of doc.compositions) if (!compByName.has(comp.name)) compByName.set(comp.name, comp);

  // --- ports -> interfaces ------------------------------------------------
  const allComponents: Array<SwcInfo | CompositionInfo> = [...doc.swcs, ...doc.compositions];
  for (const comp of allComponents) {
    for (const port of comp.ports) {
      if (!port.interfaceRef) continue;
      const itf = doc.interfaces.get(port.interfaceRef.replace(/\/+$/, ''));
      if (itf) {
        port.interfaceName = itf.name || port.interfaceName;
        if (!port.dataElements.length) port.dataElements = itf.dataElements.slice(0, 8);
      } else {
        // The interface may live in a file that was not loaded - flag it once
        // per referenced path instead of once per port.
        issues.push({
          severity: 'info',
          code: 'UNRESOLVED_REFERENCE',
          message: `Interface ${port.interfaceRef} is not defined in the loaded files (port ${comp.name}.${port.name})`,
          files: [(comp as SwcInfo).sourceFile ?? ''].filter(Boolean),
        });
      }
    }
  }

  // --- composition prototypes -> component types --------------------------
  for (const comp of doc.compositions) {
    for (const inst of comp.instances) {
      if (!inst.typeRef) continue;
      const short = inst.typeName || inst.typeRef.split('/').filter(Boolean).pop() || '';
      if (!swcByName.has(short) && !compByName.has(short)) {
        issues.push({
          severity: 'info',
          code: 'UNRESOLVED_REFERENCE',
          message: `Component type ${inst.typeRef} cannot be resolved (instance ${comp.name}.${inst.name})`,
          files: [comp.sourceFile ?? ''].filter(Boolean),
        });
      }
    }
  }

  return dedupeIssues(issues);
}

/** Flags connectors whose endpoint component or port does not exist. */
function checkConnectorEndpoints(doc: ArxmlDocument): ProjectIssue[] {
  const issues: ProjectIssue[] = [];
  const portsByComp = new Map<string, Set<string>>();
  // instance name -> declared ports of its type
  const instanceType = new Map<string, string>();
  for (const comp of doc.compositions) {
    for (const inst of comp.instances) if (inst.name && inst.typeName) instanceType.set(inst.name, inst.typeName);
  }
  const compByName = new Map<string, SwcInfo | CompositionInfo>();
  for (const s of doc.swcs) compByName.set(s.name, s);
  for (const c of doc.compositions) compByName.set(c.name, c);

  for (const [name, comp] of compByName) {
    portsByComp.set(name, new Set(comp.ports.map((p: PortInfo) => p.name)));
  }

  const hasPort = (component: string, port: string): boolean => {
    if (!component || !port) return false;
    if (portsByComp.get(component)?.has(port)) return true;
    const type = instanceType.get(component);
    return !!type && !!portsByComp.get(type)?.has(port);
  };

  const seen = new Set<string>();
  for (const conn of doc.connectors as ConnectorInfo[]) {
    for (const side of ['provider', 'requester'] as const) {
      const ep = conn[side];
      if (!ep.port) continue;
      // delegation connectors legitimately point at composition boundary ports
      if (conn.kind === 'delegate') continue;
      if (!hasPort(ep.component, ep.port)) {
        const key = `${ep.component}.${ep.port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
          severity: 'warning',
          code: 'UNRESOLVED_REFERENCE',
          message: `Connector endpoint ${ep.component}.${ep.port} has no matching port declaration`,
          files: [conn.sourceFile ?? ''].filter(Boolean),
        });
      }
    }
  }
  return issues;
}

function dedupeIssues(issues: ProjectIssue[]): ProjectIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.code}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
