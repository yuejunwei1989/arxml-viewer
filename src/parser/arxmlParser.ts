/**
 * Streaming ARXML parser built on `saxes`.
 *
 * ARXML files are frequently 50-500 MB. Loading them into an object tree
 * (fast-xml-parser) costs several GB, so we run a SAX walk and keep a small
 * stack of contexts, collecting only what the SWC connection view needs:
 *
 *   - SW-COMPONENT-TYPE        -> SwcInfo + PORT-PROTOTYPEs
 *   - ASSEMBLY / DELEGATION-SW-CONNECTOR
 *   - COMPOSITION-SW-COMPONENT-TYPE + COMPONENT-PROTOTYPEs
 *   - VARIABLE-DATA-PROTOTYPE / *-INTERFACE
 *   - AR-PACKAGE               -> human readable paths
 *
 * Text is attributed to the innermost *typed* context (port / connector /
 * instance / interface) plus the element name; elements above that context
 * are inspected through a short ancestor window so that paths such as
 * PROVIDER-IREF/PORT-REF can be distinguished from REQUESTER-IREF/PORT-REF.
 */

import { SaxesParser } from 'saxes';
import {
  ArxmlDocument,
  ComponentInstance,
  ConnectorInfo,
  DataElementInfo,
  DataTypeInfo,
  DataTypeKind,
  Endpoint,
  InterfaceInfo,
  OperationArgument,
  OperationInfo,
  RunnableInfo,
  RunnableTrigger,
  TriggerKind,
  PortDirection,
  PortInfo,
  SwcInfo,
  CompositionInfo,
} from './model';

const SWC_TYPES = new Set([
  'APPLICATION-SW-COMPONENT-TYPE',
  'SERVICE-SW-COMPONENT-TYPE',
  'COMPLEX-DEVICE-DRIVER-SW-COMPONENT-TYPE',
  'ECU-ABSTRACTION-SW-COMPONENT-TYPE',
  'SENSOR-ACTUATOR-SW-COMPONENT-TYPE',
  'PARAMETER-SW-COMPONENT-TYPE',
  'SERVICE-PROXY-SW-COMPONENT-TYPE',
  'NV-BLOCK-SW-COMPONENT-TYPE',
  'APPLICATION-SW-COMPONENT',
  'SERVICE-SW-COMPONENT',
]);

const COMPOSITION_TYPES = new Set(['COMPOSITION-SW-COMPONENT-TYPE', 'COMPOSITION-SW-COMPONENT']);

const INTERFACE_TAGS = new Set([
  'SENDER-RECEIVER-INTERFACE',
  'CLIENT-SERVER-INTERFACE',
  'MODE-SWITCH-INTERFACE',
  'NV-DATA-INTERFACE',
  'PARAMETER-INTERFACE',
  'TRIGGER-INTERFACE',
]);

const DATA_TYPE_TAGS = new Set([
  'APPLICATION-PRIMITIVE-DATA-TYPE',
  'APPLICATION-ARRAY-DATA-TYPE',
  'APPLICATION-RECORD-DATA-TYPE',
  'IMPLEMENTATION-DATA-TYPE',
]);

/**
 * Hoisted tag patterns. Inline regex literals inside hot functions are
 * re-created on every call, which showed up as 20%+ of parse time on large
 * projects.
 */
const RE_ARRAY_ELEMENT = /ARRAY-ELEMENT$/;
const RE_RECORD_ELEMENT = /RECORD-ELEMENT$/;

/**
 * RTE event flavours that activate a runnable. Names differ slightly between
 * AUTOSAR releases (ASYNC-RTE-EVENT in R3, ASYNCHRONOUS-SERVER-CALL-RETURNS-EVENT
 * in R4), hence the set.
 */
const RTE_EVENT_TAGS: Record<string, TriggerKind> = {
  'TIMING-EVENT': 'TimingEvent',
  'DATA-RECEIVED-EVENT': 'DataReceivedEvent',
  'DATA-SEND-COMPLETED-EVENT': 'DataSendComplete',
  'OPERATION-INVOKED-EVENT': 'OperationInvokedEvent',
  'ASYNCHRONOUS-SERVER-CALL-RETURNS-EVENT': 'Asynchronous',
  'ASYNC-RTE-EVENT': 'Asynchronous',
  'SWC-MODE-SWITCH-EVENT': 'ModeSwitchEvent',
  'MODE-SWITCHED-ACK-EVENT': 'ModeSwitchEvent',
  'INIT-EVENT': 'InitEvent',
  'BACKGROUND-EVENT': 'BackgroundEvent',
  'EXTERNAL-TRIGGER-OCCURRED-EVENT': 'ExternalTrigger',
};

/** IMPLICIT activation reasons (R4.2+) — a runnable triggered implicitly. */
const IMPLICIT_REASONS: Record<string, TriggerKind> = {
  'IMPLICIT-READ-ACCESS': 'Unknown',
  'IMPLICIT-WRITE-ACCESS': 'Unknown',
  'IMPLICIT-INTER-RUNNABLE-VARIABLE-ACCESS': 'Unknown',
  'IMPLICIT-COMMUNICATION': 'Unknown',
};

