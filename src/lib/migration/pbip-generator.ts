import JSZip from "jszip";
import { EnterpriseAnalysis } from "./enterprise-parser";

/** Generate a random UUIDv4 */
function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c: any) =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

/**
 * Generates a full PBIP (Power BI Project) structure as a .zip file.
 * Following strict rules to prevent Power BI Desktop corruption:
 * 1. Root folder does not end in .pbip
 * 2. .platform files with unique UUIDv4
 * 3. Legacy PBIR (Version 1.0) with report.json
 * 4. M query expression split into string arrays
 * 5. compatibilityLevel 1565
 */
export async function generatePbipZip(
  analysis: EnterpriseAnalysis,
  projectName: string = "QLIK2PBI_Migration"
): Promise<Blob> {
  const zip = new JSZip();

  // Root folder must NOT end in .pbip
  const root = zip.folder(projectName);
  if (!root) throw new Error("Failed to create root folder in ZIP");

  // ── 1. Root Connection File: MyProject.pbip ──
  const pbipContent = {
    version: "1.0",
    artifacts: [
      {
        report: {
          path: `${projectName}.Report`
        }
      }
    ],
    settings: {
      enableAutoRecovery: true
    }
  };
  root.file(`${projectName}.pbip`, JSON.stringify(pbipContent, null, 2));

  // ── 2. Semantic Model Folder ──
  const smFolder = root.folder(`${projectName}.SemanticModel`);
  if (!smFolder) throw new Error("Failed to create SM folder");

  // SM .platform
  const smPlatform = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
    metadata: {
      type: "SemanticModel",
      displayName: projectName
    },
    config: {
      version: "2.0",
      logicalId: uuidv4()
    }
  };
  smFolder.file(".platform", JSON.stringify(smPlatform, null, 2));

  // SM definition.pbism
  const pbism = {
    version: "1.0"
  };
  smFolder.file("definition.pbism", JSON.stringify(pbism, null, 2));

  // SM model.bim (TMSL)
  const mQueriesMap: Record<string, string> = analysis.mQueries || {};
  const tables = (analysis.semanticModel?.tables || []).map((t: any) => {
    const mQuery = mQueriesMap[t.name] || `let\n    Source = "No query"\nin\n    Source`;
    const columns = (t.columns || []).map((c: any) => {
      const col: any = {
        name: c.name,
        dataType: mapDataType(c.data_type || c.dataType || "string"),
        sourceColumn: c.name
      };
      if (c.formatString) col.formatString = c.formatString;
      return col;
    });
    const measures = (t.measures || []).map((m: any) => ({
      name: m.name,
      expression: m.expression ? [m.expression] : [""], // TMSL requires array of strings or single string, let's use array
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
          expression: mQuery.split("\n") // Split by newline! (Rule 3)
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
    isActive: r.active !== false
  }));

  const tableNames = new Set(tables.map((t: any) => t.name));
  const expressions = [];
  for (const [name, query] of Object.entries(mQueriesMap)) {
    if (!tableNames.has(name)) {
      expressions.push({
        name,
        kind: "m",
        expression: query.split("\n")
      });
    }
  }

  const modelBim = {
    name: "SemanticModel",
    compatibilityLevel: 1565, // Rule 5: 1565
    model: {
      culture: "en-US",
      dataAccessOptions: {
        legacyRedirects: true,
        returnErrorValuesAsNull: true
      },
      defaultPowerBIDataSourceVersion: "powerBI_V3",
      sourceQueryCulture: "en-US",
      tables,
      relationships,
      expressions
    }
  };
  smFolder.file("model.bim", JSON.stringify(modelBim, null, 2));


  // ── 3. Report Folder ──
  const reportFolder = root.folder(`${projectName}.Report`);
  if (!reportFolder) throw new Error("Failed to create Report folder");

  // Report .platform
  const reportPlatform = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
    metadata: {
      type: "Report",
      displayName: projectName
    },
    config: {
      version: "2.0",
      logicalId: uuidv4()
    }
  };
  reportFolder.file(".platform", JSON.stringify(reportPlatform, null, 2));

  // Report definition.pbir (Legacy Version 1.0)
  const pbir = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
    version: "1.0",
    datasetReference: {
      byPath: {
        path: `../${projectName}.SemanticModel`
      }
    }
  };
  reportFolder.file("definition.pbir", JSON.stringify(pbir, null, 2));

  // Report report.json
  const reportJson = {
    version: "5.0",
    themeCollection: { baseTheme: { name: "CY24SU06", version: "6.0", type: 2 } },
    activeSectionIndex: 0,
    config: "{\"version\":\"5.0\",\"themeCollection\":{\"baseTheme\":{\"name\":\"CY24SU06\",\"version\":\"6.0\",\"type\":2}},\"activeSectionIndex\":0,\"defaultDrillFilterOtherVisuals\":true,\"settings\":{\"useNewFilterPaneExperience\":true,\"allowChangeFilterTypes\":true,\"useStylableVisualContainerHeader\":true,\"persistentFiltersEnabled\":true}}",
    layoutOptimization: 0,
    sections: [{
      name: "ReportSection",
      displayName: "Migration Review",
      filters: "[]",
      ordinal: 0,
      visualContainers: [],
      config: "{\"layouts\":[{\"id\":0,\"position\":{\"x\":0,\"y\":0,\"z\":0,\"width\":1280,\"height\":720,\"tabOrder\":0}}]}",
      width: 1280,
      height: 720
    }]
  };
  reportFolder.file("report.json", JSON.stringify(reportJson, null, 2));

  // Generate zip
  return await zip.generateAsync({ type: "blob" });
}

function mapDataType(raw: string): string {
  const t = (raw || "").toLowerCase();
  if (t.includes("int")) return "int64";
  if (t.includes("decimal") || t.includes("float") || t.includes("double") || t.includes("numeric")) return "double";
  if (t.includes("datetime") || (t.includes("date") && t.includes("time"))) return "dateTime";
  if (t.includes("date")) return "dateTime";
  if (t.includes("bool")) return "boolean";
  if (t.includes("currency") || t.includes("money")) return "decimal";
  return "string";
}
