/**
 * AUTOSAR ARXML data model produced by the parser.
 */

export interface PortInfo {
  /** Local short name of the port prototype. */
  name: string;
  /** Port interface type ref, e.g. /AUTOSAR_Platform/Interfaces/SenderReceiverInterface */
  interfaceRef: string;
  /** Resolved short name of the interface ref. */
  interfaceName: string;
  /** Port direction: provides / requires / providesPdu / requiresPdu / ... */
  direction: PortDirection;
  /** Resolved data elements declared by the interface (if resolvable). */
  dataElements: string[];
  /** Application vs Service port. */
  kind: 'P-PORT' | 'R-PORT' | 'PR-PORT';
  /** Line number of the port-prototype start tag (1-based, 0 if unknown). */
  line?: number;
}

export type PortDirection =
  | 'provides'
  | 'requires'
  | 'providesPdu'
  | 'requiresPdu'
  | 'providesTrigger'
  | 'requiresTrigger'
  | 'providesNv'
  | 'requiresNv'
  | 'providesMode'
  | 'requiresMode'
  | 'providesParameter'
  | 'requiresParameter'
  | 'noProvide'
  | 'noRequire'
  | 'unknown';

export interface SwcInfo {
  name: string;
  /** File that declared this component (project mode). */
  sourceFile?: string;
  /** AUTOSAR meta type: ApplicationSwComponentType, ServiceSwComponentType, ... */
  type: string;
  /** AR-PACKAGE path containing the SWC, e.g. /Packages/Demo */
  packagePath: string;
  ports: PortInfo[];
  /** Runnables declared by the component's internal behavior. */
  runnables?: RunnableInfo[];
  /** true when the file carried an INTERNAL-BEHAVIOR block (even if empty). */
  hasInternalBehavior?: boolean;
}

/** How a runnable is triggered at runtime. */
export type TriggerKind =
  | 'TimingEvent'
  | 'DataReceivedEvent'
  | 'DataSendComplete'
  | 'OperationInvokedEvent'
  | 'ModeSwitchEvent'
  | 'InitEvent'
  | 'BackgroundEvent'
  | 'ExternalTrigger'
  | 'Asynchronous'
  | 'Unknown';

/** One activation path: an RTE event or an implicit activation reason. */
export interface RunnableTrigger {
  kind: TriggerKind;
  /** Raw AUTOSAR element name, e.g. TIMING-EVENT. */
  eventTag: string;
  /** Event short name (empty for implicit activation reasons). */
  eventName: string;
  /** "0.01 s" for timing events, "On transition" for mode switch, ... */
  detail: string;
  /** Triggering port, e.g. VehicleSpeed_P (for data/operation/mode events). */
  port: string;
  /** Event / trigger source path as written in the ARXML. */
  ref: string;
}

export interface RunnableInfo {
  name: string;
  /** File that declared the runnable. */
  sourceFile?: string;
  /** CAN-ENTER flag: true / false / undefined when not declared. */
  canEnter?: boolean;
  /** RUNS-ON reference short name (RTE / SCHM / ...). */
  runsOn: string;
  /** Minimum start interval in seconds, when declared by a timing event. */
  minInterval?: string;
  /** Every activation path of this runnable. */
  triggers: RunnableTrigger[];
  /** Symbols referenced by the runnable (READ/WRITE/DATA-RECEIVED...). */
  symbols?: string[];
  /** Server invocations (C/S interface calls) resolved to "Port.Operation". */
  serverCalls?: string[];
}

export interface CompositionInfo {
  name: string;
  /** File that declared this composition. */
  sourceFile?: string;
  packagePath: string;
  instances: ComponentInstance[];
  /** Ports of the composition boundary (used by delegation connectors). */
  ports: PortInfo[];
}

export interface ComponentInstance {
  name: string;
  /** Type ref -> resolved short name (SWC or composition). */
  typeRef: string;
  typeName: string;
}

/** A single assembly connector (swc1.p <-> swc2.r). */
export interface ConnectorInfo {
  name: string;
  /** File that declared this connector. */
  sourceFile?: string;
  /** Source side. For assembly connectors "provider" is the P-port. */
  provider: Endpoint;
  requester: Endpoint;
  /** delegate | assembly */
  kind: 'assembly' | 'delegate';
  /** Composition owning a delegate connector (empty for assembly). */
  composition?: string;
}

export interface Endpoint {
  /** Component / prototype short name. */
  component: string;
  /** Component instance path for nested compositions (e.g. Outer/Inner). */
  componentPath: string;
  /** Port prototype short name. */
  port: string;
  /** Interface ref of the port, when known from connector *Ref (ends with port name). */
  rawRef?: string;
}

