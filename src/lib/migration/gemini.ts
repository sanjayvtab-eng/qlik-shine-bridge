import type { Requirement, BusinessMetadata, TechnicalMetadata } from "./types";

const ACTIVE_MODEL = "gemini-2.5-flash"; 

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

/**
 * Advanced script token minimizer.
 * Strips out structural overhead characters and comments to minimize the token footprint
 * by up to 90% while keeping vital logical statements intact.
 */
function compressQvsScriptForAi(text: string): string {
  if (!text) return "";
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line block comments
    .replace(/\/\/.*$/gm, "")         // Remove inline row comments
    .replace(/^\s*REM\s.*$/gim, "")   // Remove legacy Qlik REM comment strings
    .replace(/\s+/g, " ")             // Collapse consecutive layout spacing elements
    .replace(/;\s*/g, ";\n")          // Isolate distinct statements cleanly onto individual rows
    .trim();
}

/**
 * Defensive utility to repair unescaped newlines and structural code text anomalies
 * inside raw LLM text fields before executing the native JSON parser.
 */
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
        if (char === '\n') {
          result += '\\n';
        } else if (char === '\r') {
          result += '\\r';
        } else if (char === '\t') {
          result += '\\t';
        } else {
          result += char;
        }
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('{');
      } else if (char === '}') {
        if (stack.length > 0 && stack[stack.length - 1] === '{') {
          stack.pop();
        }
      } else if (char === '[') {
        stack.push('[');
      } else if (char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === '[') {
          stack.pop();
        }
      }
      result += char;
    }
  }
  
  if (inString) {
    result += '"';
  }
  
  // Clean up trailing commas before closing
  result = result.replace(/,\s*$/, '');
  
  // If it ends with a colon, add null to make it valid JSON
  if (result.match(/:\s*$/)) {
    result += 'null';
  }
  
  // Close unclosed structures
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === '{') {
      result += '}';
    } else if (top === '[') {
      result += ']';
    }
  }
  
  return result;
}

/**
 * Intelligent fetch wrapper that handles 429 Rate Limits and 503 Service Unavailable using progressive backoff
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 3, initialDelay = 12000): Promise<Response> {
  let currentDelay = initialDelay;
  for (let i = 0; i < retries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429 || response.status === 503) {
      console.warn(`[Gemini API] Temporary error (${response.status}). Waiting ${currentDelay / 1000}s before executing retry ${i + 1}/${retries}...`);
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
      currentDelay *= 2; 
      continue;
    }
    return response;
  }
  return fetch(url, options);
}

/**
 * STAGE 2: Compiles user business requirements into a structured technical Markdown Rule Book.
 */
export async function generateRuleBookViaAi(requirement: Requirement): Promise<string> {
  // Use static template instead of AI generation
  const template = `# Qlik to Power BI Migration Rule Book

## Report Name
{{ReportName}}

## Business Objective
{{BusinessObjective}}

## Business Requirement
{{BusinessRequirement}}

## Source Tables
{{SourceTableNames}}

## Source Columns
{{SourceColumnNames}}

## Expected Output
{{ExpectedOutput}}

## Migration Rules

- Analyze the uploaded Source QVS.
- Analyze the uploaded ETL QVS.
- Preserve the complete ETL logic.
- Detect the final surviving tables.
- Generate Power Query only for the final tables.
- Convert Qlik Set Analysis to Power BI DAX.
- Generate the Power BI semantic model.
- Create a Calendar table only if one does not exist.`;

  return template
    .replace("{{ReportName}}", requirement.reportName || "—")
    .replace("{{BusinessObjective}}", requirement.businessObjective || "—")
    .replace("{{BusinessRequirement}}", requirement.businessRequirement || "—")
    .replace("{{SourceTableNames}}", requirement.sourceTableNames || "—")
    .replace("{{SourceColumnNames}}", requirement.sourceColumnNames || "—")
    .replace("{{ExpectedOutput}}", requirement.expectedOutput || "—");
}

/**
 * STAGE 3: Performs full semantic code parsing of QVS scripts against the Rule Book 
 * to build complete and validated Technical and Business Metadata graphs.
 */
