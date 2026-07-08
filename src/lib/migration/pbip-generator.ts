import JSZip from "jszip";
import { EnterpriseAnalysis } from "./enterprise-parser";

/**
 * Generates a full PBIP project structure as a .zip file blob.
 * This can be directly loaded into Power BI Desktop.
 */
export async function generatePbipZip(analysis: EnterpriseAnalysis, projectName: string = "QLIK2PBI_Migration_Project"): Promise<Blob> {
  const zip = new JSZip();

  // Root .pbip file
  const pbipContent = {
    "version": "1.0",
    "artifacts": [
      {
        "dataset": {
          "path": `${projectName}.Dataset`
        }
      }
    ],
    "settings": {
      "enableAutoRecovery": true
    }
  };
  zip.file(`${projectName}.pbip`, JSON.stringify(pbipContent, null, 2));

  // --- Dataset Folder ---
  const datasetFolder = zip.folder(`${projectName}.Dataset`);
  
  // item.metadata.json
  const datasetMetadata = {
    "type": "dataset",
    "displayName": `${projectName}`,
    "description": "Migrated from Qlik using Qlik-Shine Bridge"
  };
  datasetFolder?.file("item.metadata.json", JSON.stringify(datasetMetadata, null, 2));

  // item.config.json
  const datasetConfig = {
    "version": "1.0",
    "logicalId": "00000000-0000-0000-0000-000000000000"
  };
  datasetFolder?.file("item.config.json", JSON.stringify(datasetConfig, null, 2));

  // model.bim (TMSL Format)
  const tables = analysis.semanticModel.tables.map((t: any) => {
    // Determine the partition expression from generated M queries
    const mQuery = analysis.mQueries[t.name] || 'let\n    Source = "M Query missing for this table"\nin\n    Source';
    
    // Convert columns to TMSL format
    const columns = t.columns.map((c: any) => {
      const colDef: any = {
        name: c.name,
        dataType: c.data_type || "string",
        sourceColumn: c.name
      };
      if (c.formatString) {
        colDef.formatString = c.formatString;
      }
      return colDef;
    });

    // Convert measures
    const measures = t.measures?.map((m: any) => ({
      name: m.name,
      expression: [m.expression]
    })) || [];

    return {
      name: t.name,
      columns: columns,
      partitions: [
        {
          name: t.name,
          mode: "import",
          source: {
            type: "m",
            expression: mQuery.split('\n')
          }
        }
      ],
      measures: measures
    };
  });

  const relationships = analysis.semanticModel.relationships.map((r: any) => {
    return {
      name: `${r.fromTable}_${r.fromColumn}_${r.toTable}_${r.toColumn}`,
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
      crossFilteringBehavior: r.direction === "Both" ? "bothDirections" : "oneDirection"
    };
  });

  const modelBim = {
    "name": "SemanticModel",
    "compatibilityLevel": 1550,
    "model": {
      "culture": "en-US",
      "dataAccessOptions": {
        "legacyRedirects": true,
        "returnErrorValuesAsNull": true
      },
      "defaultPowerBIDataSourceVersion": "powerBI_V3",
      "sourceQueryCulture": "en-US",
      "tables": tables,
      "relationships": relationships
    }
  };
  datasetFolder?.file("model.bim", JSON.stringify(modelBim, null, 2));

  // definition.pbism
  const pbism = {
    "version": "1.0",
    "dataset": {
      "model": {
        "path": "model.bim"
      }
    }
  };
  datasetFolder?.file("definition.pbism", JSON.stringify(pbism, null, 2));

  // Generate the zip blob
  return await zip.generateAsync({ type: "blob" });
}
