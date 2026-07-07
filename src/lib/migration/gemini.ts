import type { Requirement, BusinessMetadata, TechnicalMetadata, FinalTable, SourceTable } from "./types";

// Programmatic model constants for fallback orchestration
const PRIMARY_MODEL = "gemini-3.5-flash";
const FALLBACK_MODEL = "gemini-3.5-flash";

let isProExhausted = false;

function getActiveModel(preferredModel: string): string {
  if (preferredModel === PRIMARY_MODEL && isProExhausted) {
    console.info(`[Engine] ${PRIMARY_MODEL} is marked as exhausted. Directing request to ${FALLBACK_MODEL} directly.`);
    return FALLBACK_MODEL;
  }
  return preferredModel;
}

const getApiKey = (): string => {
  const envKey = import.meta.env?.VITE_GEMINI_API_KEY || import.meta.env?.GEMINI_API_KEY;
  if (envKey && envKey.trim() !== "") {
    return envKey.trim();
  }
  return "";
};

function compressQvsScriptForAi(text: string): string {
  if (!text) return "";
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "") 
    .replace(/\/\/.*$/gm, "")         
    .replace(/^\s*REM\s.*$/gim, "")   
    .replace(/[ \t]+/g, " ")          
    .replace(/;\s*/g, ";\n")          
    .split("\n")
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0)
    .join("\n");
}

function sanitizeJsonString(rawJson: string): string {
  let clean = rawJson.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  }
  
  let inString = false;
  let isEscaped = false;
  let result = "";
  const stack: ('{' | '[')[] = [];
  
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (inString) {
      if (char === '\\' && !isEscaped) {
        isEscaped = true;
        result += char;
      } else if (char === '"' && !isEscaped) {
        inString = false;
        result += char;
      } else if (isEscaped) {
        result += char;
        isEscaped = false;
      } else {
        if (char === '\n') result += '\\n';
        else if (char === '\r') result += '\\r';
        else if (char === '\t') result += '\\t';
        else result += char;
      }
    } else {
      if (char === '"') inString = true;
      else if (char === '{') stack.push('{');
      else if (char === '}') { if (stack.length > 0 && stack[stack.length - 1] === '{') stack.pop(); }
      else if (char === '[') stack.push('[');
      else if (char === ']') { if (stack.length > 0 && stack[stack.length - 1] === '[') stack.pop(); }
      result += char;
    }
  }
  if (inString) result += '"';
  result = result.replace(/,\s*$/, '');
  if (result.match(/:\s*$/)) result += 'null';
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === '{') result += '}';
    else if (top === '[') result += ']';
  }
  return result;
}

/**
 * Intelligent fetch wrapper that handles 429 Rate Limits using exponential backoff.
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, initialDelay = 10000): Promise<Response> {
  let currentDelay = initialDelay;
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status === 503) {
      console.info(`[Gemini API] Rate limit (${response.status}) reached on attempt ${i + 1}. Sleeping for ${currentDelay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      currentDelay *= 1.5; // Exponential backoff
      continue;
    }
    return response;
  }
  return fetch(url, options);
}

export async function generateRuleBookViaAi(requirement: Requirement): Promise<string> {
  const template = `# Qlik to Power BI Migration Rule Book
## Report Name\n{{ReportName}}\n## Business Objective\n{{BusinessObjective}}\n## Business Requirement\n{{BusinessRequirement}}\n## Source Tables\n{{SourceTableNames}}\n## Source Columns\n{{SourceColumnNames}}\n## Expected Output\n{{ExpectedOutput}}
## Migration Rules
- Analyze the uploaded Source QVS and ETL QVS scripts.
- Preserve the complete ETL logic and map individual stages directly to equivalent target Power Query transformations.`;

  return template
    .replace("{{ReportName}}", requirement.reportName || "—")
    .replace("{{BusinessObjective}}", requirement.businessObjective || "—")
    .replace("{{BusinessRequirement}}", requirement.businessRequirement || "—")
    .replace("{{SourceTableNames}}", requirement.sourceTableNames || "—")
    .replace("{{SourceColumnNames}}", requirement.sourceColumnNames || "—")
    .replace("{{ExpectedOutput}}", requirement.expectedOutput || "—");
}

/**
 * STAGE 3 MAIN ENTRANCE POINT
 * Orchestrates dual-pass logic analysis with automatic runtime fallback resilience.
 */