/** Mutable trigger used while parsing; frozen into RunnableTrigger at the end. */
type MutableTrigger = RunnableTrigger & {
  /** true for a declared RTE event, false for an activation reference. */
  _event?: boolean;
  /** START-ON-EVENT-REF target (activation refs only). */
  _ref?: string;
  /** name of the runnable that declared the activation ref. */
  _owner?: string;
};

/**
 * Tags that have a dedicated branch in the `opentag` handler. Everything else
 * is a plain container and takes the fast path, avoiding a long chain of
 * string comparisons for the ~90% of tags that carry no model meaning.
 */
const OPENTAG_HANDLED: Set<string> = new Set<string>([
  'AUTOSAR',
  'AR-PACKAGE',
  'COMPONENT-PROTOTYPE',
  'SW-COMPONENT-PROTOTYPE',
  'INIT-VALUE',
  'ASSEMBLY-SW-CONNECTOR',
  'DELEGATION-SW-CONNECTOR',
  'VARIABLE-DATA-PROTOTYPE',
  'DATA-ELEMENT',
  'CLIENT-SERVER-OPERATION',
  'ARGUMENT-DATA-PROTOTYPE',
  'RUNNABLE-ENTITY',
  'SWC-INTERNAL-BEHAVIOR',
]);

/** Lazily filled: the tag sets above are defined in this module. */
function isHandledTag(name: string): boolean {
  return (
    OPENTAG_HANDLED.has(name) ||
    SWC_TYPES.has(name) ||
    COMPOSITION_TYPES.has(name) ||
    PORT_TAGS.has(name) ||
    INTERFACE_TAGS.has(name) ||
    DATA_TYPE_TAGS.has(name) ||
    RTE_EVENT_TAGS[name] !== undefined ||
    (name.length > 6 && (RE_RECORD_ELEMENT.test(name) || RE_ARRAY_ELEMENT.test(name)))
  );
}

const PORT_TAGS = new Set([
  'R-PORT-PROTOTYPE',
  'P-PORT-PROTOTYPE',
  'PR-PORT-PROTOTYPE',
  'PROVIDED-PORT-PROTOTYPE',
  'REQUIRED-PORT-PROTOTYPE',
  'P-PORT-IN-COMPOSITION',
  'R-PORT-IN-COMPOSITION',
]);

const PORT_DIRECTION: Record<string, PortDirection> = {
  'R-PORT-PROTOTYPE': 'requires',
  'R-PORT-IN-COMPOSITION': 'requires',
  'REQUIRED-PORT-PROTOTYPE': 'requires',
  'P-PORT-PROTOTYPE': 'provides',
  'P-PORT-IN-COMPOSITION': 'provides',
  'PROVIDED-PORT-PROTOTYPE': 'provides',
  'PR-PORT-PROTOTYPE': 'unknown',
};

/** Contexts that own the SHORT-NAME of the element they represent. */
type IdentityKind =
  | 'package'
  | 'swc'
  | 'composition'
  | 'port'
  | 'connector'
  | 'instance'
  | 'interface'
  | 'dataElement'
  | 'operation'
  | 'argument'
  | 'dataType'
  | 'runnable'
  | 'rteEvent'
  | 'behavior'
  | 'element';

type CtxKind = IdentityKind;

interface Ctx {
  kind: CtxKind;
  tag: string;
  /** short name of this element (only meaningful for identity contexts) */
  shortName: string;
  /** collected connector endpoints */
  providerPortRef?: string;
  requesterPortRef?: string;
  providerComponentRef?: string;
  requesterComponentRef?: string;
  /** model object this context builds */
  ref?:
    | SwcInfo
    | CompositionInfo
    | PortInfo
    | ConnectorInfo
    | InterfaceInfo
    | ComponentInstance
    | DataElementInfo
    | OperationInfo
    | OperationArgument
    | DataTypeInfo
    | RunnableInfo
    | MutableTrigger;
  /** AR-PACKAGE path prefix captured at open time */
  packagePrefix?: string;
}

export interface ParseOptions {
  /** Skip components whose short name matches this regex. */
  excludePattern?: RegExp;
}

export class ArxmlParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(`ARXML parse error${line ? ` (line ${line})` : ''}: ${message}`);
    this.name = 'ArxmlParseError';
  }
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

/**
 * Last path segment of an AUTOSAR reference.
 *
 * Hot path: called once per parsed reference (hundreds of thousands of times
 * on large projects), so it avoids regex entirely — a regex literal inside a
 * function body is re-created on every call and dominated the profile before.
 */
function shortNameOf(ref: string): string {
  if (!ref) return '';
  let end = ref.length;
  while (end > 0 && ref.charCodeAt(end - 1) === 47 /* '/' */) end--;
  let start = ref.lastIndexOf('/', end - 1);
  return ref.slice(start + 1, end);
}

