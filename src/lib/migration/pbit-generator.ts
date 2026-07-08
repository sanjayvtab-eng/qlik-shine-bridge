import JSZip from "jszip";
import { EnterpriseAnalysis } from "./enterprise-parser";

/**
 * Converts a JS string to a UTF-16 LE Buffer (no BOM).
 * Power BI's PBIT format requires DataModelSchema, Report/Layout,
 * Settings, and Metadata to all be UTF-16 LE encoded.
 */
function utf16le(str: string): Uint8Array {
  const buf = new ArrayBuffer(str.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < str.length; i++) {
    view.setUint16(i * 2, str.charCodeAt(i), true); // true = little-endian
  }
  return new Uint8Array(buf);
}

/**
 * Generates a valid Power BI Template (.pbit) file as a downloadable Blob.
 *
 * A .pbit is a ZIP (using DEFLATE or STORE) containing:
 *   [Content_Types].xml   — UTF-8 XML content type manifest
 *   Version               — plain ASCII "3.0"
 *   Settings              — UTF-16 LE JSON (empty report settings)
 *   Metadata              — UTF-16 LE JSON (culture metadata)
 *   DiagramLayout         — UTF-16 LE JSON (empty diagram)
 *   DataModelSchema       — UTF-16 LE TMSL JSON (tables + M queries + DAX + relationships)
 *   Report/Layout         — UTF-16 LE JSON (minimal blank report page)
 *
 * Power BI Desktop reads the DataModelSchema and loads all M queries into
 * the Query Editor and all measures into the data model automatically.
 */
export async function generatePbitFile(
  analysis: EnterpriseAnalysis,
  projectName: string = "QLIK2PBI_Migration_Project"
): Promise<Blob> {
  const zip = new JSZip();

  // ── 1. [Content_Types].xml ─────────────────────────────────────────────
  const contentTypes =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="xml" ContentType="application/xml" />' +
    '<Override PartName="/DataModelSchema" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/DiagramLayout" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Report/Layout" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Settings" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Metadata" ContentType="application/json;charset=utf-16le" />' +
    '<Override PartName="/Version" ContentType="application/octet-stream" />' +
    "</Types>";
  zip.file("[Content_Types].xml", contentTypes);

  // ── 2. Version ─────────────────────────────────────────────────────────
  zip.file("Version", "3.0");

  // ── 3. Settings ────────────────────────────────────────────────────────
  const settings = JSON.stringify({
    Version: 3,
    IsDefaultTemplate: false,
    QueryGroups: [],
    parameterQueries: [],
    reportConnections: [],
    slowDataSourceSettings: {}
  });
  zip.file("Settings", utf16le(settings));

  // ── 4. Metadata ────────────────────────────────────────────────────────
  const metadata = JSON.stringify({
    version: "3.0",
    cultures: [{ name: "en-US" }]
  });
  zip.file("Metadata", utf16le(metadata));

  // ── 5. DiagramLayout ───────────────────────────────────────────────────
  const diagramLayout = JSON.stringify({
    version: "0",
    diagrams: []
  });
  zip.file("DiagramLayout", utf16le(diagramLayout));

  // ── 6. Build DataModelSchema (TMSL) ────────────────────────────────────
  const tables = analysis.semanticModel.tables.map((t: any) => {
    const mQuery =
      (analysis.mQueries && analysis.mQueries[t.name]) ||
      `let\n    Source = "No M Query found for ${t.name}"\nin\n    Source`;

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
      partitions: [
        {
          name: `${t.name}-partition`,
          mode: "import",
          source: {
            type: "m",
            expression: mQuery.split("\n")
          }
        }
      ]
    };
    if (measures.length > 0) tableObj.measures = measures;
    return tableObj;
  });

  const relationships = (analysis.semanticModel.relationships || []).map(
    (r: any) => ({
      name: `${r.fromTable}_${r.fromColumn}_to_${r.toTable}_${r.toColumn}`,
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      crossFilteringBehavior:
        r.direction === "Both" ? "bothDirections" : "oneDirection",
      joinOnDateBehavior: "datePartOnly",
      isActive: true
    })
  );

  const dataModelSchema = {
    name: projectName,
    compatibilityLevel: 1550,
    model: {
      culture: "en-US",
      collation: "Latin1_General_100_BIN2_UTF8",
      dataAccessOptions: {
        legacyRedirects: true,
        returnErrorValuesAsNull: true
      },
      defaultPowerBIDataSourceVersion: "powerBI_V3",
      sourceQueryCulture: "en-US",
      tables,
      relationships,
      annotations: [
        {
          name: "PBI_QueryOrder",
          value: JSON.stringify(tables.map((t) => t.name))
        }
      ]
    }
  };

  zip.file("DataModelSchema", utf16le(JSON.stringify(dataModelSchema)));

  // ── 7. Report/Layout ───────────────────────────────────────────────────
  const layout = {
    id: 0,
    resourcePackages: [],
    sections: [
      {
        id: 0,
        name: "ReportSection",
        displayName: "Page 1",
        filters: "[]",
        ordinal: 0,
        visualContainers: [],
        config: JSON.stringify({
          layouts: [
            {
              id: 0,
              position: { x: 0, y: 0, z: 0, width: 1280, height: 720 }
            }
          ],
          singleVisualGroup: []
        }),
        displayOption: 1,
        height: 720,
        width: 1280,
        defaultDisplayOption: 0,
        layoutOptimization: 0
      }
    ],
    config: JSON.stringify({
      version: "5.55",
      themeCollection: {
        baseTheme: {
          name: "CY24SU02",
          version: "5.55",
          type: "SharedResources"
        }
      },
      activeSectionIndex: 0,
      defaultDragAndDropAreaVisibility: true
    }),
    layoutOptimization: 0
  };
  zip.file("Report/Layout", utf16le(JSON.stringify(layout)));

  // ── 8. Generate blob ───────────────────────────────────────────────────
  return await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 1 }
  });
}

/** Map common SQL/Qlik data types to Power BI/TMSL data type strings */
function mapDataType(raw: string): string {
  const t = (raw || "").toLowerCase();
  if (t.includes("int") || t.includes("integer")) return "int64";
  if (
    t.includes("decimal") ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("numeric")
  )
    return "double";
  if (t.includes("datetime") || (t.includes("date") && t.includes("time")))
    return "dateTime";
  if (t.includes("date")) return "dateTime";
  if (t.includes("bool")) return "boolean";
  if (t.includes("currency") || t.includes("money")) return "decimal";
  return "string";
}