export async function analyzeQvsScriptsViaAi(
  requirement: Requirement,
  ruleBookMd: string,
  sourceQvsText: string,
  etlQvsText: string,
  parserHints?: any,
  onProgress?: (msg: string) => void
): Promise<{ businessMetadata: BusinessMetadata; technicalMetadata: TechnicalMetadata; executionMetrics: any }> {
  
  let stage3A: any;
  let stage3B: any;
  let finalModelUsed = getActiveModel(PRIMARY_MODEL);

  try {
    if (finalModelUsed === PRIMARY_MODEL) {
      console.log(`[Engine] Initializing structural analysis pass via ${PRIMARY_MODEL}...`);
      if (onProgress) onProgress("Extracting structural blueprint (Stage 3A)...");
      stage3A = await analyzeStage3A(requirement, ruleBookMd, sourceQvsText, etlQvsText, PRIMARY_MODEL, parserHints);
      
      // Throttle delay to protect token allocation bucket space
      if (onProgress) onProgress("Structuring relationships (Stage 3B)...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      console.log(`[Engine] Initializing semantic validation pass via ${PRIMARY_MODEL}...`);
      stage3B = await analyzeStage3B(requirement, ruleBookMd, sourceQvsText, etlQvsText, stage3A, PRIMARY_MODEL);
    } else {
      console.log(`[Engine] Skipping ${PRIMARY_MODEL} due to session-level rate limit. Using ${FALLBACK_MODEL} directly.`);
      if (onProgress) onProgress("Extracting structural blueprint via Fallback...");
      stage3A = await analyzeStage3A(requirement, ruleBookMd, sourceQvsText, etlQvsText, FALLBACK_MODEL, parserHints);
      if (onProgress) onProgress("Structuring relationships via Fallback...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      stage3B = await analyzeStage3B(requirement, ruleBookMd, sourceQvsText, etlQvsText, stage3A, FALLBACK_MODEL);
    }
  } catch (error: any) {
    if (finalModelUsed === PRIMARY_MODEL) {
      console.info(`[Engine Fallback] ${PRIMARY_MODEL} rate limits encountered. Activating secondary engine (${FALLBACK_MODEL})...`);
      isProExhausted = true;
      finalModelUsed = FALLBACK_MODEL;
      
      if (onProgress) onProgress("Rate limit hit. Retrying structural extraction...");
      stage3A = await analyzeStage3A(requirement, ruleBookMd, sourceQvsText, etlQvsText, FALLBACK_MODEL, parserHints);
      if (onProgress) onProgress("Retrying relationship structuring...");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      stage3B = await analyzeStage3B(requirement, ruleBookMd, sourceQvsText, etlQvsText, stage3A, FALLBACK_MODEL);
    } else {
      throw error;
    }
  }

  const unifiedTechnical: TechnicalMetadata = {
    statementMetrics: stage3A.statementMetrics || { totalLoadStatements: 0, totalJoinStatements: 0, totalResidentLoads: 0, totalApplyMapCalls: 0 },
    executionOrder: stage3B.executionOrder || [],
    lineageGraph: stage3A.lineageGraph || [],
    droppedTables: stage3A.droppedTables || [],
    joins: stage3A.joins || [],
    residentLoads: stage3A.residentLoads || [],
    applyMaps: stage3A.applyMaps || [],
    concatenateOperations: stage3A.concatenateOperations || [],
    renameOperations: stage3B.renameOperations || [],
    filters: stage3B.filters || [],
    sourceTables: (stage3A.sourceTables && stage3A.sourceTables.length > 0) ? stage3A.sourceTables : (parserHints?.srcTables || []),
    allTables: (stage3A.allTables && stage3A.allTables.length > 0) ? stage3A.allTables : [
      ...(parserHints?.srcTables || []).map((t: any) => ({ name: t.name, stepType: "SOURCE" })),
      ...(parserHints?.etlRes?.finalTables || []).map((t: any) => ({ name: t.name, stepType: "FINAL" }))
    ],
    finalTables: (stage3A.finalTables && stage3A.finalTables.length > 0) ? stage3A.finalTables : (parserHints?.etlRes?.finalTables || []),
    relationships: stage3B.relationships || [],
    variables: stage3B.variables || {},
    executionGraph: (stage3A.executionGraph && stage3A.executionGraph.length > 0) ? stage3A.executionGraph : (parserHints?.etlRes?.executionGraph || [])
  };

  const executionMetrics = {
    analysisConfidence: finalModelUsed === PRIMARY_MODEL ? 1.0 : 0.85, 
    metadataCompleteness: 1.0,
    warnings: [] as string[],
    missingTablesCount: 0,
    missingColumnsCount: 0,
    activeEngineTier: finalModelUsed
  };

  const allTablesSet = new Set<string>((unifiedTechnical.allTables || []).map((t: FinalTable) => t.name));
  const finalTablesMap = new Map<string, Set<string>>(
    (unifiedTechnical.finalTables || []).map((t: FinalTable) => [t.name, new Set<string>((t.columns || []).map((c: { name: string }) => c.name))])
  );
  const sourceTablesMap = new Map<string, Set<string>>(
    (unifiedTechnical.sourceTables || []).map((t: SourceTable) => [t.name, new Set<string>((t.columns || []).map((c: { name: string }) => c.name))])
  );

  const lookupColumnInModel = (tableName: string, columnName: string): boolean => {
    return finalTablesMap.get(tableName)?.has(columnName) || sourceTablesMap.get(tableName)?.has(columnName) || false;
  };

  const metrics = unifiedTechnical.statementMetrics;
  if (metrics.totalJoinStatements > 0 && unifiedTechnical.joins.length === 0) {
    executionMetrics.warnings.push(`Script declares ${metrics.totalJoinStatements} JOIN modifiers, but 0 parsed into schema.`);
  }
  if (metrics.totalResidentLoads > 0 && unifiedTechnical.residentLoads.length === 0) {
    executionMetrics.warnings.push(`Script declares ${metrics.totalResidentLoads} RESIDENT scopes, but 0 parsed into schema.`);
  }

  for (const table of unifiedTechnical.finalTables) {
    if (!table.columns || table.columns.length === 0) {
      executionMetrics.missingColumnsCount++;
      executionMetrics.warnings.push(`Target table '${table.name}' does not contain column configurations.`);
    }
    if (!allTablesSet.has(table.name)) {
      executionMetrics.missingTablesCount++;
      executionMetrics.warnings.push(`Final model table '${table.name}' is missing from the master allTables array.`);
    }
    for (const srcName of table.sourceTables) {
      if (!allTablesSet.has(srcName) && !sourceTablesMap.has(srcName)) {
        executionMetrics.missingTablesCount++;
        executionMetrics.warnings.push(`Final step table '${table.name}' references an unrecognized upstream ancestor dependency: '${srcName}'.`);
      }
    }
  }

  for (const rel of unifiedTechnical.relationships) {
    const fromTableExists = finalTablesMap.has(rel.fromTable) || sourceTablesMap.has(rel.fromTable);
    const toTableExists = finalTablesMap.has(rel.toTable) || sourceTablesMap.has(rel.toTable);

    if (!fromTableExists) {
      executionMetrics.missingTablesCount++;
      executionMetrics.warnings.push(`Relationship tracking connector '${rel.id}' references a missing 'from' table: '${rel.fromTable}'`);
    } else if (!lookupColumnInModel(rel.fromTable, rel.fromColumn)) {
      executionMetrics.missingColumnsCount++;
      executionMetrics.warnings.push(`Relationship tracking connector '${rel.id}' references a missing field entry: '${rel.fromTable}'.'${rel.fromColumn}'`);
    }

    if (!toTableExists) {
      executionMetrics.missingTablesCount++;
      executionMetrics.warnings.push(`Relationship tracking connector '${rel.id}' references a missing 'to' table: '${rel.toTable}'`);
    } else if (!lookupColumnInModel(rel.toTable, rel.toColumn)) {
      executionMetrics.missingColumnsCount++;
      executionMetrics.warnings.push(`Relationship tracking connector '${rel.id}' references a missing field entry: '${rel.toTable}'.'${rel.toColumn}'`);
    }
  }

  if (executionMetrics.warnings.length > 0) {
    executionMetrics.analysisConfidence = Math.max(0.4, executionMetrics.analysisConfidence - (executionMetrics.warnings.length * 0.05));
    executionMetrics.metadataCompleteness = Math.max(0.4, 1.0 - ((executionMetrics.missingTablesCount * 0.1) + (executionMetrics.missingColumnsCount * 0.04)));
  }

  return { 
    businessMetadata: stage3B.businessMetadata, 
    technicalMetadata: unifiedTechnical,
    executionMetrics
  };
}

/**
 * STAGE 3A: Focuses strictly on Extracting Schema Shapes, Lineage, and Data Flow Mechanics
 */
async function analyzeStage3A(
  requirement: Requirement,
  ruleBookMd: string,
  sourceQvsText: string,
  etlQvsText: string,
  targetModel: string,
  parserHints?: any
): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key configuration error.");

  const streamlinedSource = compressQvsScriptForAi(sourceQvsText);
  const streamlinedEtl = compressQvsScriptForAi(etlQvsText);

  const prompt = `
    You are an expert Qlik Data Architecture Engine. Analyze the provided scripts to isolate table shapes, execution footprints, and structural lineage blocks according to the Migration Rule Book rules.
    
    ### MIGRATION RULE BOOK GUIDELINES:
    ${ruleBookMd}

    ${parserHints ? `
    ### BASELINE STRUCTURAL HINTS:
    The following structural baseline was extracted using a deterministic parser. You MUST use this as a strong foundation to guarantee you don't miss tables.
    Source Tables Found: ${parserHints.srcTables.map((t:any) => t.name).join(", ")}
    Final Tables Found: ${parserHints.etlRes.finalTables.map((t:any) => t.name).join(", ")}
    Execution Graph Nodes: ${parserHints.etlRes.executionGraph.map((t:any) => t.id).join(", ")}
    ` : ""}

    ### CORE OBJECTIVES:
    1. Count and return precise total telemetry metrics for LOAD, JOIN, RESIDENT, and APPLYMAP operations.
    2. Document source schema structures and target surviving final dataset definitions.
    3. Trace explicit table lineages, joins, appends, and specialized resident source states.

    ### Input Context:
    - Requirements Context: ${JSON.stringify(requirement)}
    - Script Data 1 (Source): ${streamlinedSource}
    - Script Data 2 (ETL): ${streamlinedEtl}
  `;

  const schema3A = {
    type: "OBJECT",
    properties: {
      statementMetrics: {
        type: "OBJECT",
        properties: {
          totalLoadStatements: { type: "INTEGER" },
          totalJoinStatements: { type: "INTEGER" },
          totalResidentLoads: { type: "INTEGER" },
          totalApplyMapCalls: { type: "INTEGER" }
        },
        required: ["totalLoadStatements", "totalJoinStatements", "totalResidentLoads", "totalApplyMapCalls"]
      },
      lineageGraph: { type: "ARRAY", items: { type: "STRING" } },
      droppedTables: { type: "ARRAY", items: { type: "STRING" } },
      joins: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            type: { type: "STRING", enum: ["Left", "Right", "Inner", "Outer"] },
            leftTable: { type: "STRING" },
            rightTable: { type: "STRING" },
            joinKeys: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["type", "leftTable", "rightTable", "joinKeys"]
        }
      },
      residentLoads: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            targetTable: { type: "STRING" },
            sourceResidentTable: { type: "STRING" }
          },
          required: ["targetTable", "sourceResidentTable"]
        }
      },
      applyMaps: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            mapName: { type: "STRING" },
            targetTable: { type: "STRING" },
            targetField: { type: "STRING" },
            lookupKeyField: { type: "STRING" }
          },
          required: ["mapName", "targetTable", "targetField", "lookupKeyField"]
        }
      },
      concatenateOperations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            baseTable: { type: "STRING" },
            appendedTable: { type: "STRING" },
            isImplicit: { type: "BOOLEAN" }
          },
          required: ["baseTable", "appendedTable", "isImplicit"]
        }
      },
      sourceTables: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            name: { type: "STRING" },
            platform: { type: "STRING" },
            columns: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: { name: { type: "STRING" }, dataType: { type: "STRING" } },
                required: ["name", "dataType"]
              }
            }
          },
          required: ["id", "name", "platform", "columns"]
        }
      },
      allTables: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { name: { type: "STRING" }, type: { type: "STRING" } },
          required: ["name", "type"]
        }
      },
      finalTables: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            name: { type: "STRING" },
            type: { type: "STRING", enum: ["Fact", "Dimension", "Calendar", "Bridge", "Mapping"] },
            sourceTables: { type: "ARRAY", items: { type: "STRING" } },
            isFinal: { type: "BOOLEAN" },
            lineage: { type: "ARRAY", items: { type: "STRING" } },
            columns: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  dataType: { type: "STRING" },
                  derived: { type: "BOOLEAN" },
                  expression: { type: "STRING" }
                },
                required: ["name", "dataType"]
              }
            }
          },
          required: ["id", "name", "type", "columns", "sourceTables", "isFinal"]
        }
      },
      executionGraph: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            operation: { type: "STRING", enum: ["LOAD", "RESIDENT", "JOIN", "KEEP", "CONCATENATE", "APPLYMAP", "DROP", "RENAME_TABLE", "RENAME_FIELD", "DERIVED", "DROP_FIELD"] },
            sequenceOrder: { type: "INTEGER" },
            inputNodes: { type: "ARRAY", items: { type: "STRING" } },
            outputTable: { type: "STRING" },
            meta: { type: "OBJECT" },
            rawExpression: { type: "STRING" }
          },
          required: ["id", "operation", "sequenceOrder", "inputNodes", "outputTable", "meta", "rawExpression"]
        }
      }
    },
    required: ["statementMetrics", "lineageGraph", "joins", "residentLoads", "applyMaps", "concatenateOperations", "sourceTables", "allTables", "finalTables", "executionGraph"]
  };

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetchWithRetry(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: schema3A
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API Error (Stage 3A Structural Engine): ${response.statusText}`);
      }

      const result = await response.json();
      return JSON.parse(sanitizeJsonString(result?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"));
    } catch (e) {
      console.warn(`[Stage 3A] JSON syntax error from Gemini on attempt ${attempt}: ${(e as Error).message}. Retrying...`);
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

/**
 * STAGE 3B: Processes Functional Logic, Filters, Operational Sequences, Modifiers, and System Variables
 */
async function analyzeStage3B(
  requirement: Requirement,
  ruleBookMd: string,
  sourceQvsText: string,
  etlQvsText: string,
  structuralBlueprint: any,
  targetModel: string
): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key configuration error.");

  const streamlinedSource = compressQvsScriptForAi(sourceQvsText);
  const streamlinedEtl = compressQvsScriptForAi(etlQvsText);

  // ✅ Fixed: Added complete, hyper-restrictive literal Extraction Rules block
  const prompt = `
    You are an elite Qlik Functional Logic Compiler. Your focus is mapping sequence logs, filters, renames, relationship definitions, and environment variables based on the Migration Rule Book rules.
    
    ### MIGRATION RULE BOOK GUIDELINES:
    ${ruleBookMd}

    ### BUSINESS METADATA EXTRACTION RULES
    Populate businessMetadata ONLY from the Requirement Input and Migration Rule Book.
    Do NOT infer, rename, normalize, or invent any source or final table names.
    expectedTables MUST contain ONLY the source tables listed in "Source Table Names" from the Rule Book.
    expectedFinalTables MUST contain ONLY the final output tables listed in "Expected Output" from the Rule Book.
    Never create names such as FactSales, FactSales_Map, SalesFact, Customer_Map, or any intermediate table unless they explicitly exist in the Rule Book.

    If the Rule Book specifies:
    Source Tables:
    Sales2025_Stg
    Sales2026_Stg
    Customers_Stg
    Customer_Attributes_Stg
    Products_Stg
    Regions_Stg
    Then expectedTables must contain exactly those names.

    If the Rule Book specifies:
    FactSales_Final
    Products
    Regions
    Calendar
    Then expectedFinalTables must contain exactly those names.

    ### CRITICAL ARCHITECTURAL BOUNDARY BOUNDING CLAUSE:
    You MUST treat the provided 'Structural Architecture Context' layout blueprint as IMMUTABLE. 
    - Do NOT invent, drop, modify, or redefine table structures or table names. 
    - Enrich ONLY the existing blueprint schemas by detailing variables, data relationships, where filters, and sequence logs.

    ### Provided Structural Architecture Context Blueprint:
    ${JSON.stringify(structuralBlueprint)}

    ### Input Context:
    - Original Source Requirements Profile: ${JSON.stringify(requirement)}
    - Script Ingests (Compressed):
    ${streamlinedSource}
    ${streamlinedEtl}
  `;

  const schema3B = {
    type: "OBJECT",
    properties: {
      businessMetadata: {
        type: "OBJECT",
        properties: {
          reportName: { type: "STRING" },
          businessObjective: { type: "STRING" },
          businessRequirement: { type: "STRING" },
          expectedOutput: { type: "STRING" },
          businessRules: { type: "ARRAY", items: { type: "STRING" } },
          expectedTables: { type: "ARRAY", items: { type: "STRING" } },
          expectedFinalTables: { type: "ARRAY", items: { type: "STRING" } },
          expectedColumns: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["reportName", "businessObjective", "businessRequirement", "expectedOutput", "businessRules"]
      },
      executionOrder: { type: "ARRAY", items: { type: "STRING" } },
      renameOperations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            tableName: { type: "STRING" },
            originalFieldName: { type: "STRING" },
            newFieldName: { type: "STRING" }
          },
          required: ["tableName", "originalFieldName", "newFieldName"]
        }
      },
      filters: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            tableName: { type: "STRING" },
            clauseExpression: { type: "STRING" },
            type: { type: "STRING", enum: ["WHERE", "HAVING", "INNER_JOIN_FILTER"] }
          },
          required: ["tableName", "clauseExpression", "type"]
        }
      },
      relationships: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            fromTable: { type: "STRING" },
            fromColumn: { type: "STRING" },
            toTable: { type: "STRING" },
            toColumn: { type: "STRING" },
            cardinality: { type: "STRING", enum: ["1:1", "1:N", "N:1", "N:N"] }
          },
          required: ["id", "fromTable", "fromColumn", "toTable", "toColumn", "cardinality"]
        }
      },
      variables: { type: "OBJECT" }
    },
    required: ["businessMetadata", "executionOrder", "renameOperations", "filters", "relationships", "variables"]
  };

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
  const response = await fetchWithRetry(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 8192, 
        responseMimeType: "application/json",
        responseSchema: schema3B
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("Stage 3B Parsing Failure: " + errText);
  }
  const result = await response.json();
  return JSON.parse(sanitizeJsonString(result?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"));
}

import qlikToPbiCompleteRulebook from './docs/Qlik_to_PowerBI_Complete_Rulebook.md?raw';
import qlikToPbiEquivalentReference from './docs/Qlik_to_PowerBI_Equivalent_Reference_v2.md?raw';

export async function generatePowerQueryViaAi(
  businessMetadata: BusinessMetadata,
  technicalMetadata: TechnicalMetadata,
  ruleBookMd: string,
  sourceQvsText?: string,
  etlQvsText?: string,
  columnTypeEdits?: Record<string, string>,
  onProgress?: (msg: string) => void
): Promise<{ table: string; code: string }[]> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key is missing.");

  const finalTables = technicalMetadata.finalTables || [];
  if (finalTables.length === 0) return [];

  const results: { table: string; code: string }[] = [];
  const CHUNK_SIZE = 2; // Process in chunks of 2 tables to prevent 503 Deadline Exceeded
  let pqEngineModel = getActiveModel(PRIMARY_MODEL);

  for (let i = 0; i < finalTables.length; i += CHUNK_SIZE) {
    const chunk = finalTables.slice(i, i + CHUNK_SIZE);
    const chunkMetadata = { ...technicalMetadata, finalTables: chunk };
    if (onProgress) onProgress(`Compiling M Query for chunk ${Math.floor(i / CHUNK_SIZE) + 1} of ${Math.ceil(finalTables.length / CHUNK_SIZE)}...`);

    const prompt = `
    You are an elite, strictly rule-driven Power BI Power Query M-Code Compiler.
    Your ONLY source of truth is the Migration Rule Book and the knowledge files provided below. Generate production-ready Power Query M code strictly from the raw QVS scripts.

    ### MIGRATION RULE BOOK GUIDELINES (Specific to this migration):
    ${ruleBookMd}

    ### SUPPLEMENTARY KNOWLEDGE BASE (Qlik to Power BI Equivalents):
    ${qlikToPbiEquivalentReference}

    ### COMPLETE RULEBOOK REFERENCE (General Translation Rules):
    ${qlikToPbiCompleteRulebook}

    ### CORE OBJECTIVES:
    1. Iterate over every final table defined in the Technical Metadata.
    2. Read the execution graph lineage nodes to understand transformations (LOAD, JOIN, RESIDENT, APPLYMAP, RENAME, etc.).
    3. Analyze the RAW QVS scripts to extract granular ETL logic, field selections, filters, and inline calculations.
    4. Translate Qlik transformations to Power Query M strictly per the Rule Book.
    5. CRITICAL: The "table" name in your JSON output MUST EXACTLY MATCH the name of the final table in the Technical Metadata (e.g., "FactSales_Final", NOT "FactSales" or "AddSalesBand").

    ### STRICT CONSTRAINTS & PRODUCTION REQUIREMENTS (ALL MANDATORY):

    **[1] NO SIMULATED OR PLACEHOLDER DATA**
    - ABSOLUTELY FORBIDDEN: Do NOT generate #table(...) with hardcoded rows, SimulatedQVDData, SimulatedSales2025, or any fake in-memory tables.
    - Every query must reference an actual connector expression, not sample rows.
    - If the actual target source is unknown, emit a connector stub with a clear TODO comment, never fabricate rows.

    **[2] SMART SOURCE CONNECTOR DETECTION WITH FULL NAVIGATION TABLE**
    - Step 1: CAREFULLY read the raw QVS script for the exact source type:
      a) Look for LIB CONNECT TO 'ConnectionName' statements (e.g., 'SQL Server', 'Oracle', 'Snowflake', 'Databricks').
      b) Look for file extensions in LOAD ... FROM paths (.csv, .xlsx, .xls, .qvd).
      c) Only default to Sql.Database if the script contains an explicit SQL connection string.
    - Step 2: Emit the connector that EXACTLY matches the detected source, NOT a hardcoded generic one:
      - 'SQL Server' / ODBC / OLEDB SQL → Sql.Database("TODO_Server", "TODO_Database")
      - Oracle → Oracle.Database("TODO_Server")
      - Databricks → Databricks.Catalogs("TODO_Host", "/sql/1.0/warehouses/TODO_Id")
      - Snowflake → Snowflake.Databases("TODO_Account.snowflakecomputing.com")
      - Excel (.xlsx/.xls) → Excel.Workbook(File.Contents(vSourcePath & "filename.xlsx"), null, true)
      - CSV (.csv) → Csv.Document(File.Contents(vSourcePath & "filename.csv"), [Delimiter=",", Encoding=65001])
      - QVD with no known target → use Csv.Document(File.Contents(vSourcePath & "filename.csv"), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]) /* TODO: was QVD: "filename.qvd" — replace with your actual target connector */
    - Step 3 (CRITICAL for database connectors): Sql.Database(), Oracle.Database(), Databricks, and Snowflake return navigation tables, NOT flat data. Navigate to the actual table:
      \`\`\`
      Source        = Sql.Database("server", "db"),
      dbo_TableName = Source{[Schema="dbo", Item="TableName"]}[Data]
      \`\`\`
      For Excel: navigate via \`{[Item="SheetName", Kind="Sheet"]}[Data]\`.

    **[2b] CONSISTENT vSourcePath PARAMETER FOR ALL FILE-BASED SOURCES**
    - ALL file-based loads (CSV, Excel, QVD) MUST use the M parameter vSourcePath for portability. NEVER hardcode absolute paths like "D:\\SourceFiles\\" or "C:\\Users\\...".
    - At the top of EVERY generated M script that uses files, declare: vSourcePath = "TODO: Set your base source folder path here" as text
    - Then reference it consistently: File.Contents(vSourcePath & "filename.csv")
    - This applies uniformly to ALL file sources in the migration — no exceptions.

    **[2c] CSV HEADER PROMOTION (CRITICAL)**
    - When using \`Csv.Document\`, the first row is NOT automatically promoted to headers. The columns are named Column1, Column2, etc.
    - You MUST add a \`Table.PromoteHeaders\` step immediately after \`Csv.Document\` BEFORE you attempt to reference any columns by name (e.g., in Table.TransformColumnTypes or Table.SelectColumns).
    - Example:
      \`\`\`
      Source_Sales = Csv.Document(File.Contents(vSourcePath & "Sales.csv"), [Delimiter=",", Encoding=65001]),
      Promoted_Sales = Table.PromoteHeaders(Source_Sales, [PromoteAllScalars=true]),
      Typed_Sales = Table.TransformColumnTypes(Promoted_Sales, {{"SalesID", type text}})
      \`\`\`

    **[3] UNIFIED QUERIES WITH SEQUENTIAL STEPS**
    - Instead of creating many separate staging queries, combine the ETL logic (Concatenate, ApplyMap, Joins, Calculated Fields) into a single, comprehensive Power Query script for each final table, just like standard sequential M code.
    - Use clear step names and comments (e.g., // STEP 1: COMBINE SALES DATA, // STEP 2: APPLY REGION MAPPING).
    - If you are building a final Fact table, all its preceding logic should ideally be sequential steps within its \`let\` block (e.g., \`Source = ...\`, \`JoinRegionMap = Table.NestedJoin(...)\`, \`ExpandRegionMap = ...\`, etc.).

    **[3b] STRICT POWER QUERY SYNTAX & VARIABLE REFERENCING**
    - CRITICAL: Every single step in the \`let\` block MUST end with a comma (,), EXCEPT for the very last step right before the \`in\` keyword. Missing commas will cause syntax errors.
    - CRITICAL: Do NOT reference variables that you haven't declared. If you declare \`Source_Sales2025\`, you must use \`Source_Sales2025\` in subsequent steps, NOT \`dbo_Sales2025\` or \`Sales2025\`.
    - CRITICAL: Never hardcode local paths like "C:\\Users\\...". Always use the \`vSourcePath\` parameter exactly as: \`File.Contents(vSourcePath & "filename.csv")\`

    **[4] CONSOLIDATED OUTPUT (NO DIAGNOSTIC QUERIES)**
    - Do NOT generate separate "_Validation" or "_Stg" diagnostic queries unless explicitly requested. Keep the output clean and focused on the actual final tables required by the data model.

    **[5] ABSOLUTE ZERO INFERRED BUSINESS LOGIC — VERIFY BEFORE GENERATING**
    - Before generating ANY calculated column, you MUST perform an explicit verification check:
      STEP A: Search the Raw Source QVS Script for the exact column name (e.g., ProfitUSD, SalesBand).
      STEP B: Search the Raw ETL QVS Script for the exact column name.
      STEP C: Search the Migration Rule Book for the exact column name.
      Only if found in at least one of these three sources, generate it. If absent from ALL three → DO NOT generate it.
    - This is the highest-priority rule. Generating ProfitUSD or SalesBand when they are absent from ALL three sources = migration failure.
    - Omission is always safer than invention. When in doubt, leave it out.

    **[6] COLUMN PRESERVATION**
    - Preserve ALL columns from the QVS script in the final output. Do not drop IDs, dates, or metrics.

    **[6b] DATA TYPING FOR ID COLUMNS**
    - Treat ALL ID columns (e.g., CustomerID, ProductID, RegionID, SalesID) as \`type text\`, NEVER as integers or numbers. 
    - Qlik often stores alphanumeric IDs (e.g., 'CUST0063'). Attempting to cast these to \`Int64.Type\` or \`type number\` in Power Query will result in fatal DataFormat.Errors.

    **[7] ENTERPRISE TRACEABILITY**
    - Add inline M-comments before every transformation step (e.g., // Lineage: FactSales -> ApplyMap(RegionMap)).

    ### Input Context:
    - Business Requirements: ${JSON.stringify(businessMetadata)}
    - Technical Schema Blueprint: ${JSON.stringify(chunkMetadata)}
    - Raw Source QVS Script:
    \`\`\`qlik
    ${sourceQvsText || "No source script provided."}
    \`\`\`
    - Raw ETL QVS Script:
    \`\`\`qlik
    ${etlQvsText || "No ETL script provided."}
    \`\`\`

    ### OUTPUT FORMAT:
    Return a strictly valid JSON array. Each object = one Power Query query. Output ONLY the required unified final tables. Do not include markdown codeblocks (\`\`\`).
    [
      { "table": "FactSales_Final", "code": "let\\n    vSourcePath = \\"TODO: Set your base source folder path here\\" as text,\\n    // STEP 1: COMBINE SALES DATA\\n    Source_Sales2025 = Csv.Document(File.Contents(vSourcePath & \\"Sales2025.csv\\"), [Delimiter=\\",\\", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\\n    Promoted_Sales2025 = Table.PromoteHeaders(Source_Sales2025, [PromoteAllScalars=true]),\\n    ...\\nin\\n    AddedSalesBand" }
    ]
  `;

    let chunkSuccess = false;
    let retries = 0;
    while (!chunkSuccess && retries < 3) {
      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${pqEngineModel}:generateContent?key=${apiKey}`;
        const response = await fetchWithRetry(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
          })
        });

        if (!response.ok) {
          throw new Error(`Gemini API Error: ${response.statusText}`);
        }

        const data = await response.json();
        const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
        
        try {
          const chunkResults = JSON.parse(sanitizeJsonString(resultText));
          if (Array.isArray(chunkResults)) {
            results.push(...chunkResults);
          }
          chunkSuccess = true;
        } catch (parseError) {
          console.warn(`[Power Query AI] JSON Parse failed for chunk ${i}. Retrying (${retries + 1}/3)...`, parseError);
          throw parseError; // Caught by the outer catch to trigger retry
        }
      } catch (error) {
        retries++;
        if (retries >= 3) {
          console.error(`[Power Query AI] ${pqEngineModel} failed after 3 retries for chunk.`);
          throw error;
        }
        await new Promise(r => setTimeout(r, 2000)); // wait before retry
      }
    }
  }

  return results;
}

export async function generateDaxMeasuresWithGemini(
  requirement: Requirement,
  ruleBookMd: string,
  technicalMetadata: TechnicalMetadata
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key is missing.");

  const prompt = `
    You are an elite Power BI Business Intelligence Engineer specializing in performance-optimized DAX formulas.
    Generate clean, enterprise-ready DAX measures based on the following context maps:
    - Business Directives: ${JSON.stringify(requirement)}
    - Compiled Migration Rule Book: ${ruleBookMd}
    - Layout Schema Blueprint: ${JSON.stringify(technicalMetadata)}
  `;

  let daxEngineModel = technicalMetadata.executionGraph && technicalMetadata.executionGraph.length > 25 ? FALLBACK_MODEL : PRIMARY_MODEL;
  daxEngineModel = getActiveModel(daxEngineModel);

  try {
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${daxEngineModel}:generateContent?key=${apiKey}`;
    const response = await fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
      })
    });

    if (!response.ok) throw new Error(`Gemini API Error (Stage 5 DAX Engine): ${response.status}`);
    const resultBody = await response.json();
    return resultBody?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (error) {
    if (daxEngineModel === PRIMARY_MODEL) {
      console.info(`[DAX Fallback] ${PRIMARY_MODEL} rate limits encountered. Activating secondary engine (${FALLBACK_MODEL})...`);
      isProExhausted = true;
      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${FALLBACK_MODEL}:generateContent?key=${apiKey}`;
        const response = await fetchWithRetry(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
          })
        });
        if (!response.ok) throw new Error(`Gemini API Error (Stage 5 DAX Fallback Engine): ${response.status}`);
        const resultBody = await response.json();
        return resultBody?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      } catch (fallbackError) {
        throw fallbackError;
      }
    }
    throw error;
  }
}

export async function generateSemanticModelWithGemini(
  businessMetadata: BusinessMetadata,
  technicalMetadata: TechnicalMetadata
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) return "{}";

  const prompt = `Generate a complete semantic dataset relationship model configuration in JSON based on the provided technical schemas: ${JSON.stringify(technicalMetadata)}`;
  
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${FALLBACK_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetchWithRetry(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, responseMimeType: "application/json", maxOutputTokens: 8192 }
    })
  });

  if (!response.ok) return "{}";
  const resultBody = await response.json();
  return resultBody?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}