/** Flattened row used by the table / CSV / graph views. */
export interface ConnectionRow {
  id: string;
  /** File declaring the connector (project mode). */
  sourceFile: string;
  providerComponent: string;
  /** Type name behind the instance, when the connector referenced a prototype (for filtering). */
  providerComponentType?: string;
  providerPort: string;
  providerInterface: string;
  providerDirection: string;
  providerPath: string;
  requesterComponent: string;
  requesterComponentType?: string;
  requesterPort: string;
  requesterInterface: string;
  requesterDirection: string;
  requesterPath: string;
  dataElements: string;
  kind: 'assembly' | 'delegate';
  composition: string;
  /** Status flag for filtering: ok | unresolved | unconnected */
  status: 'ok' | 'unresolved';
}

export interface DiagnosticInfo {
  severity: 'warning' | 'error';
  message: string;
}

export interface ArxmlDocument {
  filePath: string;
  /** Arxml version detected from the namespace, e.g. 4.2.2 */
  schemaVersion: string;
  swcs: SwcInfo[];
  compositions: CompositionInfo[];
  connectors: ConnectorInfo[];
  /** interface path -> interface info */
  interfaces: Map<string, InterfaceInfo>;
  /** data type path -> data type info */
  dataTypes: Map<string, DataTypeInfo>;
  /** Number of parsed bytes / elements, useful diagnostics. */
  stats: { elements: number; elapsedMs: number };
  diagnostics: DiagnosticInfo[];
}

/** A file that took part in a multi-file project parse. */
export interface ProjectFileInfo {
  path: string;
  /** Display name (basename). */
  name: string;
  schemaVersion: string;
  swcCount: number;
  portCount: number;
  connectorCount: number;
  interfaceCount: number;
  elements: number;
  elapsedMs: number;
  error?: string;
}

/** Optional Vector DaVinci project context attached to an aggregated parse. */
export interface DaVinciContext {
  projectFile: string;
  kind: 'dcf' | 'dpa' | 'dvjson' | 'unknown';
  tool: string;
  root: string;
  externalProjects: string[];
  scannedFolders: string[];
}

/** Aggregated result of parsing a set of ARXML files as one project. */
export interface ArxmlProject {
  files: ProjectFileInfo[];
  /** Set when the files came from a Vector DaVinci project. */
  daVinci?: DaVinciContext;
  /** Merged document with duplicate definitions collapsed. */
  merged: ArxmlDocument;
  /** Cross-file problems: duplicate definitions, dangling refs, ... */
  issues: ProjectIssue[];
  stats: { fileCount: number; failedFiles: number; elapsedMs: number };
}

export interface ProjectIssue {
  severity: 'warning' | 'error' | 'info';
  code: 'DUPLICATE_DEFINITION' | 'UNRESOLVED_REFERENCE' | 'PARSE_ERROR' | 'EMPTY_FILE';
  message: string;
  /** Files involved (1..n). */
  files: string[];
}

/** A data element prototype declared by an interface. */
export interface DataElementInfo {
  name: string;
  /** Type reference, e.g. /DataTypes/VehicleSpeed_T */
  typeRef: string;
  /** Resolved short name of the type. */
  typeName: string;
  /** Resolved kind of the referenced type, when the type is declared. */
  typeKind?: DataTypeKind;
  /** True when the prototype carries an INIT-VALUE. */
  hasInitValue: boolean;
}

/** One IN/OUT/INOUT argument of a client-server operation. */
export interface OperationArgument {
  name: string;
  /** IN / OUT / INOUT */
  direction: string;
  typeRef: string;
  typeName: string;
}

/** A client-server operation and its arguments. */
export interface OperationInfo {
  name: string;
  /** IN / OUT / INOUT arguments. */
  arguments: OperationArgument[];
}

export interface InterfaceInfo {
  /** File that declared this interface. */
  sourceFile?: string;
  path: string;
  name: string;
  category: string;
  /** Legacy flat list of data element names (kept for the connection table). */
  dataElements: string[];
  /** Structured data elements. */
  elements?: DataElementInfo[];
  operations: string[];
  /** Structured operations (client-server interfaces). */
  operationDetails?: OperationInfo[];
  /** True when the interface is marked IS-SERVICE. */
  isService?: boolean;
}

export type DataTypeKind =
  | 'APPLICATION-PRIMITIVE-DATA-TYPE'
  | 'APPLICATION-ARRAY-DATA-TYPE'
  | 'APPLICATION-RECORD-DATA-TYPE'
  | 'IMPLEMENTATION-DATA-TYPE'
  | 'UNKNOWN';

/** A data type definition declared somewhere in the loaded files. */
export interface DataTypeInfo {
  path: string;
  name: string;
  kind: DataTypeKind;
  /** Base type of an APPLICATION-PRIMITIVE-DATA-TYPE. */
  baseType?: string;
  /** Category from the AUTOSAR meta model (VALUE / STRUCTURE / ARRAY), for IDTs. */
  category?: string;
  /** Record/struct members. */
  members: Array<{ name: string; typeRef: string; typeName: string }>;
  /** Array element type. */
  arrayElementType?: string;
  /** Compu method reference (unit / scaling). */
  compuMethod?: string;
  unit?: string;
  min?: string;
  max?: string;
  sourceFile?: string;
}
