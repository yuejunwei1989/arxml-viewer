/**
 * Turns the raw ARXML model into the table rows rendered by the webview.
 */

import {
  ArxmlDocument,
  ArxmlProject,
  ConnectionRow,
  PortInfo,
  ProjectFileInfo,
  ProjectIssue,
  SwcInfo,
  CompositionInfo,
} from './model';

export interface PortRow {
  id: string;
  sourceFile: string;
  swc: string;
  port: string;
  direction: string;
  kind: string;
  interfaceName: string;
  dataElements: string;
  connectedTo: string;
  status: 'connected' | 'unconnected' | 'unresolved';
}

export interface SwcSummaryRow {
  id: string;
  sourceFile: string;
  name: string;
  type: string;
  packagePath: string;
  providers: number;
  requirers: number;
  connections: number;
}

export interface MatrixCell {
  from: string;
  to: string;
  /** list of "port -> port" labels */
  links: string[];
}

/** One row per interface, with its data elements / operations flattened. */
export interface InterfaceRow {
  id: string;
  sourceFile: string;
  name: string;
  path: string;
  /** SenderReceiver / ClientServer / ... */
  category: string;
  kind: 'S/R' | 'C/S' | 'Other';
  isService: boolean;
  elementCount: number;
  operationCount: number;
  /** Comma separated data element names (or operation names for C/S). */
  members: string;
  /** Comma separated "element: Type" pairs — the interesting column. */
  types: string;
  /** Ports using this interface: "Swc.Port (provides)". */
  usedBy: string;
  usedByCount: number;
}

/** One row per data type. */
export interface DataTypeRow {
  id: string;
  sourceFile: string;
  name: string;
  path: string;
  /** ApplicationPrimitive / ApplicationRecord / ApplicationArray / Implementation */
  kind: string;
  category: string;
  baseType: string;
  unit: string;
  range: string;
  compuMethod: string;
  /** Record members or array element type rendered as text. */
  members: string;
  memberCount: number;
  /** Interfaces that reference this type. */
  usedByInterfaces: string;
}

/** One row per runnable, with its activation paths flattened. */
export interface RunnableRow {
  id: string;
  sourceFile: string;
  swc: string;
  name: string;
  /** CAN-ENTER: '', 'yes', 'no' */
  canEnter: '' | 'yes' | 'no';
  runsOn: string;
  /** Comma separated trigger kinds, e.g. "TimingEvent, InitEvent". */
  triggerKinds: string;
  /** Human readable trigger summary for the main column. */
  triggers: string;
  /** Distinct trigger kinds for filtering. */
  kinds: string[];
  /** Ports involved in data/operation/mode triggers. */
  ports: string;
  /** Minimum start interval (timing events). */
  interval: string;
  symbols: string;
  /** 'ok' when at least one activation path exists. */
  status: 'ok' | 'orphan';
}

export interface ViewModel {
  fileName: string;
  schemaVersion: string;
  /** True when the view was built from more than one file. */
  projectMode: boolean;
  /** Vector DaVinci project that produced this view, when applicable. */
  daVinci: import('./model').DaVinciContext | null;
  files: ProjectFileInfo[];
  issues: ProjectIssue[];
  swcs: SwcSummaryRow[];
  connections: ConnectionRow[];
  ports: PortRow[];
  interfaces: InterfaceRow[];
  dataTypes: DataTypeRow[];
  runnables: RunnableRow[];
  matrix: { components: string[]; cells: MatrixCell[] };
  stats: {
    swcCount: number;
    portCount: number;
    assemblyCount: number;
    delegateCount: number;
    unconnectedPorts: number;
    unresolvedCount: number;
    elements: number;
    elapsedMs: number;
    fileCount: number;
    failedFiles: number;
    issueCount: number;
    interfaceCount: number;
    dataTypeCount: number;
    runnableCount: number;
    orphanRunnables: number;
  };
  packages: string[];
}

function portKey(component: string, port: string) {
  return `${component}::${port}`;
}

