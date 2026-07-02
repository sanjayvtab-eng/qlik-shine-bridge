import type { Requirement, BusinessMetadata, TechnicalMetadata, FinalTable, SourceTable } from "./types";

// Programmatic model constants for fallback orchestration
const PRIMARY_MODEL = "gemini-2.5-pro";
const FALLBACK_MODEL = "gemini-2.5-flash";

const getApiKey = (): string => {
  if (typeof window !== "undefined") {
    if ((window as any).ENV_GEMINI_API_KEY) return (window as any).ENV_GEMINI_API_KEY;
    if ((window as any).VITE_GEMINI_API_KEY) return (window as any).VITE_GEMINI_API_KEY;
    const storedKey = localStorage.getItem("GEMINI_API_KEY") || localStorage.getItem("VITE_GEMINI_API_KEY");
    if (storedKey) return storedKey.trim();
  }
  if (typeof import.meta !== "undefined" && import.meta.env) {
    if (import.meta.env.VITE_GEMINI_API_KEY) return import.meta.env.VITE_GEMINI_API_KEY;
    if (import.meta.env.GEMINI_API_KEY) return import.meta.env.GEMINI_API_KEY;
  }
  return "YOUR_GEMINI_API_KEY";
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
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, initialDelay = 8000): Promise<Response> {
  let currentDelay = initialDelay;
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status === 503) {
      console.warn(`[Gemini API] Quota limit encountered (${response.status}). Cooling down for ${currentDelay / 1000}s (Attempt ${i + 1}/${retries})...`);
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      currentDelay *= 2; 
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
  etlQvsText: string
): Promise<{ businessMetadata: BusinessMetadata; technicalMetadata: TechnicalMetadata; executionMetrics: any }> {
  
  let stage3A: any;
  let stage3B: any;
  let finalModelUsed = PRIMARY_MODEL;

  try {
    console.log(`[Engine] Initializing structural analysis pass via ${PRIMARY_MODEL}...`);
    stage3A = await analyzeStage3A(requirement, ruleBookMd, sourceQvsText, etlQvsText, PRIMARY_MODEL);
    
    // Throttle delay to protect token allocation bucket space
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    console.log(`[Engine] Initializing semantic validation pass via ${PRIMARY_MODEL}...`);
    stage3B = await analyzeStage3B(requirement, ruleBookMd, sourceQvsText, etlQvsText, stage3A, PRIMARY_MODEL);
  } catch (error: any) {
    console.warn(`[Engine Fallback] ${PRIMARY_MODEL} encountered limit limits or truncation issues. Activating high-capacity fallback engine (${FALLBACK_MODEL})... Log:`, error.message || error);
    
    finalModelUsed = FALLBACK_MODEL;
    stage3A = await analyzeStage3A(requirement, ruleBookMd, sourceQvsText, etlQvsText, FALLBACK_MODEL);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    stage3B = await analyzeStage3B(requirement, ruleBookMd, sourceQvsText, etlQvsText, stage3A, FALLBACK_MODEL);
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
    sourceTables: stage3A.sourceTables || [],
    allTables: stage3A.allTables || [],
    finalTables: stage3A.finalTables || [],
    relationships: stage3B.relationships || [],
    variables: stage3B.variables || {},
    executionGraph: stage3A.executionGraph || []
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
  targetModel: string
): Promise<any> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key configuration error.");

  const streamlinedSource = compressQvsScriptForAi(sourceQvsText);
  const streamlinedEtl = compressQvsScriptForAi(etlQvsText);

  const prompt = `
    You are an expert Qlik Data Architecture Engine. Analyze the provided scripts to isolate table shapes, execution footprints, and structural lineage blocks according to the Migration Rule Book rules.
    
    ### MIGRATION RULE BOOK GUIDELINES:
    ${ruleBookMd}

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
  const response = await fetchWithRetry(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 8192, 
        responseMimeType: "application/json",
        responseSchema: schema3A
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Stage 3A Parsing Failure (${response.status}): ${errText}`);
  }
  const result = await response.json();
  return JSON.parse(sanitizeJsonString(result?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"));
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

  const daxEngineModel = technicalMetadata.executionGraph && technicalMetadata.executionGraph.length > 25 ? FALLBACK_MODEL : PRIMARY_MODEL;

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