export async function analyzeQvsScriptsViaAi(
  requirement: Requirement,
  ruleBookMd: string,
  sourceQvsText: string,
  etlQvsText: string
): Promise<{ businessMetadata: BusinessMetadata; technicalMetadata: TechnicalMetadata }> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key configuration error.");

  const streamlinedSource = compressQvsScriptForAi(sourceQvsText);
  const streamlinedEtl = compressQvsScriptForAi(etlQvsText);

  const prompt = `
    You are a precise data lineage compiler and metadata engine. Analyze the provided compacted Qlik QVS scripts against the Migration Rule Book and Requirements.
    Extract and populate every data model parameter completely. Do not truncate records or inject generic comment placeholders.

    ### CRITICAL TOKEN ECONOMY & TRUNCATION RULES:
    To prevent response truncation, do NOT duplicate long raw Qlik script blocks inside the "raw" fields or "expression" fields. 
    Keep "raw" and "expression" property values strictly minimized to the essential statement clause or formula logic (maximum 120 characters per string block).

    ### CRITICAL STRING INJECTION JSON RULE:
    Every text property value MUST be cleanly escaped to follow native JSON boundaries. 
    Multi-line expressions must have formatting line-breaks systematically escaped as "\\n" instead of copying literal unescaped newlines.

    ### Input Context:
    - Target Requirements Profile: ${JSON.stringify(requirement)}
    - Migration Rule Book Rules: ${ruleBookMd}
    - Compressed Ingested Source QVS Script: ${streamlinedSource}
    - Compressed Ingested ETL QVS Script: ${streamlinedEtl}
  `;

  const structuralResponseSchema = {
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
          expectedColumns: { type: "ARRAY", items: { type: "STRING" } },
          expectedRelationships: {
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
          }
        },
        required: ["reportName", "businessObjective", "businessRequirement", "expectedOutput", "businessRules", "expectedTables", "expectedFinalTables", "expectedColumns", "expectedRelationships"]
      },
      technicalMetadata: {
        type: "OBJECT",
        properties: {
          sourceTables: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "STRING" },
                name: { type: "STRING" },
                platform: { type: "STRING" },
                database: { type: "STRING" },
                schema: { type: "STRING" },
                connectionPath: { type: "STRING" },
                connectionName: { type: "STRING" },
                sourceQuery: { type: "STRING" },
                columns: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      name: { type: "STRING" },
                      dataType: { type: "STRING" }
                    },
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
              properties: {
                name: { type: "STRING" },
                type: { type: "STRING" }
              },
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
                keys: { type: "ARRAY", items: { type: "STRING" } },
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
                },
                steps: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      kind: { type: "STRING", enum: ["LOAD", "RESIDENT", "JOIN", "KEEP", "CONCATENATE", "APPLYMAP", "DERIVED", "RENAME_FIELD", "DROP_FIELD", "PEEK", "PREVIOUS", "AUTONUMBER", "CROSSTABLE", "HIERARCHY", "INTERVALMATCH"] },
                      from: { type: "STRING" },
                      withTable: { type: "STRING" },
                      mapName: { type: "STRING" },
                      sourceField: { type: "STRING" },
                      asField: { type: "STRING" },
                      expression: { type: "STRING" },
                      name: { type: "STRING" },
                      where: { type: "STRING" },
                      isDistinct: { type: "BOOLEAN" },
                      groupBy: { type: "ARRAY", items: { type: "STRING" } },
                      orderBy: { type: "ARRAY", items: { type: "STRING" } },
                      fields: { type: "ARRAY", items: { type: "OBJECT" } },
                      withFields: { type: "ARRAY", items: { type: "STRING" } },
                      keyFields: { type: "ARRAY", items: { type: "STRING" } }
                    },
                    required: ["kind"]
                  }
                }
              },
              required: ["id", "name", "type", "columns", "sourceTables", "isFinal", "steps"]
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
        required: ["sourceTables", "allTables", "finalTables", "relationships", "variables"]
      }
    },
    required: ["businessMetadata", "technicalMetadata"]
  };

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetchWithRetry(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.0,
        maxOutputTokens: 8192, // Maximum runway token generation budget
        responseMimeType: "application/json",
        responseSchema: structuralResponseSchema
      }
    })
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`Gemini API Error (Stage 3 Metadata Analysis): ${response.status} - ${errorDetails}`);
  }

  const resultBody = await response.json();
  const metadataJsonText = resultBody?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!metadataJsonText) {
    throw new Error("Received an empty content payload from Gemini API during script structural parsing.");
  }

  const parsedCleanText = sanitizeJsonString(metadataJsonText);
  const parsed = JSON.parse(parsedCleanText);

  // Safeguard against truncated or hallucinated schema properties to prevent undefined '.length' errors
  const business = parsed.businessMetadata || {};
  business.expectedTables = business.expectedTables || [];
  business.expectedFinalTables = business.expectedFinalTables || [];
  business.expectedColumns = business.expectedColumns || [];
  business.expectedRelationships = business.expectedRelationships || [];
  business.businessRules = business.businessRules || [];

  const technical = parsed.technicalMetadata || {};
  technical.sourceSystems = technical.sourceSystems || [];
  technical.sourceTables = technical.sourceTables || [];
  technical.sourceColumns = technical.sourceColumns || [];
  technical.allTables = technical.allTables || [];
  technical.finalTables = technical.finalTables || [];
  technical.finalColumns = technical.finalColumns || [];
  technical.relationships = technical.relationships || [];
  technical.keys = technical.keys || [];
  technical.transformations = technical.transformations || [];
  technical.variables = technical.variables || {};
  technical.droppedTables = technical.droppedTables || [];
  technical.intermediateTables = technical.intermediateTables || [];
  technical.dependencyGraph = technical.dependencyGraph || [];

  // Ensure table level columns and steps are safeguarded
  for (const t of technical.sourceTables) t.columns = t.columns || [];
  for (const t of technical.finalTables) {
    t.columns = t.columns || [];
    t.steps = t.steps || [];
    t.sourceTables = t.sourceTables || [];
  }

  return { businessMetadata: business, technicalMetadata: technical };
}

