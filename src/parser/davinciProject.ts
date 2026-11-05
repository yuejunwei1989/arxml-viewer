/**
 * Vector DaVinci Configurator / Developer project discovery.
 *
 * Both tools keep the actual AUTOSAR model in ARXML files; the project file is
 * just an index over them. Three formats exist in the wild:
 *
 *   DaVinci Developer  .dcf   XML:   <DCF ARSCHEMA=".."><FILEREF><ARXML>..</ARXML></FILEREF>
 *                                   <EXTERNALFILEREF><PATH>other.dcf</PATH></EXTERNALFILEREF>
 *   DaVinci Cfg v5     .dpa   XML:   <ToolSettings><Input><InputFile>..</InputFile> ...
 *   DaVinci Cfg v6     .dvjson JSON: { "arxmlProjectContent": "./Settings/ArxmlProjectContent.json", ... }
 *
 * For v6 the ARXML locations live in ArxmlProjectContent.json (keys:
 * appComponents, softwareComponents, platformTypes, ...). We read those keys
 * dynamically instead of hard-coding one schema revision, because Vector adds
 * new categories over time - anything that looks like a path is taken.
 */

import * as fs from 'fs';
import * as path from 'path';
import { collectArxmlFiles } from './projectParser';
import { ProjectIssue } from './model';

export type DaVinciKind = 'dcf' | 'dpa' | 'dvjson' | 'unknown';

export interface DaVinciProjectInfo {
  /** Project file that was used as the entry point. */
  projectFile: string;
  kind: DaVinciKind;
  /** Tool label for the UI. */
  tool: string;
  /** Project root directory (usually the project file's folder). */
  root: string;
  /** ARXML files referenced directly by the project. */
  arxmlFiles: string[];
  /** Extra files pulled in through EXTERNALFILEREF / referenced workspaces. */
  externalProjects: string[];
  /** Sub-directories that were scanned because the project references them. */
  scannedFolders: string[];
  issues: ProjectIssue[];
}

const PROJECT_EXT = /\.(dcf|dpa|dvjson)$/i;

export function isDaVinciProjectFile(file: string): boolean {
  return PROJECT_EXT.test(file);
}

/** Reads a project file and returns every ARXML file it references. */
export async function discoverDaVinciProject(projectFile: string): Promise<DaVinciProjectInfo> {
  const ext = path.extname(projectFile).toLowerCase();
  const info: DaVinciProjectInfo = {
    projectFile,
    kind: ext === '.dcf' ? 'dcf' : ext === '.dpa' ? 'dpa' : ext === '.dvjson' ? 'dvjson' : 'unknown',
    tool: ext === '.dcf' ? 'DaVinci Developer' : 'DaVinci Configurator',
    root: path.dirname(projectFile),
    arxmlFiles: [],
    externalProjects: [],
    scannedFolders: [],
    issues: [],
  };

  let text: string;
  try {
    text = await fs.promises.readFile(projectFile, 'utf8');
  } catch (e) {
    info.issues.push({
      severity: 'error',
      code: 'PARSE_ERROR',
      message: `Cannot read project file ${path.basename(projectFile)}: ${(e as Error).message}`,
      files: [projectFile],
    });
    return info;
  }

  try {
    if (info.kind === 'dcf') await readDcf(text, info);
    else if (info.kind === 'dpa') await readDpa(text, info);
    else if (info.kind === 'dvjson') await readDvjson(text, info);
  } catch (e) {
    info.issues.push({
      severity: 'error',
      code: 'PARSE_ERROR',
      message: `Failed to parse project file: ${(e as Error).message}`,
      files: [projectFile],
    });
  }

  // De-duplicate and keep only files that exist.
  info.arxmlFiles = uniqueExisting(info.arxmlFiles);
  return info;
}

/* ------------------------------------------------------------------------- */
/* DaVinci Developer .dcf                                                    */
/* ------------------------------------------------------------------------- */