/**
 * Extracts the port instance name from a data element ref such as
 * `/Components/EngineControl/VehicleSpeed_P/VehicleSpeed`.
 * The port is the second-to-last segment.
 */
function parentPortName(ref: string): string {
  const parts = ref.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** Turns an AUTOSAR seconds literal into a readable string ("0.01 s"). */
function formatSeconds(v: string): string {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return v;
  if (n >= 1) return `${round(n)} s`;
  if (n >= 1e-3) return `${round(n * 1e3)} ms`;
  return `${round(n * 1e6)} µs`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Splits "/Pkg/Sub/Comp/Port" into the component path and port name. */
function splitPortRef(ref: string): { componentPath: string; port: string } {
  const parts = ref.split('/').filter(Boolean);
  return { componentPath: parts.slice(0, -1).join('/'), port: parts.length ? parts[parts.length - 1] : '' };
}

export function parseArxml(content: string, filePath = 'memory.arxml', options: ParseOptions = {}): ArxmlDocument {
  const t0 = Date.now();
  const doc: ArxmlDocument = {
    filePath,
    schemaVersion: '',
    swcs: [],
    compositions: [],
    connectors: [],
    interfaces: new Map(),
    dataTypes: new Map(),
    stats: { elements: 0, elapsedMs: 0 },
    diagnostics: [],
  };

  const stack: Ctx[] = [];
  const packageStack: string[] = [];
  const portRefs: Array<{ port: PortInfo; ref: string }> = [];
  /**
   * Every RTE event parsed, in document order. Activation refs
   * (START-ON-EVENT-REF) may appear *before* the event they name, so the
   * linkage is resolved in postProcess instead of while streaming.
   */
  const runnableTriggers: Array<MutableTrigger & { _ref?: string; _owner?: string }> = [];
  let elements = 0;
  let parseError: ArxmlParseError | undefined;
  let textBuf = '';

  const pkgPath = () => (packageStack.length ? '/' + packageStack.join('/') : '');
  const top = (): Ctx | undefined => stack[stack.length - 1];

  /** innermost context of one of the given kinds */
  const findInnermost = (frames: Ctx[], ...kinds: CtxKind[]): Ctx | undefined => {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (kinds.includes(frames[i].kind)) return frames[i];
    }
    return undefined;
  };

  /**
   * Walks down from the top of `frames` until the owning typed context is
   * found, collecting the intermediate (untyped) element names in between.
   */
  const ownerOf = (frames: Ctx[]): { owner?: Ctx; ancestors: string[] } => {
    const ancestors: string[] = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const c = frames[i];
      if (c.kind !== 'element' && c.kind !== 'package') return { owner: c, ancestors };
      ancestors.push(c.tag);
    }
    return { ancestors };
  };

  const parser = new SaxesParser({ xmlns: true });

  /**
   * Attributes the text of the element that just closed to its owner context.
   *
   * @param elementName  the closed element (e.g. PORT-REF)
   * @param frames       stack snapshot *after* the closed element was popped
   */
  function assignText(elementName: string, value: string, frames: Ctx[]) {
    if (!value || !elementName) return;

    // SHORT-NAME belongs to the nearest real (typed) element around it.
    if (elementName === 'SHORT-NAME') {
      // Member-like wrappers (record members, array elements) are untyped
      // 'element' contexts. Only a *record* member owns its name — an array
      // element's SHORT-NAME must NOT overwrite the array type's own name.
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i];
        if (f.kind === 'element' && RE_ARRAY_ELEMENT.test(f.tag)) {
          // The array element's own name is not part of the model: its type
          // reference is what matters. Never let it overwrite the array type.
          return;
        }
        if (f.kind === 'dataType') break;
        if (f.kind === 'element' && f.ref && RE_RECORD_ELEMENT.test(f.tag)) {
          (f.ref as { name: string }).name = value;
          return;
        }
      }
      // A wrapper element directly inside a typed owner (e.g. an argument) is
      // still owned by that typed context, so the plain lookup is correct.
      // 'behavior' is included so an INTERNAL-BEHAVIOR name never leaks up to
      // the owning component.
      const owner = findInnermost(
        frames,
        'argument', 'rteEvent', 'runnable', 'behavior', 'operation', 'dataElement',
        'interface', 'dataType', 'port', 'connector', 'instance', 'swc', 'composition', 'package'
      );
      if (!owner) return;
      owner.shortName = value;
      // AR-PACKAGE paths must be live while children are parsed.
      if (owner.kind === 'package') packageStack.push(value);
      return;
    }

    const { owner, ancestors } = ownerOf(frames);
    if (!owner) return;

    switch (owner.kind) {
      case 'port': {
        const port = owner.ref as PortInfo;
        if (elementName !== 'TYPE-TREF' && elementName !== 'PROVIDED-INTERFACE-TREF' &&
            elementName !== 'PROVIDED-REQUIRED-INTERFACE-TREF' && elementName !== 'REQUIRED-INTERFACE-TREF') break;
        if (!port.interfaceRef) port.interfaceRef = value;
        portRefs.push({ port, ref: value });
        if (elementName === 'REQUIRED-INTERFACE-TREF') port.direction = 'requires';
        else if (elementName === 'PROVIDED-INTERFACE-TREF') port.direction = 'provides';
        break;
      }
      case 'connector': {
        const isPortRef = elementName === 'PORT-REF' || elementName === 'TARGET-PORT-REF' ||
                          elementName === 'OUTER-PORT-REF' || elementName === 'INNER-PORT-IN-COMPOSITION-REF' ||
                          elementName === 'P-PORT-IN-COMPOSITION-REF' || elementName === 'R-PORT-IN-COMPOSITION-REF';
        const isCompRef = elementName === 'COMPONENT-REF' || elementName === 'COMPONENT-PROTOTYPE-REF' ||
                          elementName === 'CONTEXT-COMPONENT-REF';
        if (!isPortRef && !isCompRef) break;

        // Side is decided by *any* enclosing side marker, not just the parent,
        // because some exporters nest CONTEXT-COMPONENT-REF one level deeper.
        const joined = ancestors.join('/');
        let side: 'provider' | 'requester' | '' =
          /PROVIDER-IREF|INNER-PORT-IREF/.test(joined) ? 'provider'
          : /REQUESTER-IREF|OUTER-PORT-REF|OUTER-PORT-IREF/.test(joined) ? 'requester' : '';
        // Bare OUTER-PORT-REF of a delegation connector is the boundary port
        // delegated *outward* -> treat it as the requester side of the inner
        // port. P-PORT-IN-COMPOSITION-REF without a side marker defaults to
        // the provider (inner) side.
        if (!side && elementName === 'OUTER-PORT-REF') side = 'requester';
        if (!side && /P-PORT-IN-COMPOSITION-REF|INNER-PORT-IN-COMPOSITION-REF/.test(elementName)) side = 'provider';
        if (!side && isCompRef) side = 'provider'; // legacy single-sided form

        if (isCompRef) {
          if (side === 'provider') owner.providerComponentRef = value;
          else if (side === 'requester') owner.requesterComponentRef = value;
        } else {
          if (side === 'provider') owner.providerPortRef = value;
          else if (side === 'requester') owner.requesterPortRef = value;
        }
        break;
      }
      case 'instance': {
        if (elementName === 'TYPE-TREF') (owner.ref as ComponentInstance).typeRef = value;
        break;
      }
      case 'dataElement': {
        const el = owner.ref as DataElementInfo;
        if (elementName === 'TYPE-TREF' || elementName === 'IMPLEMENTATION-DATA-TYPE-REF') {
          el.typeRef = el.typeRef || value;
          el.typeName = el.typeName || shortNameOf(value);
        }
        break;
      }
      case 'operation': {
        // Arguments own their own context (see 'argument'); nothing else is
        // expected directly under an operation.
        break;
      }
      case 'argument': {
        const arg = owner.ref as OperationArgument;
        if (elementName === 'TYPE-TREF' || elementName === 'IMPLEMENTATION-DATA-TYPE-REF') {
          arg.typeRef = arg.typeRef || value;
          arg.typeName = arg.typeName || shortNameOf(value);
        } else if (elementName === 'DIRECTION') {
          arg.direction = value;
        }
        break;
      }
      case 'dataType': {
        const dt = owner.ref as DataTypeInfo;
        switch (elementName) {
          case 'BASE-TYPE-REF':
          case 'SW-BASE-TYPE-REF':
            dt.baseType = dt.baseType || shortNameOf(value);
            break;
          case 'CATEGORY':
            dt.category = value;
            break;
          case 'COMPU-METHOD-REF':
            dt.compuMethod = shortNameOf(value);
            break;
          case 'UNIT-REF':
            dt.unit = shortNameOf(value);
            break;
          case 'LOWER-LIMIT':
            dt.min = value;
            break;
          case 'UPPER-LIMIT':
            dt.max = value;
            break;
          case 'TYPE-TREF':
          case 'IMPLEMENTATION-DATA-TYPE-REF': {
            // The member/array element wrappers differ between AUTOSAR
            // flavours: RECORD-ELEMENT, APPLICATION-RECORD-ELEMENT,
            // IMPLEMENTATION-DATA-TYPE-ELEMENT, ARRAY-ELEMENT, ...
            const inMember = ancestors.some(
              (a) => RE_RECORD_ELEMENT.test(a) || a === 'IMPLEMENTATION-DATA-TYPE-ELEMENT'
            );
            const inArray = ancestors.some((a) => RE_ARRAY_ELEMENT.test(a));
            if (inArray) dt.arrayElementType = shortNameOf(value);
            else if (inMember) {
              const last = dt.members[dt.members.length - 1];
              if (last) {
                last.typeRef = value;
                last.typeName = shortNameOf(value);
              }
            } else if (!dt.baseType) {
              dt.baseType = shortNameOf(value);
            }
            break;
          }
        }
        break;
      }
      case 'runnable': {
        const r = owner.ref as RunnableInfo;
        switch (elementName) {
          case 'CAN-ENTER':
            r.canEnter = value === 'true';
            break;
          case 'RUNS-ON-REF':
            r.runsOn = shortNameOf(value);
            break;
          case 'MINIMUM-START-INTERVAL':
            r.minInterval = value;
            break;
          case 'SYMBOL':
          case 'DATA-ELEMENT-REF':
          case 'VARIABLE-ACCESS-REF':
            (r.symbols = r.symbols ?? []).push(shortNameOf(value));
            break;
          case 'OPERATION-REF':
            (r.serverCalls = r.serverCalls ?? []).push(shortNameOf(value));
            break;
        }
        break;
      }
      case 'rteEvent': {
        const t = owner.ref as MutableTrigger;
        switch (elementName) {
          case 'START-ON-EVENT-REF':
            t._ref = value;
            break;
          case 'PERIOD':
            t.detail = formatSeconds(value);
            break;
          case 'DATA-ELEMENT-REF':
          case 'OPERATION-REF':
            if (!t.port) t.port = parentPortName(value);
            t.ref = t.ref || value;
            break;
          case 'TRIGGER-REF':
          case 'ABSTRACT-REQUEST-TRIGGER-REF':
            t.ref = t.ref || value;
            break;
          case 'ON-TRANSITION':
            if (!t.detail) t.detail = `On transition (${value})`;
            break;
          case 'MODE-DECLARATION-REF':
          case 'MODE-DR-REF':
            t.port = t.port || parentPortName(value);
            break;
        }
        break;
      }
      case 'interface': {
        const itf = owner.ref as InterfaceInfo;
        if (elementName === 'IS-SERVICE') {
          itf.isService = value === 'true';
          break;
        }
        if (elementName === 'SHORT-NAME') {
          if (ancestors.includes('VARIABLE-DATA-PROTOTYPE') || ancestors.includes('DATA-ELEMENT')) itf.dataElements.push(value);
          else if (ancestors.includes('OPERATION')) itf.operations.push(value);
          else if (!itf.name) itf.name = value;
        }
        break;
      }
    }
  }

  parser.on('opentag', (tag: any) => {
    // `tag.local` is already a plain string in xmlns mode; String() only
    // guards against non-namespace exporters. Avoid a helper call per tag.
    const name: string = tag.local || localName(String(tag.name));
    elements++;
    // Text belongs to exactly one element: start a fresh buffer on open so
    // self-closing siblings can never inherit a stale value.
    textBuf = '';

    // Fast path: the vast majority of tags are plain containers. A single
    // Map lookup replaces a chain of 15+ string comparisons below.
    if (!isHandledTag(name)) {
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    if (name === 'AUTOSAR') {      const attrs = tag.attributes || {};
      for (const k of Object.keys(attrs)) {
        const v = String((attrs[k] as any).value ?? '');
        const m = /autosar\.org\/schema\/r([\d.]+)/.exec(v);
        if (m) {
          doc.schemaVersion = m[1];
          break;
        }
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    if (name === 'AR-PACKAGE') {
      stack.push({ kind: 'package', tag: name, shortName: '', packagePrefix: pkgPath() });
      return;
    }

    if (SWC_TYPES.has(name)) {
      const swc: SwcInfo = { name: '', type: name, packagePath: pkgPath(), ports: [], sourceFile: filePath };
      doc.swcs.push(swc);
      stack.push({ kind: 'swc', tag: name, shortName: '', ref: swc });
      return;
    }

    if (COMPOSITION_TYPES.has(name)) {
      const comp: CompositionInfo = { name: '', packagePath: pkgPath(), instances: [], ports: [], sourceFile: filePath };
      doc.compositions.push(comp);
      stack.push({ kind: 'composition', tag: name, shortName: '', ref: comp });
      return;
    }

    if (name === 'COMPONENT-PROTOTYPE' || name === 'SW-COMPONENT-PROTOTYPE') {
      const parent = findInnermost(stack, 'composition');
      if (parent) {
        const inst: ComponentInstance = { name: '', typeRef: '', typeName: '' };
        (parent.ref as CompositionInfo).instances.push(inst);
        stack.push({ kind: 'instance', tag: name, shortName: '', ref: inst });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    // An INIT-VALUE container carries no text of its own (it wraps
    // NUMERICAL-VALUE-SPECIFICATION / RECORD-VALUE etc.), so the flag must be
    // set on open rather than on close.
    if (name === 'INIT-VALUE') {
      const elCtx = findInnermost(stack, 'dataElement');
      if (elCtx) (elCtx.ref as DataElementInfo).hasInitValue = true;
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    if (PORT_TAGS.has(name)) {
      const owner = findInnermost(stack, 'swc', 'composition');
      if (owner) {
        const port: PortInfo = {
          name: '',
          interfaceRef: '',
          interfaceName: '',
          direction: PORT_DIRECTION[name] ?? 'unknown',
          dataElements: [],
          kind: name.startsWith('R-') || name.startsWith('REQUIRED') ? 'R-PORT' : name.startsWith('PR-') ? 'PR-PORT' : 'P-PORT',
        };
        (owner.ref as SwcInfo | CompositionInfo).ports.push(port);
        stack.push({ kind: 'port', tag: name, shortName: '', ref: port });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    if (name === 'ASSEMBLY-SW-CONNECTOR' || name === 'DELEGATION-SW-CONNECTOR') {
      const conn: ConnectorInfo = {
        name: '',
        provider: { component: '', componentPath: '', port: '' },
        requester: { component: '', componentPath: '', port: '' },
        kind: name === 'ASSEMBLY-SW-CONNECTOR' ? 'assembly' : 'delegate',
        sourceFile: filePath,
      };
      doc.connectors.push(conn);
      stack.push({ kind: 'connector', tag: name, shortName: '', ref: conn });
      return;
    }

    if (INTERFACE_TAGS.has(name)) {
      const itf: InterfaceInfo = {
        path: '',
        name: '',
        category: name,
        dataElements: [],
        elements: [],
        operations: [],
        operationDetails: [],
        sourceFile: filePath,
      };
      stack.push({ kind: 'interface', tag: name, shortName: '', ref: itf });
      return;
    }

    // --- data elements declared by an interface -----------------------
    if (name === 'VARIABLE-DATA-PROTOTYPE' || name === 'DATA-ELEMENT') {
      const owner = findInnermost(stack, 'interface');
      if (owner) {
        const el: DataElementInfo = { name: '', typeRef: '', typeName: '', hasInitValue: false };
        const itf = owner.ref as InterfaceInfo;
        itf.elements = itf.elements ?? [];
        itf.elements.push(el);
        stack.push({ kind: 'dataElement', tag: name, shortName: '', ref: el });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    // --- client-server operations --------------------------------------
    if (name === 'CLIENT-SERVER-OPERATION') {
      const owner = findInnermost(stack, 'interface');
      if (owner) {
        const op: OperationInfo = { name: '', arguments: [] };
        const itf = owner.ref as InterfaceInfo;
        itf.operationDetails = itf.operationDetails ?? [];
        itf.operationDetails.push(op);
        stack.push({ kind: 'operation', tag: name, shortName: '', ref: op });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    // --- operation arguments -------------------------------------------
    if (name === 'ARGUMENT-DATA-PROTOTYPE') {
      const owner = findInnermost(stack, 'operation');
      if (owner) {
        const arg: OperationArgument = { name: '', direction: '', typeRef: '', typeName: '' };
        (owner.ref as OperationInfo).arguments.push(arg);
        stack.push({ kind: 'argument', tag: name, shortName: '', ref: arg });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    // --- data type definitions -----------------------------------------
    // --- runnables (internal behavior) ----------------------------------
    if (name === 'RUNNABLE-ENTITY') {
      const owner = findInnermost(stack, 'swc');
      if (owner) {
        const swc = owner.ref as SwcInfo;
        const r: RunnableInfo = { name: '', sourceFile: filePath, runsOn: '', triggers: [] };
        swc.runnables = swc.runnables ?? [];
        swc.runnables.push(r);
        stack.push({ kind: 'runnable', tag: name, shortName: '', ref: r });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    // Marks the component as having an internal behavior even when it
    // declares no runnable (useful to distinguish "none" from "not parsed").
    if (name === 'SWC-INTERNAL-BEHAVIOR') {
      const owner = findInnermost(stack, 'swc');
      if (owner) (owner.ref as SwcInfo).hasInternalBehavior = true;
      stack.push({ kind: 'behavior', tag: name, shortName: '' });
      return;
    }

    // --- RTE events (activation paths) -----------------------------------
    if (RTE_EVENT_TAGS[name]) {
      const beh = findInnermost(stack, 'swc');
      if (beh) {
        const t: MutableTrigger = {
          kind: RTE_EVENT_TAGS[name],
          eventTag: name,
          eventName: '',
          detail: '',
          port: '',
          ref: '',
          _event: true,
        };
        runnableTriggers.push(t);
        stack.push({ kind: 'rteEvent', tag: name, shortName: '', ref: t });
        return;
      }
      stack.push({ kind: 'element', tag: name, shortName: '' });
      return;
    }

    if (DATA_TYPE_TAGS.has(name)) {
      const dt: DataTypeInfo = {
        path: '',
        name: '',
        kind: name as DataTypeKind,
        members: [],
        sourceFile: filePath,
      };
      stack.push({ kind: 'dataType', tag: name, shortName: '', ref: dt });
      return;
    }

    // --- record / array member declarations ----------------------------
    // Needed so their SHORT-NAME is not attributed to the enclosing data
    // type. Flavours: RECORD-ELEMENT, APPLICATION-RECORD-ELEMENT, ...
    if (RE_RECORD_ELEMENT.test(name) || RE_ARRAY_ELEMENT.test(name)) {
      const dtCtx = findInnermost(stack, 'dataType');
      if (dtCtx) {
        const dt = dtCtx.ref as DataTypeInfo;
        if (RE_RECORD_ELEMENT.test(name)) {
          const member = { name: '', typeRef: '', typeName: '' };
          dt.members.push(member);
          stack.push({ kind: 'element', tag: name, shortName: '', ref: member });
          return;
        }
        stack.push({ kind: 'element', tag: name, shortName: '' });
        return;
      }
    }

    stack.push({ kind: 'element', tag: name, shortName: '' });
  });

  // saxes emits the raw string (not an event object) for text/cdata.
  parser.on('text', (t: string) => {
    textBuf += t;
  });
  parser.on('cdata', (t: string) => {
    textBuf += t;
  });

  parser.on('closetag', (tag: any) => {
    const name = tag.local ? String(tag.local) : localName(String(tag.name));
    const ctx = stack.pop();
    if (!ctx) return;
    if (ctx.tag !== name) {
      // Defensive resync: never let a malformed stream corrupt the model.
      while (stack.length && stack[stack.length - 1].tag !== name) stack.pop();
      return;
    }

    // `stack` is now the parent chain of the closed element.
    const text = textBuf.trim();
    textBuf = '';

    if (ctx.kind === 'element') {
      assignText(name, text, stack);
    } else {
      // The typed context itself is closing: its own text (rare) is ignored,
      // but its identity must be published.
      switch (ctx.kind) {
        case 'package':
          packageStack.pop();
          break;
        case 'swc':
          (ctx.ref as SwcInfo).name = ctx.shortName;
          break;
        case 'composition':
          (ctx.ref as CompositionInfo).name = ctx.shortName;
          break;
        case 'port': {
          const port = ctx.ref as PortInfo;
          port.name = ctx.shortName;
          port.interfaceName = shortNameOf(port.interfaceRef);
          if (port.direction === 'unknown') {
            port.direction = /REQUIRED/i.test(port.interfaceRef) ? 'requires' : 'provides';
          }
          break;
        }
        case 'instance': {
          const inst = ctx.ref as ComponentInstance;
          inst.name = ctx.shortName;
          inst.typeName = shortNameOf(inst.typeRef);
          break;
        }
        case 'connector': {
          const conn = ctx.ref as ConnectorInfo;
          conn.name = ctx.shortName;
          conn.provider = buildEndpoint(ctx.providerPortRef, ctx.providerComponentRef);
          conn.requester = buildEndpoint(ctx.requesterPortRef, ctx.requesterComponentRef);
          const comp = findInnermost(stack, 'composition');
          if (conn.kind === 'delegate' && comp) conn.composition = (comp.ref as CompositionInfo).name;
          break;
        }
        case 'dataElement': {
          const el = ctx.ref as DataElementInfo;
          el.name = ctx.shortName;
          if (!el.typeName && el.typeRef) el.typeName = shortNameOf(el.typeRef);
          break;
        }
        case 'operation': {
          const op = ctx.ref as OperationInfo;
          op.name = ctx.shortName;
          break;
        }
        case 'argument': {
          const arg = ctx.ref as OperationArgument;
          arg.name = ctx.shortName;
          if (!arg.typeName && arg.typeRef) arg.typeName = shortNameOf(arg.typeRef);
          break;
        }
        case 'runnable': {
          (ctx.ref as RunnableInfo).name = ctx.shortName;
          break;
        }
        case 'rteEvent': {
          (ctx.ref as MutableTrigger).eventName = ctx.shortName;
          break;
        }
        case 'dataType': {
          const dt = ctx.ref as DataTypeInfo;
          dt.name = ctx.shortName;
          dt.path = `${pkgPath()}/${dt.name}`;
          doc.dataTypes.set(dt.path, dt);
          break;
        }
        case 'interface': {
          const itf = ctx.ref as InterfaceInfo;
          if (!itf.name) itf.name = ctx.shortName;
          itf.path = pkgPath() + '/' + itf.name;
          doc.interfaces.set(itf.path, itf);
          break;
        }
      }
    }
  });

  parser.on('error', (e: Error) => {
    parseError = new ArxmlParseError(e.message, (parser as any).line);
  });

  try {
    parser.write(content).close();
  } catch (e: any) {
    throw new ArxmlParseError(e?.message ?? String(e), (parser as any).line);
  }
  if (parseError) throw parseError;

  postProcess(doc, portRefs, runnableTriggers, options);
  doc.stats = { elements, elapsedMs: Date.now() - t0 };
  return doc;
}

function buildEndpoint(portRef?: string, componentRef?: string): Endpoint {
  if (portRef) {
    const { componentPath, port } = splitPortRef(portRef);
    // For delegation connectors the port ref often points straight at the
    // composition boundary port, so componentPath is empty or the composition
    // itself. Keep the last meaningful owner segment.
    const owner = componentRef ? shortNameOf(componentRef) : shortNameOf(componentPath);
    return { component: owner || '', componentPath, port, rawRef: portRef };
  }
  if (componentRef) {
    return { component: shortNameOf(componentRef), componentPath: componentRef.replace(/^\/+/, ''), port: '' };
  }
  return { component: '', componentPath: '', port: '' };
}

function postProcess(
  doc: ArxmlDocument,
  portRefs: Array<{ port: PortInfo; ref: string }>,
  runnableTriggers: Array<MutableTrigger & { _ref?: string; _owner?: string }>,
  options: ParseOptions
) {
  // Backfill the legacy flat lists first: ports are resolved from them, so
  // interfaces that only produced structured entries must be flattened before
  // the port loop runs.
  for (const itf of doc.interfaces.values()) {
    if (!itf.dataElements.length && itf.elements?.length) {
      itf.dataElements = itf.elements.map((e) => e.name);
    }
    if (!itf.operations.length && itf.operationDetails?.length) {
      itf.operations = itf.operationDetails.map((o) => o.name);
    }
  }

  for (const { port, ref } of portRefs) {
    const itf = doc.interfaces.get(ref);
    if (itf && itf.dataElements.length) port.dataElements = itf.dataElements.slice(0, 8);
  }

  const seen = new Set<string>();
  doc.swcs = doc.swcs.filter((s) => {
    const key = `${s.packagePath}::${s.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Keep a connector as long as both sides carry at least a port; delegation
  // connectors legitimately have no component (they point at boundary ports).
  doc.connectors = doc.connectors.filter(
    (c) => (c.provider.port || c.provider.component) && (c.requester.port || c.requester.component)
  );

  linkRunnables(doc, runnableTriggers);

  if (options.excludePattern) {
    const re = options.excludePattern;
    doc.swcs = doc.swcs.filter((s) => !re.test(s.name));
    doc.connectors = doc.connectors.filter((c) => !re.test(c.provider.component) && !re.test(c.requester.component));
  }
}

/**
 * Joins RTE events with the runnables they activate.
 *
 * In ARXML the *event* declares its target: `TIMING-EVENT` contains a
 * `START-ON-EVENT-REF` naming the runnable. Because the event may be declared
 * before or after the runnable, both sides are collected during the stream and
 * joined here by path suffix.
 */
function linkRunnables(
  doc: ArxmlDocument,
  refs: Array<MutableTrigger & { _ref?: string; _owner?: string }>
): void {
  /** RTE events only: activation refs on runnables are resolved the same way. */
  const events = refs.filter((t) => t._event && t._ref);
  if (!events.length) {
    // still normalise the triggers array so the view model can rely on it
    for (const swc of doc.swcs) for (const r of swc.runnables ?? []) r.triggers = r.triggers ?? [];
    return;
  }

  // Index runnables of *all* components once: previously every component
  // scanned every event, which is O(components x events) and dominated the
  // profile (10 000 runnables x 10 000 events = 10^8 comparisons).
  const byName = new Map<string, RunnableInfo[]>();
  const byPath = new Map<string, RunnableInfo>();
  for (const swc of doc.swcs) {
    for (const r of swc.runnables ?? []) {
      r.triggers = [];
      const list = byName.get(r.name);
      if (list) list.push(r);
      else byName.set(r.name, [r]);
      // a fully qualified path is unique, so it can be indexed directly
      const full = `${swc.packagePath || ''}/${swc.name}/${r.name}`.replace(/\/+/g, '/');
      byPath.set(full, r);
    }
  }

  for (const evt of events) {
    const targetPath = evt._ref!;
    const target = byPath.get(targetPath) ?? pickRunnable(byName.get(shortNameOf(targetPath)), targetPath);
    if (!target) continue;
    const trig = toTrigger(evt);
    if (!target.triggers.some((x) => x.kind === trig.kind && x.eventName === trig.eventName)) {
      target.triggers.push(trig);
    }
  }
}

/** Disambiguates same-named runnables in different components by path suffix. */
function pickRunnable(candidates: RunnableInfo[] | undefined, refPath: string): RunnableInfo | undefined {
  if (!candidates?.length) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((r) => refPath.endsWith(`/${r.name}`)) ?? candidates[0];
}

function toTrigger(t: MutableTrigger): RunnableTrigger {
  let detail = t.detail;
  if (!detail && t.kind === 'DataReceivedEvent') detail = 'Data received';
  if (!detail && t.kind === 'DataSendComplete') detail = 'Send complete';
  if (!detail && t.kind === 'OperationInvokedEvent') detail = 'Operation invoked';
  if (!detail && t.kind === 'InitEvent') detail = 'Init';
  if (!detail && t.kind === 'BackgroundEvent') detail = 'Background loop';
  if (!detail && t.kind === 'Asynchronous') detail = 'Async return';
  if (!detail && t.kind === 'ExternalTrigger') detail = 'External trigger';
  return {
    kind: t.kind,
    eventTag: t.eventTag,
    eventName: t.eventName,
    detail,
    port: t.port,
    ref: t.ref,
  };
}