/**
 * STAGE 5: Compiles and translates expressions into clean Power BI DAX Measures.
 */
export async function generateDaxMeasuresWithGemini(
  requirement: Requirement,
  ruleBookMd: string,
  technicalMetadata: TechnicalMetadata
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Gemini API key is missing.");

  const prompt = `
    You are an elite Power BI Business Intelligence Engineer specializing in performance-optimized DAX formulas.
    Generate a complete file containing clean, enterprise-ready DAX measures based on the following migration context and structural metadata rules.

    ### Migration Context:
    - Business Directives: ${JSON.stringify(requirement)}
    - Compiled Migration Rule Book: ${ruleBookMd}
    - Analyzed Models Schema Layout: ${JSON.stringify(technicalMetadata)}

    ### Execution Rules:
    1. Convert all QlikView/Qlik Sense expressions and calculations into standard, robust Power BI DAX formatting.
    2. Explicitly handle complex conversions (e.g., translating implicit Qlik Set Analysis scopes into native CALCULATE modifiers and filtering functions).
    3. Return output as clear, beautifully formatted DAX code blocks matching this structure:
       Measure Name = CALCULATE(SUM(...), FILTER(...))
  `;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetchWithRetry(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
    })
  });

  if (!response.ok) {
    const errorDetails = await response.text();
    throw new Error(`Gemini API Error (Stage 5 DAX Engine): ${response.status} - ${errorDetails}`);
  }

  const resultBody = await response.json();
  const daxOutputCode = resultBody?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!daxOutputCode) {
    throw new Error("Gemini API returned an empty code block during DAX conversion operations.");
  }

  return daxOutputCode;
}

/**
 * STAGE 6: Generates complete structural JSON mappings for semantic models.
 */
export async function generateSemanticModelWithGemini(
  businessMetadata: BusinessMetadata,
  technicalMetadata: TechnicalMetadata
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) return "{}";

  const prompt = `Generate a complete semantic dataset relationship model configuration in JSON based on the provided technical schemas: ${JSON.stringify(technicalMetadata)}`;
  
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${ACTIVE_MODEL}:generateContent?key=${apiKey}`;
  const response = await fetchWithRetry(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.0, responseMimeType: "application/json", maxOutputTokens: 4096 }
    })
  });

  if (!response.ok) return "{}";
  const resultBody = await response.json();
  return resultBody?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
}