async function readDcf(text: string, info: DaVinciProjectInfo): Promise<void> {
  const dir = info.root;

  // FILEREF/ARXML can carry a ROOTITEM attribute; we only need the path.
  for (const m of text.matchAll(/<FILEREF\b[\s\S]*?<\/FILEREF>/gi)) {
    const block = m[0];
    const arxml = /<ARXML\b[^>]*>([^<]+)<\/ARXML>/i.exec(block);
    if (arxml) info.arxmlFiles.push(resolveRef(dir, arxml[1]));
  }
  // Some DCF revisions put plain <ARXML> entries directly under <DCF>.
  if (!info.arxmlFiles.length) {
    for (const m of text.matchAll(/<ARXML\b[^>]*>([^<]+)<\/ARXML>/gi)) {
      info.arxmlFiles.push(resolveRef(dir, m[1]));
    }
  }

  // Nested workspaces: <EXTERNALFILEREF><PATH>other.dcf</PATH></EXTERNALFILEREF>
  const nested: string[] = [];
  for (const m of text.matchAll(/<EXTERNALFILEREF\b[\s\S]*?<\/EXTERNALFILEREF>/gi)) {
    const p = /<PATH>([^<]+)<\/PATH>/i.exec(m[0]);
    if (p) nested.push(resolveRef(dir, p[1]));
  }

  for (const sub of nested) {
    info.externalProjects.push(sub);
    if (!/\.dcf$/i.test(sub)) continue;
    try {
      const subText = await fs.promises.readFile(sub, 'utf8');
      const subInfo: DaVinciProjectInfo = { ...info, root: path.dirname(sub), arxmlFiles: [], externalProjects: [] };
      await readDcf(subText, subInfo);
      info.arxmlFiles.push(...subInfo.arxmlFiles);
    } catch {
      info.issues.push({
        severity: 'warning',
        code: 'UNRESOLVED_REFERENCE',
        message: `Referenced external workspace does not exist: ${sub}`,
        files: [info.projectFile],
      });
    }
  }
}

/* ------------------------------------------------------------------------- */
/* DaVinci Configurator v5 .dpa                                              */
/* ------------------------------------------------------------------------- */

