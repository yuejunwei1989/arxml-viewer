/**
 * Generates a synthetic ARXML used for performance measurements.
 *
 *  100 SWC x 100 ports each  = 10 000 port prototypes
 *  10 data elements per port = 100 000 VARIABLE-DATA-PROTOTYPE
 *  + assembly connectors wiring the ports in a ring
 *
 * The output is intentionally shaped like a real project: interfaces live in
 * their own package and are referenced by absolute path.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface GenOptions {
  swcCount: number;
  portsPerSwc: number;
  elementsPerPort: number;
  /** connect ports across neighbouring components */
  connectors: number;
}

export const DEFAULT_GEN: GenOptions = {
  swcCount: 100,
  portsPerSwc: 100,
  elementsPerPort: 10,
  connectors: 10000,
};

export function generateArxml(o: GenOptions): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<AUTOSAR xmlns="http://autosar.org/schema/r4.0">');
  out.push('  <AR-PACKAGES>');

  // ---- interfaces (shared, one per port index) -------------------------
  out.push('    <AR-PACKAGE><SHORT-NAME>Ifs</SHORT-NAME><ELEMENTS>');
  for (let p = 0; p < o.portsPerSwc; p++) {
    out.push(`      <SENDER-RECEIVER-INTERFACE><SHORT-NAME>If_${p}</SHORT-NAME><DATA-ELEMENTS>`);
    for (let e = 0; e < o.elementsPerPort; e++) {
      out.push(
        `        <VARIABLE-DATA-PROTOTYPE><SHORT-NAME>El_${p}_${e}</SHORT-NAME>` +
          `<TYPE-TREF DEST="APPLICATION-PRIMITIVE-DATA-TYPE">/Dts/T_${e}</TYPE-TREF>` +
          `</VARIABLE-DATA-PROTOTYPE>`
      );
    }
    out.push('      </DATA-ELEMENTS></SENDER-RECEIVER-INTERFACE>');
  }
  out.push('    </ELEMENTS></AR-PACKAGE>');

  // ---- data types ------------------------------------------------------
  out.push('    <AR-PACKAGE><SHORT-NAME>Dts</SHORT-NAME><ELEMENTS>');
  for (let e = 0; e < o.elementsPerPort; e++) {
    out.push(
      `      <APPLICATION-PRIMITIVE-DATA-TYPE><SHORT-NAME>T_${e}</SHORT-NAME><CATEGORY>VALUE</CATEGORY>` +
        `<SW-DATA-DEF-PROPS><SW-DATA-DEF-PROPS-VARIANTS><SW-DATA-DEF-PROPS-CONDITIONAL>` +
        `<BASE-TYPE-REF DEST="SW-BASE-TYPE">/AUTOSAR_Platform/BaseTypes/uint16</BASE-TYPE-REF>` +
        `</SW-DATA-DEF-PROPS-CONDITIONAL></SW-DATA-DEF-PROPS-VARIANTS></SW-DATA-DEF-PROPS>` +
        `</APPLICATION-PRIMITIVE-DATA-TYPE>`
    );
  }
  out.push('    </ELEMENTS></AR-PACKAGE>');

  // ---- components ------------------------------------------------------
  out.push('    <AR-PACKAGE><SHORT-NAME>Comps</SHORT-NAME><ELEMENTS>');
  for (let s = 0; s < o.swcCount; s++) {
    out.push(`      <APPLICATION-SW-COMPONENT-TYPE><SHORT-NAME>Swc_${s}</SHORT-NAME><PORTS>`);
    for (let p = 0; p < o.portsPerSwc; p++) {
      const isProvider = p % 2 === 0;
      const tag = isProvider ? 'P-PORT-PROTOTYPE' : 'R-PORT-PROTOTYPE';
      const ref = isProvider ? 'PROVIDED-INTERFACE-TREF' : 'REQUIRED-INTERFACE-TREF';
      out.push(
        `        <${tag}><SHORT-NAME>P_${p}</SHORT-NAME>` +
          `<${ref} DEST="SENDER-RECEIVER-INTERFACE">/Ifs/If_${p}</${ref}>` +
          `</${tag}>`
      );
    }
    out.push('      </PORTS>');
    // internal behavior: one runnable per port, timing triggered
    out.push('      <INTERNAL-BEHAVIORS><SWC-INTERNAL-BEHAVIOR>');
    out.push(`        <SHORT-NAME>Swc_${s}_Ib</SHORT-NAME><EVENTS>`);
    for (let p = 0; p < o.portsPerSwc; p++) {
      out.push(
        `          <TIMING-EVENT><SHORT-NAME>Ev_${s}_${p}</SHORT-NAME>` +
          `<START-ON-EVENT-REF DEST="RUNNABLE-ENTITY">/Comps/Swc_${s}/Swc_${s}_Ib/R_${p}</START-ON-EVENT-REF>` +
          `<PERIOD>0.01</PERIOD></TIMING-EVENT>`
      );
    }
    out.push('        </EVENTS><RUNNABLES>');
    for (let p = 0; p < o.portsPerSwc; p++) {
      out.push(
        `          <RUNNABLE-ENTITY><SHORT-NAME>R_${p}</SHORT-NAME><CAN-ENTER>true</CAN-ENTER>` +
          `<RUNS-ON-REF DEST="RUNS-ON-PROVIDER">/RunsOn/RTE</RUNS-ON-REF></RUNNABLE-ENTITY>`
      );
    }
    out.push('        </RUNNABLES></SWC-INTERNAL-BEHAVIOR></INTERNAL-BEHAVIORS>');
    out.push('      </APPLICATION-SW-COMPONENT-TYPE>');
  }
  out.push('    </ELEMENTS></AR-PACKAGE>');

  // ---- assembly connectors (in a composition) ---------------------------
  out.push('    <AR-PACKAGE><SHORT-NAME>Top</SHORT-NAME><ELEMENTS>');
  out.push('      <COMPOSITION-SW-COMPONENT-TYPE><SHORT-NAME>Root</SHORT-NAME><COMPONENTS>');
  for (let s = 0; s < o.swcCount; s++) {
    out.push(
      `        <COMPONENT-PROTOTYPE><SHORT-NAME>I_${s}</SHORT-NAME>` +
        `<TYPE-TREF DEST="APPLICATION-SW-COMPONENT-TYPE">/Comps/Swc_${s}</TYPE-TREF></COMPONENT-PROTOTYPE>`
    );
  }
  out.push('      </COMPONENTS><CONNECTORS>');
  for (let c = 0; c < o.connectors; c++) {
    const from = c % o.swcCount;
    const to = (from + 1) % o.swcCount;
    const port = c % o.portsPerSwc;
    out.push(
      `        <ASSEMBLY-SW-CONNECTOR><SHORT-NAME>C_${c}</SHORT-NAME>` +
        `<PROVIDER-IREF><CONTEXT-COMPONENT-REF DEST="COMPONENT-PROTOTYPE">/Top/Root/I_${from}</CONTEXT-COMPONENT-REF>` +
        `<TARGET-P-COMPONENT-REF>/Top/Root/I_${from}/P_${port}</TARGET-P-COMPONENT-REF></PROVIDER-IREF>` +
        `<REQUESTER-IREF><CONTEXT-COMPONENT-REF DEST="COMPONENT-PROTOTYPE">/Top/Root/I_${to}</CONTEXT-COMPONENT-REF>` +
        `<TARGET-R-PORT-REF>/Top/Root/I_${to}/P_${port}</TARGET-R-PORT-REF></REQUESTER-IREF>` +
        `</ASSEMBLY-SW-CONNECTOR>`
    );
  }
  out.push('      </CONNECTORS></COMPOSITION-SW-COMPONENT-TYPE>');
  out.push('    </ELEMENTS></AR-PACKAGE>');

  out.push('  </AR-PACKAGES>');
  out.push('</AUTOSAR>');
  return out.join('\n');
}

/** Writes the generated benchmark file and returns its path. */
export function writeBenchmarkFile(dir: string, o: GenOptions = DEFAULT_GEN): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `bench_${o.swcCount}x${o.portsPerSwc}x${o.elementsPerPort}.arxml`);
  fs.writeFileSync(file, generateArxml(o));
  return file;
}