export function buildViewModel(doc: ArxmlDocument): ViewModel {
  // ---- instance -> type mapping (composition prototypes) ----------------
  // Connectors reference component *instances* (e.g. WheelSpeedSensorInst),
  // while ports are declared on component *types* (e.g. WheelSpeedSensor).
  const instanceToType = new Map<string, string>();
  for (const c of doc.compositions) {
    for (const inst of c.instances) {
      if (inst.name && inst.typeName) instanceToType.set(inst.name, inst.typeName);
    }
  }
  /** Adds the port key under every name the component is known by. */
  const linkPort = (map: Map<string, string[]>, component: string, port: string, label: string) => {
    const names = new Set([component, instanceToType.get(component)].filter(Boolean) as string[]);
    for (const name of names) {
      const key = portKey(name, port);
      const arr = map.get(key) ?? [];
      arr.push(label);
      map.set(key, arr);
    }
  };

  // ---- port index -------------------------------------------------------
  const portsByComp = new Map<string, PortInfo[]>();
  const addPorts = (name: string, ports: PortInfo[]) => {
    if (!name) return;
    const list = portsByComp.get(name) ?? [];
    for (const p of ports) if (!list.some((x) => x.name === p.name)) list.push(p);
    portsByComp.set(name, list);
  };
  for (const s of doc.swcs) addPorts(s.name, s.ports);
  for (const c of doc.compositions) addPorts(c.name, c.ports);

  /**
   * Looks a port up by component *or* by the component type of that instance:
   * connectors reference instances (Reader) while ports are declared on types
   * (SwitchReader).
   */
  const findPort = (comp: string, port: string): PortInfo | undefined => {
    const direct = (portsByComp.get(comp) ?? []).find((p) => p.name === port);
    if (direct) return direct;
    const type = instanceToType.get(comp);
    return type ? (portsByComp.get(type) ?? []).find((p) => p.name === port) : undefined;
  };

  // ---- connections ------------------------------------------------------
  const connections: ConnectionRow[] = doc.connectors.map((c, i) => {
    const pPort = findPort(c.provider.component, c.provider.port);
    const rPort = findPort(c.requester.component, c.requester.port);
    const unresolved =
      (!c.provider.port && !c.provider.component) || (!c.requester.port && !c.requester.component) || (!c.provider.port || !c.requester.port);

    const dataElements = uniq([
      ...(pPort?.dataElements ?? []),
      ...(rPort?.dataElements ?? []),
    ]).join(', ');

    return {
      id: `conn-${i}`,
      sourceFile: c.sourceFile ?? '',
      providerComponent: c.provider.component || '(?)',
      providerComponentType: instanceToType.get(c.provider.component) || undefined,
      providerPort: c.provider.port || '(?)',
      providerInterface: pPort?.interfaceName || '',
      providerDirection: pPort?.direction || '',
      providerPath: `${c.provider.componentPath}/${c.provider.port}`.replace(/^\/+/, ''),
      requesterComponent: c.requester.component || '(?)',
      requesterComponentType: instanceToType.get(c.requester.component) || undefined,
      requesterPort: c.requester.port || '(?)',
      requesterInterface: rPort?.interfaceName || '',
      requesterDirection: rPort?.direction || '',
      requesterPath: `${c.requester.componentPath}/${c.requester.port}`.replace(/^\/+/, ''),
      dataElements,
      kind: c.kind,
      composition: c.composition || '',
      status: unresolved ? 'unresolved' : 'ok',
    } satisfies ConnectionRow;
  });

  // dedupe identical connections (common when files are split/merged)
  const seenConn = new Set<string>();
  const uniqueConnections = connections.filter((c) => {
    const k = `${c.providerComponent}.${c.providerPort}>${c.requesterComponent}.${c.requesterPort}:${c.kind}`;
    if (seenConn.has(k)) return false;
    seenConn.add(k);
    return true;
  });

  // ---- port table -------------------------------------------------------
  const connectedToByPort = new Map<string, string[]>();
  const pushLink = (key: string, label: string) => {
    const arr = connectedToByPort.get(key) ?? [];
    arr.push(label);
    connectedToByPort.set(key, arr);
  };
  for (const c of uniqueConnections) {
    linkPort(connectedToByPort, c.providerComponent, c.providerPort, `${c.requesterComponent}.${c.requesterPort} (${c.kind})`);
    linkPort(connectedToByPort, c.requesterComponent, c.requesterPort, `${c.providerComponent}.${c.providerPort} (${c.kind})`);
  }

  const ports: PortRow[] = [];
  const allComponents: Array<SwcInfo | CompositionInfo> = [...doc.swcs, ...doc.compositions];
  for (const comp of allComponents) {
    for (const p of comp.ports) {
      const links = connectedToByPort.get(portKey(comp.name, p.name)) ?? [];
      ports.push({
        id: `port-${ports.length}`,
        sourceFile: (comp as SwcInfo).sourceFile ?? '',
        swc: comp.name,
        port: p.name,
        direction: p.direction,
        kind: p.kind,
        interfaceName: p.interfaceName || '(unresolved)',
        dataElements: p.dataElements.join(', '),
        connectedTo: links.length ? uniq(links).join('; ') : '',
        status: links.length ? 'connected' : p.interfaceRef ? 'unconnected' : 'unresolved',
      });
    }
  }

  // ---- SWC summary ------------------------------------------------------
  const connCountByComp = new Map<string, number>();
  for (const c of uniqueConnections) {
    connCountByComp.set(c.providerComponent, (connCountByComp.get(c.providerComponent) ?? 0) + 1);
    connCountByComp.set(c.requesterComponent, (connCountByComp.get(c.requesterComponent) ?? 0) + 1);
  }

  const swcRows: SwcSummaryRow[] = doc.swcs.map((s, i) => ({
    id: `swc-${i}`,
    sourceFile: s.sourceFile ?? '',
    name: s.name,
    type: s.type,
    packagePath: s.packagePath || '/',
    providers: s.ports.filter((p) => p.direction === 'provides').length,
    requirers: s.ports.filter((p) => p.direction === 'requires').length,
    connections: connCountByComp.get(s.name) ?? 0,
  }));
  for (const comp of doc.compositions) {
    swcRows.push({
      id: `comp-${comp.name}`,
      sourceFile: comp.sourceFile ?? '',
      name: comp.name,
      type: 'COMPOSITION-SW-COMPONENT-TYPE',
      packagePath: comp.packagePath || '/',
      providers: comp.ports.filter((p) => p.direction === 'provides').length,
      requirers: comp.ports.filter((p) => p.direction === 'requires').length,
      connections: connCountByComp.get(comp.name) ?? 0,
    });
  }

  // ---- interfaces -------------------------------------------------------
  // Ports referencing an interface, keyed by full path: used for the "used by"
  // column so users can jump from an interface back to the components.
  const portsByInterface = new Map<string, string[]>();
  for (const comp of allComponents) {
    for (const p of comp.ports) {
      if (!p.interfaceRef) continue;
      const key = p.interfaceRef.replace(/\/+$/, '');
      const arr = portsByInterface.get(key) ?? [];
      arr.push(`${comp.name}.${p.name} (${p.direction})`);
      portsByInterface.set(key, arr);
    }
  }

  const dataTypeByPath = doc.dataTypes;

  const interfaces: InterfaceRow[] = Array.from(doc.interfaces.values()).map((itf, i) => {
    const elements = itf.elements ?? [];
    const ops = itf.operationDetails ?? [];
    const isCS = /CLIENT-SERVER/i.test(itf.category);
    const kind: InterfaceRow['kind'] = isCS ? 'C/S' : /SENDER-RECEIVER|NvData|Parameter/i.test(itf.category) ? 'S/R' : 'Other';

    // resolve the referenced data type kind where possible
    const typeLabel = (ref: string, fallback: string) => {
      const n = fallback || shortName(ref);
      const dt = dataTypeByPath.get(ref);
      return dt ? `${n} [${shortKind(dt.kind)}]` : n;
    };

    const typeStr = isCS
      ? ops
          .map((o) => `${o.name}(${o.arguments.map((a) => `${a.name}:${typeLabel(a.typeRef, a.typeName)}`).join(', ')})`)
          .join('; ')
      : elements.map((e) => `${e.name}: ${typeLabel(e.typeRef, e.typeName)}`).join('; ');

    const usedBy = portsByInterface.get(itf.path.replace(/\/+$/, '')) ?? [];
    return {
      id: `itf-${i}`,
      sourceFile: itf.sourceFile ?? '',
      name: itf.name,
      path: itf.path,
      category: itf.category,
      kind,
      isService: !!itf.isService,
      elementCount: elements.length,
      operationCount: ops.length,
      members: (isCS ? ops.map((o) => o.name) : elements.map((e) => e.name)).join(', '),
      types: typeStr,
      usedBy: uniq(usedBy).join('; '),
      usedByCount: uniq(usedBy).length,
    };
  });

  // ---- data types -------------------------------------------------------
  // Which interfaces reference each type (both data elements and operation args)
  const typeUsage = new Map<string, string[]>();
  const noteUsage = (ref: string, itfName: string) => {
    if (!ref) return;
    const arr = typeUsage.get(ref) ?? [];
    if (!arr.includes(itfName)) arr.push(itfName);
    typeUsage.set(ref, arr);
  };
  for (const itf of doc.interfaces.values()) {
    for (const e of itf.elements ?? []) noteUsage(e.typeRef, itf.name);
    for (const o of itf.operationDetails ?? []) for (const a of o.arguments) noteUsage(a.typeRef, itf.name);
    // fallback for interfaces parsed without structured elements
    if (!(itf.elements ?? []).length) {
      for (const ref of Object.keys((itf as any).elementTypeRefs ?? {})) noteUsage(ref, itf.name);
    }
  }

  const dataTypes: DataTypeRow[] = Array.from(doc.dataTypes.values())
    .map((dt, i) => {
      const memberStr =
        dt.kind === 'APPLICATION-RECORD-DATA-TYPE'
          ? dt.members.map((m) => `${m.name}: ${m.typeName || shortName(m.typeRef)}`).join('; ')
          : dt.kind === 'APPLICATION-ARRAY-DATA-TYPE'
            ? (dt.arrayElementType ? `[] of ${dt.arrayElementType}` : '')
            : '';
      const range = dt.min || dt.max ? `${dt.min ?? '?'} … ${dt.max ?? '?'}` : '';
      return {
        id: `dt-${i}-${dt.name}`,
        sourceFile: dt.sourceFile ?? '',
        name: dt.name,
        path: dt.path,
        kind: shortKind(dt.kind),
        category: dt.category ?? '',
        baseType: dt.baseType ?? '',
        unit: dt.unit ?? '',
        range,
        compuMethod: dt.compuMethod ?? '',
        members: memberStr,
        memberCount: dt.kind === 'APPLICATION-RECORD-DATA-TYPE' ? dt.members.length : dt.arrayElementType ? 1 : 0,
        usedByInterfaces: (typeUsage.get(dt.path) ?? []).join(', '),
      } satisfies DataTypeRow;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ---- runnables --------------------------------------------------------
  const TRIGGER_LABEL: Record<string, string> = {
    TimingEvent: 'Timing',
    DataReceivedEvent: 'Data recv',
    DataSendComplete: 'Send done',
    OperationInvokedEvent: 'Op invoked',
    ModeSwitchEvent: 'Mode switch',
    InitEvent: 'Init',
    BackgroundEvent: 'Background',
    ExternalTrigger: 'Ext trigger',
    Asynchronous: 'Async',
    Unknown: 'Unknown',
  };

  const runnables: RunnableRow[] = [];
  for (const swc of doc.swcs) {
    for (const r of swc.runnables ?? []) {
      const trigs = r.triggers ?? [];
      const kinds = uniq(trigs.map((t) => t.kind));
      const ports = uniq(trigs.map((t) => t.port).filter(Boolean) as string[]);
      const intervals = uniq(trigs.filter((t) => t.kind === 'TimingEvent' && t.detail).map((t) => t.detail));

      // "Timing 10 ms; Data recv VehicleSpeed_P; Init"
      const summary = trigs
        .map((t) => {
          const label = TRIGGER_LABEL[t.kind] ?? t.kind;
          const bits = [label];
          if (t.port) bits.push(t.port);
          if (t.detail && t.kind !== 'DataReceivedEvent' && t.kind !== 'OperationInvokedEvent') bits.push(t.detail);
          return bits.join(' ');
        })
        .join('; ');

      runnables.push({
        id: `run-${runnables.length}`,
        sourceFile: r.sourceFile ?? swc.sourceFile ?? '',
        swc: swc.name,
        name: r.name,
        canEnter: r.canEnter === undefined ? '' : r.canEnter ? 'yes' : 'no',
        runsOn: r.runsOn || '—',
        triggerKinds: kinds.map((k) => TRIGGER_LABEL[k] ?? k).join(', '),
        triggers: summary,
        kinds,
        ports: ports.join(', '),
        interval: intervals.join(', ') || (r.minInterval ? `${r.minInterval} s` : ''),
        symbols: (r.symbols ?? []).join(', '),
        status: trigs.length ? 'ok' : 'orphan',
      });
    }
  }

  // ---- matrix -----------------------------------------------------------
  const componentSet = new Set<string>();
  for (const c of uniqueConnections) {
    componentSet.add(c.providerComponent);
    componentSet.add(c.requesterComponent);
  }
  const components = Array.from(componentSet).sort((a, b) => a.localeCompare(b));
  const cellMap = new Map<string, MatrixCell>();
  for (const c of uniqueConnections) {
    const key = `${c.providerComponent}|${c.requesterComponent}`;
    const cell = cellMap.get(key) ?? { from: c.providerComponent, to: c.requesterComponent, links: [] };
    cell.links.push(`${c.providerPort} → ${c.requesterPort}`);
    cellMap.set(key, cell);
  }

  return {
    fileName: doc.filePath,
    schemaVersion: doc.schemaVersion || 'unknown',
    projectMode: false,
    daVinci: null,
    files: [],
    issues: [],
    swcs: swcRows,
    connections: uniqueConnections,
    ports,
    interfaces,
    dataTypes,
    runnables,
    matrix: { components, cells: Array.from(cellMap.values()) },
    stats: {
      swcCount: doc.swcs.length,
      portCount: doc.swcs.reduce((n, s) => n + s.ports.length, 0),
      assemblyCount: uniqueConnections.filter((c) => c.kind === 'assembly').length,
      delegateCount: uniqueConnections.filter((c) => c.kind === 'delegate').length,
      unconnectedPorts: ports.filter((p) => p.status === 'unconnected').length,
      unresolvedCount: uniqueConnections.filter((c) => c.status === 'unresolved').length,
      elements: doc.stats.elements,
      elapsedMs: doc.stats.elapsedMs,
      fileCount: doc.filePath.includes(' files') ? 0 : 1,
      failedFiles: 0,
      issueCount: 0,
      interfaceCount: doc.interfaces.size,
      dataTypeCount: doc.dataTypes.size,
      runnableCount: runnables.length,
      orphanRunnables: runnables.filter((r) => r.status === 'orphan').length,
    },
    packages: uniq(doc.swcs.map((s) => s.packagePath || '/')).sort(),
  };
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

/** Last segment of an AUTOSAR reference. */
function shortName(ref: string): string {
  if (!ref) return '';
  const parts = ref.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : ref;
}

/** Short, human friendly data type kind label. */
function shortKind(kind: string): string {
  switch (kind) {
    case 'APPLICATION-PRIMITIVE-DATA-TYPE':
      return 'APDT';
    case 'APPLICATION-RECORD-DATA-TYPE':
      return 'Record';
    case 'APPLICATION-ARRAY-DATA-TYPE':
      return 'Array';
    case 'IMPLEMENTATION-DATA-TYPE':
      return 'IDT';
    default:
      return '?';
  }
}

/** Serialises the connection table to CSV (RFC 4180 quoting). */
export function toCsv(vm: ViewModel): string {
  const header = [
    'Provider SWC',
    'Provider Port',
    'Provider Interface',
    'Provider Direction',
    'Requester SWC',
    'Requester Port',
    'Requester Interface',
    'Requester Direction',
    'Data Elements',
    'Connector Type',
    'Composition',
    'Status',
  ];
  const rows = vm.connections.map((c) => [
    c.providerComponent,
    c.providerPort,
    c.providerInterface,
    c.providerDirection,
    c.requesterComponent,
    c.requesterPort,
    c.requesterInterface,
    c.requesterDirection,
    c.dataElements,
    c.kind,
    c.composition,
    c.status,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Builds the table view for a multi-file project: same shape as the single
 * file view plus per-file rows and cross-file issues.
 */
export function buildProjectViewModel(project: ArxmlProject): ViewModel {
  const vm = buildViewModel(project.merged);
  vm.projectMode = project.files.length > 1 || !!project.daVinci;
  vm.daVinci = project.daVinci ?? null;
  vm.files = project.files;
  vm.issues = project.issues;
  vm.stats.fileCount = project.stats.fileCount;
  vm.stats.failedFiles = project.stats.failedFiles;
  vm.stats.issueCount = project.issues.length;
  if (project.files.length > 1) {
    vm.fileName = `${project.stats.fileCount} ARXML files`;
  }
  if (project.daVinci) {
    vm.fileName = `${project.daVinci.tool} project · ${project.stats.fileCount} ARXML`;
  }
  return vm;
}

/** CSV export: connections plus a per-file summary section. */
export function projectToCsv(project: ArxmlProject, vm: ViewModel): string {
  const base = toCsv(vm);
  if (project.files.length <= 1 && !project.issues.length) return base;
  const lines: string[] = [base.trimEnd(), '', '# Files'];
  lines.push(['File', 'Schema', 'SWC', 'Ports', 'Connectors', 'Interfaces', 'Elements', 'ms', 'Error'].map(csvCell).join(','));
  for (const f of project.files) {
    lines.push(
      [f.path, f.schemaVersion, f.swcCount, f.portCount, f.connectorCount, f.interfaceCount, f.elements, f.elapsedMs, f.error ?? '']
        .map(csvCell)
        .join(',')
    );
  }
  if (project.issues.length) {
    lines.push('', '# Issues');
    lines.push(['Severity', 'Code', 'Message', 'Files'].map(csvCell).join(','));
    for (const i of project.issues) {
      lines.push([i.severity, i.code, i.message, i.files.join(' | ')].map(csvCell).join(','));
    }
  }
  return lines.join('\r\n') + '\r\n';
}