async function readDpa(text: string, info: DaVinciProjectInfo): Promise<void> {
  const dir = info.root;

  // <Input> ... <InputFile>path</InputFile> / <ArxmlFile>path</ArxmlFile>
  // Directory entries are given as <Folders><Folder>...</Folder></Folders>.
  const fileTags = /<(InputFile|ArxmlFile|FilePath|FileName)\b[^>]*>([^<]+)<\/\1>/gi;
  for (const m of text.matchAll(fileTags)) {
    const ref = resolveRef(dir, m[2]);
    if (/\.arxml$/i.test(ref)) info.arxmlFiles.push(ref);
  }

  // Folder entries: scan them for ARXML (the project treats the whole folder
  // as input, e.g. Config/ApplicationComponents).
  const folderTags = /<(Folder|Directory|FolderPath)\b[^>]*>([^<]+)<\/\1>/gi;
  const folders: string[] = [];
  for (const m of text.matchAll(folderTags)) {
    const ref = resolveRef(dir, m[2]);
    folders.push(ref);
  }

  // MultiLine / InputFiles text blocks: one path per line.
  for (const m of text.matchAll(/<(InputFiles|ArxmlFiles)>\s*([\s\S]*?)<\/\1>/gi)) {
    for (const line of m[2].split(/[\r\n]+/)) {
      const v = line.trim();
      if (!v || v.startsWith('<')) continue;
      const ref = resolveRef(dir, v);
      if (/\.arxml$/i.test(ref)) info.arxmlFiles.push(ref);
    }
  }

  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    const found = await collectArxmlFiles([folder]);
    if (found.length) {
      info.scannedFolders.push(folder);
      info.arxmlFiles.push(...found);
    }
  }

  // A v5 project must also pick up the developer workspace when present.
  const workspace = resolveRef(dir, 'Config/Developer');
  if (fs.existsSync(workspace)) {
    for (const f of await fs.promises.readdir(workspace)) {
      if (/\.dcf$/i.test(f)) {
        const dcfPath = path.join(workspace, f);
        info.externalProjects.push(dcfPath);
        try {
          const subInfo: DaVinciProjectInfo = { ...info, root: workspace, arxmlFiles: [], externalProjects: [] };
          await readDcf(await fs.promises.readFile(dcfPath, 'utf8'), subInfo);
          info.arxmlFiles.push(...subInfo.arxmlFiles);
        } catch {
          /* ignore broken nested workspace */
        }
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/* DaVinci Configurator v6 .dvjson                                           */
/* ------------------------------------------------------------------------- */

async function readDvjson(text: string, info: DaVinciProjectInfo): Promise<void> {
  const dir = info.root;
  let master: Record<string, unknown>;
  try {
    master = JSON.parse(stripJsonComments(text));
  } catch (e) {
    info.issues.push({
      severity: 'error',
      code: 'PARSE_ERROR',
      message: `${path.basename(info.projectFile)} is not valid JSON: ${(e as Error).message}`,
      files: [info.projectFile],
    });
    return;
  }

  // 1. the ARXML content settings file
  const contentRel = typeof master.arxmlProjectContent === 'string' ? master.arxmlProjectContent : undefined;
  if (contentRel) {
    const contentPath = resolveRef(dir, contentRel);
    if (fs.existsSync(contentPath)) {
      try {
        const content = JSON.parse(stripJsonComments(await fs.promises.readFile(contentPath, 'utf8')));
        // Relative paths inside a settings file are relative to that file.
        collectPathsFromJson(content, path.dirname(contentPath), info);
      } catch (e) {
        info.issues.push({
          severity: 'warning',
          code: 'PARSE_ERROR',
          message: `Failed to parse ArxmlProjectContent.json: ${(e as Error).message}`,
          files: [contentPath],
        });
      }
    } else {
      info.issues.push({
        severity: 'warning',
        code: 'UNRESOLVED_REFERENCE',
        message: `${contentRel} referenced by the project does not exist`,
        files: [info.projectFile],
      });
    }
  }

  // 2. the DaVinci Developer workspace (Settings/General.json -> references.dvWorkspace)
  const generalRel = typeof master.general === 'string' ? master.general : undefined;
  if (generalRel) {
    const generalPath = resolveRef(dir, generalRel);
    if (fs.existsSync(generalPath)) {
      try {
        const general = JSON.parse(stripJsonComments(await fs.promises.readFile(generalPath, 'utf8')));
        const ws = general?.references?.dvWorkspace;
        if (typeof ws === 'string') {
          const wsPath = resolveRef(path.dirname(generalPath), ws);
          info.externalProjects.push(wsPath);
          if (/\.dcf$/i.test(wsPath) && fs.existsSync(wsPath)) {
            const subInfo: DaVinciProjectInfo = { ...info, root: path.dirname(wsPath), arxmlFiles: [], externalProjects: [] };
            await readDcf(await fs.promises.readFile(wsPath, 'utf8'), subInfo);
            info.arxmlFiles.push(...subInfo.arxmlFiles);
          } else if (fs.existsSync(wsPath) && fs.statSync(wsPath).isDirectory()) {
            const found = await collectArxmlFiles([wsPath]);
            info.scannedFolders.push(wsPath);
            info.arxmlFiles.push(...found);
          }
        }
      } catch {
        /* non-fatal: workspace reference is optional */
      }
    }
  }

  // 3. Fallback: default v6 layout, so a project with an unusual settings file
  //    still yields SWCs instead of an empty view.
  if (!info.arxmlFiles.length) {
    for (const rel of ['Config/AppComponents', 'Config/System', 'Config/EcuConfig']) {
      const folder = path.join(dir, rel);
      if (!fs.existsSync(folder)) continue;
      const found = await collectArxmlFiles([folder]);
      if (found.length) {
        info.scannedFolders.push(folder);
        info.arxmlFiles.push(...found);
      }
    }
    if (info.arxmlFiles.length) {
      info.issues.push({
        severity: 'info',
        code: 'UNRESOLVED_REFERENCE',
        message: 'Could not derive ARXML paths from project settings, fell back to the DaVinci v6 default folder layout',
        files: [info.projectFile],
      });
    }
  }
}

/**
 * Walks the ArxmlProjectContent JSON and collects anything that looks like an
 * ARXML file or a folder path. Keys change between BSW package versions, so we
 * accept both explicit file paths and directory references.
 */
function collectPathsFromJson(node: unknown, baseDir: string, info: DaVinciProjectInfo, depth = 0): void {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') {
    if (!/\.arxml$/i.test(node) && !node.includes('/') && !node.includes('\\')) return;
    const abs = resolveRef(baseDir, node);
    if (/\.arxml$/i.test(abs)) info.arxmlFiles.push(abs);
    else if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) info.scannedFolders.push(abs);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectPathsFromJson(v, baseDir, info, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectPathsFromJson(v, baseDir, info, depth + 1);
    }
  }
}

/** Expands folders collected during discovery into ARXML file lists. */
export async function expandDaVinciProject(info: DaVinciProjectInfo): Promise<string[]> {
  const out = new Set<string>(info.arxmlFiles.filter((f) => /\.arxml$/i.test(f)));
  for (const folder of info.scannedFolders) {
    for (const f of await collectArxmlFiles([folder])) out.add(f);
  }
  return Array.from(out).sort();
}

/* ------------------------------------------------------------------------- */
/* helpers                                                                   */
/* ------------------------------------------------------------------------- */

function resolveRef(baseDir: string, ref: string): string {
  const cleaned = ref.trim().replace(/^["']|["']$/g, '');
  if (path.isAbsolute(cleaned)) return path.normalize(cleaned);
  return path.normalize(path.join(baseDir, cleaned));
}

/** DaVinci JSON settings occasionally carry // comments or a BOM. */
function stripJsonComments(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function uniqueExisting(files: string[]): string[] {
  return Array.from(new Set(files)).filter((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
}
