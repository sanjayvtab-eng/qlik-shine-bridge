import JSZip from "jszip";
import { EnterpriseAnalysis } from "./enterprise-parser";

/**
 * Encodes a JS string as UTF-16 LE bytes (no BOM).
 * Required for DataModelSchema, Report/Layout, Settings, Metadata,
 * DiagramLayout, LinguisticSchema inside a PBIT/PBIX package.
 */
function utf16le(str: string): Uint8Array {
  const buf = new ArrayBuffer(str.length * 2);
  const dv = new DataView(buf);
  for (let i = 0; i < str.length; i++) {
    dv.setUint16(i * 2, str.charCodeAt(i), true); // true = little-endian
  }
  return new Uint8Array(buf);
}

/**
 * Builds the DataMashup binary (a ZIP-in-ZIP) that Power BI Desktop uses
 * to load M queries into the Power Query Editor.
 *
 * Structure:
 *   [Content_Types].xml
 *   Formulas/Section1.m   ← merged M queries as a single M section
 *   Config/Package.json
 */
async function buildDataMashup(mQueries: Record<string, string>): Promise<Uint8Array> {
  const inner = new JSZip();

  // Content types for inner zip
  inner.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml" />' +
    '<Override PartName="/Formulas/Section1.m" ContentType="application/x-ms-powerquery" />' +
    '<Override PartName="/Config/Package.json" ContentType="application/json" />' +
    "</Types>"
  );

  // Build merged M section file
  const tableNames = Object.keys(mQueries);
  const sectionLines: string[] = ["section Section1;", ""];
  for (const tbl of tableNames) {
    const mCode = mQueries[tbl] || `let\n    Source = "No M Query"\nin\n    Source`;
    // Sanitise the query: remove any leading/trailing blank lines
    const trimmed = mCode.trim();
    sectionLines.push(`shared #"${tbl}" =`);
    sectionLines.push(trimmed + ";");
    sectionLines.push("");
  }
  inner.file("Formulas/Section1.m", sectionLines.join("\r\n"));

  // Package config
  inner.file(
    "Config/Package.json",
    JSON.stringify({
      AllowedValues: [],
      IsParameterQuery: false,
      IsParameterQueryRequired: false,
      IsDirectQuery: false
    })
  );

  const bytes = await inner.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 1 }
  });
  return bytes;
}

/**
 * Generates a valid Power BI Template (.pbit) Blob that opens directly
 * in Power BI Desktop, pre-loading all M Queries and DAX measures.
 *
 * A .pbit is an OPC ZIP package requiring these files:
 *   [Content_Types].xml
 *   _rels/.rels               ← REQUIRED by OPC; missing = "corrupted" error
 *   Version
 *   SecurityBindings
 *   Settings                  (UTF-16 LE JSON)
 *   Metadata                  (UTF-16 LE JSON)
 *   DiagramLayout             (UTF-16 LE JSON)
 *   DataModelSchema           (UTF-16 LE TMSL JSON)
 *   DataMashup                (inner ZIP with M code)
 *   Report/Layout             (UTF-16 LE JSON)
 *   Report/LinguisticSchema   (UTF-16 LE JSON)
 */
export async function generatePbitFile(
  analysis: EnterpriseAnalysis,
  projectName: string = "QLIK2PBI_Migration_Project"
): Promise<Blob> {
  const zip = new JSZip();

  // ── 1. _rels/.rels ─────────────────────────────────────────────────────
  //    CRITICAL: Without this OPC relationships file, PBI Desktop reports "corrupted"
  const rels =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Type="http://schemas.microsoft.com/DataMashup" Target="/DataMashup" Id="rId1" />' +
    '<Relationship Type="http://schemas.microsoft.com/DataModelSchema" Target="/DataModelSchema" Id="rId2" />' +
    '<Relationship Type="http://schemas.microsoft.com/DiagramLayout" Target="/DiagramLayout" Id="rId3" />' +
    '<Relationship Type="http://schemas.microsoft.com/ReportLayout" Target="/Report/Layout" Id="rId4" />' +
    '<Relationship Type="http://schemas.microsoft.com/ReportMetadata" Target="/Metadata" Id="rId5" />' +
    '<Relationship Type="http://schemas.microsoft.com/ReportSettings" Target="/Settings" Id="rId6" />' +
    '<Relationship Type="http://schemas.microsoft.com/ReportVersion" Target="/Version" Id="rId7" />' +
    '<Relationship Type="http://schemas.microsoft.com/SecurityBindings" Target="/SecurityBindings" Id="rId8" />' +
    "</Relationships>";
  zip.file("_rels/.rels", rels);

  // ── 2. [Content_Types].xml ─────────────────────────────────────────────
  const contentTypes =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml" />' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />' +
    '<Override PartName="/DataMashup" ContentType="application/octet-stream" />' +
    '<Override PartName="/DataModelSchema" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/DiagramLayout" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Report/Layout" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Report/LinguisticSchema" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Settings" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Metadata" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/SecurityBindings" ContentType="application/octet-stream" />' +
    '<Override PartName="/Version" ContentType="application/octet-stream" />' +
    "</Types>";
  zip.file("[Content_Types].xml", contentTypes);

  // ── 3. Version ─────────────────────────────────────────────────────────
  zip.file("Version", "3.0");

  // ── 4. SecurityBindings (empty, required file) ─────────────────────────
  zip.file("SecurityBindings", new Uint8Array(0));

  // ── 5. Settings ────────────────────────────────────────────────────────
  zip.file("Settings", utf16le(JSON.stringify({
    Version: 3,
    QueryGroups: [],
    parameterQueries: [],
    reportConnections: [],
    slowDataSourceSettings: {}
  })));

  // ── 6. Metadata ────────────────────────────────────────────────────────
  zip.file("Metadata", utf16le(JSON.stringify({
    version: "3.0",
    cultures: [{ name: "en-US" }]
  })));

  // ── 7. DiagramLayout ───────────────────────────────────────────────────
  zip.file("DiagramLayout", utf16le(JSON.stringify({
    version: "0",
    diagrams: []
  })));

  // ── 8. Report/LinguisticSchema ─────────────────────────────────────────
  zip.file("Report/LinguisticSchema", utf16le(JSON.stringify({
    Version: "1.0.0",
    Language: "en-US",
    DynamicImprovement: "HighConfidence",
    Entities: []
  })));

  // ── 9. Build DataModelSchema TMSL ──────────────────────────────────────
  const mQueriesMap: Record<string, string> = analysis.mQueries || {};

  const tables = (analysis.semanticModel?.tables || []).map((t: any) => {
    const mQuery =
      mQueriesMap[t.name] ||
      `let\n    Source = "${t.name} - M Query not yet generated"\nin\n    Source`;

    const columns = (t.columns || []).map((c: any) => {
      const col: any = {
        name: c.name,
        dataType: mapDataType(c.data_type || c.dataType || "string"),
        summarizeBy: "none",
        sourceColumn: c.name
      };
      if (c.formatString) col.formatString = c.formatString;
      return col;
    });

    const measures = (t.measures || []).map((m: any) => ({
      name: m.name,
      expression: m.expression || "",
      ...(m.formatString ? { formatString: m.formatString } : {})
    }));

    const tableObj: any = {
      name: t.name,
      columns,
      partitions: [{
        name: `${t.name}-partition`,
        mode: "import",
        source: {
          type: "m",
          expression: mQuery.split("\n")
        }
      }]
    };
    if (measures.length > 0) tableObj.measures = measures;
    return tableObj;
  });

  const relationships = (analysis.semanticModel?.relationships || []).map((r: any) => ({
    name: `${r.fromTable}_${r.fromColumn}_to_${r.toTable}_${r.toColumn}`,
    fromTable: r.fromTable,
    fromColumn: r.fromColumn,
    toTable: r.toTable,
    toColumn: r.toColumn,
    crossFilteringBehavior: r.direction === "Both" ? "bothDirections" : "oneDirection",
    joinOnDateBehavior: "datePartOnly",
    isActive: true
  }));

  const dataModelSchema = {
    name: projectName,
    compatibilityLevel: 1550,
    model: {
      culture: "en-US",
      collation: "Latin1_General_100_BIN2_UTF8",
      dataAccessOptions: { legacyRedirects: true, returnErrorValuesAsNull: true },
      defaultPowerBIDataSourceVersion: "powerBI_V3",
      sourceQueryCulture: "en-US",
      tables,
      relationships,
      annotations: [{
        name: "PBI_QueryOrder",
        value: JSON.stringify(tables.map((t: any) => t.name))
      }]
    }
  };
  zip.file("DataModelSchema", utf16le(JSON.stringify(dataModelSchema)));

  // ── 10. DataMashup (inner ZIP with M queries for Power Query Editor) ────
  const dataMashup = await buildDataMashup(mQueriesMap);
  zip.file("DataMashup", dataMashup);

  // ── 11. Report/Layout ──────────────────────────────────────────────────
  zip.file("Report/Layout", utf16le(JSON.stringify({
    id: 0,
    resourcePackages: [],
    sections: [{
      id: 0,
      name: "ReportSection",
      displayName: "Page 1",
      filters: "[]",
      ordinal: 0,
      visualContainers: [],
      config: JSON.stringify({
        layouts: [{ id: 0, position: { x: 0, y: 0, z: 0, width: 1280, height: 720 } }],
        singleVisualGroup: []
      }),
      displayOption: 1,
      height: 720,
      width: 1280,
      defaultDisplayOption: 0,
      layoutOptimization: 0
    }],
    config: JSON.stringify({
      version: "5.55",
      themeCollection: {
        baseTheme: { name: "CY24SU02", version: "5.55", type: "SharedResources" }
      },
      activeSectionIndex: 0,
      defaultDragAndDropAreaVisibility: true
    }),
    layoutOptimization: 0
  })));

  // ── 12. Generate final blob ────────────────────────────────────────────
  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 1 }
  });
}

/** Map common SQL/Qlik data types → Power BI TMSL data type strings */
function mapDataType(raw: string): string {
  const t = (raw || "").toLowerCase();
  if (t.includes("int") || t.includes("integer")) return "int64";
  if (t.includes("decimal") || t.includes("float") || t.includes("double") || t.includes("numeric")) return "double";
  if (t.includes("datetime") || (t.includes("date") && t.includes("time"))) return "dateTime";
  if (t.includes("date")) return "dateTime";
  if (t.includes("bool")) return "boolean";
  if (t.includes("currency") || t.includes("money")) return "decimal";
  return "string";
}
