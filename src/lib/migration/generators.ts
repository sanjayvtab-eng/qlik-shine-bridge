import type {
  Requirement, BusinessMetadata, TechnicalMetadata, FinalTable, SourceTable,
  Relationship, TableStep, MigrationValidationReport, MigrationValidationIssue
} from "./types";

const TYPE_MAP: Record<string, string> = {
  String: "type text", Integer: "type number", Decimal: "type number",
  Date: "type date", DateTime: "type datetime", Boolean: "type logical",
  Time: "type time", Duration: "type duration",
};

function inferMType(name: string): string {
  if (!name) return "type text";
  const n = String(name).toLowerCase();
  if (/date|_dt$/.test(n)) return "type date";
  if (/time/.test(n)) return "type time";
  if (/_id$|id$|key$/.test(n)) return "type number";
  if (/qty|quantity|count|amount|price|revenue|cost|total|sum|margin/.test(n)) return "type number";
  return "type text";
}

function escapeM(s: string): string {
  if (s == null) return "";
  return String(s).replace(/"/g, '""');
}

function safeName(s: string): string {
  if (s == null) return "Unnamed";
  const cleaned = String(s).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `Step_${cleaned}`;
}

function quoteStep(name: string): string {
  return `#"${escapeM(name)}"`;
}

function mField(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `[${name}]` : `[#"${escapeM(name)}"]`;
}

function recordField(record: string, field: string): string {
  return `Record.Field(${record}, "${escapeM(field)}")`;
}

function typedColumnsBlock(columns: FinalTable["columns"]): string {
  return (columns || [])
    .filter((c) => c.name !== "*")
    .map((c) => `        {"${escapeM(c.name)}", ${TYPE_MAP[c.dataType] || inferMType(c.name)}}`)
    .join(",\n");
}

function detectPlatform(from: string): string {
  if (!from) return "Unknown";
  if (/\.qvd$/i.test(from)) return "QVD";
  if (/\.xlsx?$/i.test(from)) return "Excel";
  if (/\.csv$/i.test(from)) return "CSV";
  if (/\.tsv$/i.test(from)) return "CSV";
  if (/\.parquet$/i.test(from)) return "Parquet";
  if (/\.json$/i.test(from)) return "JSON";
  if (/\.xml$/i.test(from)) return "XML";
  if (/^SQL:/i.test(from) || /SELECT\s+/i.test(from)) return "SQL";
  if (/odbc|dsn=/i.test(from)) return "ODBC";
  if (/snowflake/i.test(from)) return "Snowflake";
  if (/oracle/i.test(from)) return "Oracle";
  if (/postgres/i.test(from)) return "PostgreSQL";
  if (/mysql/i.test(from)) return "MySQL";
  if (/databricks/i.test(from)) return "Databricks";
  if (/sap/i.test(from)) return "SAP";
  return "Unknown";
}

function sourceConnector(step: {
  kind: string;
  from?: string;
  platform?: string;
  connectionName?: string;
  database?: string;
  sourceQuery?: string;
  fields?: { name: string }[];
  qvd?: string;
  file?: string;
}): string {
  const from = step.from || "";
  const platform = step.platform || detectPlatform(from);
  const sql = ("sourceQuery" in step ? step.sourceQuery : undefined)?.replace(/^SQL\s+/i, "");
  const sqlTable = from.match(/^SQL:\s*([A-Za-z0-9_.[\]"]+)/i)?.[1]?.replace(/[\[\]"]/g, "");
  const sqlParts = sqlTable?.split(".").filter(Boolean) ?? [];
  const database = "database" in step && step.database ? step.database : sqlParts.length >= 3 ? sqlParts[0] : undefined;
  const file = step.file || (!/^SQL:/i.test(from) && !/^[A-Za-z][A-Za-z0-9_]*$/.test(from) ? from : undefined);
  const qvd = step.qvd || (/\.qvd$/i.test(from) ? from : undefined);
  const requireConnection = () => step.connectionName || (sqlParts.length >= 2 ? sqlParts.slice(0, -1).join(".") : from);
  switch (platform) {
    case "SQL": return `Sql.Database("${escapeM(requireConnection())}", ${database ? `"${escapeM(database)}"` : "null"}${sql ? `, [Query="${escapeM(sql)}"]` : ""})`;
    case "Oracle": return `Oracle.Database("${escapeM(requireConnection())}"${sql ? `, [Query="${escapeM(sql)}"]` : ""})`;
    case "Snowflake": return `Snowflake.Databases("${escapeM(requireConnection())}", "WAREHOUSE")`;
    case "PostgreSQL": return `PostgreSQL.Database("${escapeM(requireConnection())}", ${database ? `"${escapeM(database)}"` : "null"})`;
    case "MySQL": return `MySQL.Database("${escapeM(requireConnection())}", ${database ? `"${escapeM(database)}"` : "null"})`;
    case "Excel": return `Excel.Workbook(File.Contents("${escapeM(file || from)}"), null, true)`;
    case "CSV": return `Csv.Document(File.Contents("${escapeM(file || from)}"), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv])`;
    case "Parquet": return `Parquet.Document(File.Contents("${escapeM(file || from)}"))`;
    case "JSON": return `Json.Document(File.Contents("${escapeM(file || from)}"))`;
    case "XML": return `Xml.Tables(File.Contents("${escapeM(file || from)}"))`;
    case "QVD": return `Qvd.Document(File.Contents("${escapeM(qvd || file || from)}"))`;
    case "REST": return `Json.Document(Web.Contents("${escapeM(file || from)}"))`;
    case "Databricks": return `Databricks.Catalogs("${escapeM(requireConnection())}", "/sql/1.0/warehouses")`;
    case "SAP": return `SapBusinessWarehouse.Cubes("${escapeM(requireConnection())}", "00", "800")`;
    case "ODBC":
      if (sql) return `Odbc.Query("dsn=${escapeM(requireConnection())}", "${escapeM(sql)}")`;
      if (file || qvd) return `File.Contents("${escapeM(file || qvd || from)}")`;
      return `Odbc.DataSource("dsn=${escapeM(requireConnection())}")`;
    default:
      if (sql) return `Sql.Database("${escapeM(requireConnection())}", null, [Query="${escapeM(sql)}"])`;
      if (file || qvd) return `File.Contents("${escapeM(file || qvd || from)}")`;
      return quoteStep(from || "UnknownSource");
  }
}

function guessKey(table: FinalTable, candidates: string[]): string | undefined {
  const cols = [...(candidates || []), ...(table.columns || []).map((c) => c.name), ...(table.keys || [])];
  return cols.find((n) => n && /_id$|Id$|_KEY$|Key$/i.test(n)) || cols[0];
}

function findMappingTable(name: string, allTables: FinalTable[]): FinalTable | undefined {
  return (allTables || []).find((t) => t.name === name && t.type === "Mapping");
}

function tableSourceExpression(table: FinalTable, sources: SourceTable[], allTables: FinalTable[]): string {
  const src = (sources || []).find((s) => s.name === table.name);
  if (src) return sourceConnector({ kind: "LOAD", from: src.connectionPath || src.name, platform: src.platform });
  return quoteStep(table.name);
}

function inlineSourceStep(step: TableStep, tableName: string, sources: SourceTable[], allTables: FinalTable[]): string {
  const matchedSrc = (sources || []).find((s) => s.name === tableName);
  if (matchedSrc) {
    return sourceConnector({
      kind: "LOAD",
      from: matchedSrc.connectionPath || matchedSrc.name,
      platform: matchedSrc.platform,
      connectionName: matchedSrc.connectionName,
      sourceQuery: matchedSrc.sourceQuery,
    });
  }
  const matchedTable = (allTables || []).find((t) => t.name === tableName);
  if (matchedTable) return quoteStep(matchedTable.name);
  if (step.fromClause) {
    return sourceConnector({
      kind: "LOAD",
      from: step.fromClause,
      fields: (step.withFields || []).map((name) => ({ name })),
      platform: step.platform || detectPlatform(step.fromClause),
      connectionName: step.connectionName,
      sourceQuery: step.sourceQuery,
    });
  }
  return quoteStep(tableName || "UnknownTable");
}

function inferStepsFromSource(table: FinalTable, sources: SourceTable[]): TableStep[] {
  const src = (sources || []).find((s) => s.name === table.name || (table.sourceTables || []).some((st) => st.toLowerCase().includes(s.name.toLowerCase())));
  if (!src) return [];
  return [{
    kind: "LOAD",
    from: src.connectionPath || (src as any).qvdName || (src as any).filePath || src.name,
    fields: (src.columns || []).map((c) => ({ name: c.name })),
    platform: src.platform,
    connectionName: src.connectionName,
    sourceQuery: src.sourceQuery,
  }];
}

export function generatePowerQuery(table: FinalTable, sources: SourceTable[], allTables: FinalTable[] = []): string {
  const steps = table.steps?.length ? table.steps : inferStepsFromSource(table, sources);

  if (!steps.length) {
    return `// Power Query M — ${table.name} (${table.type})\n// WARNING: No ETL steps could be determined. Manual completion required.\nlet\n    Source = #table({}, {})\nin\n    Source`;
  }

  const stepLines: string[] = [];
  let lastStep = "Source";
  let stepIdx = 0;
  const nextName = (base: string) => `${safeName(base)}_${++stepIdx}`;

  const loadStep = steps.find((s) => s.kind === "LOAD" || s.kind === "RESIDENT");
  if (loadStep?.kind === "LOAD") {
    stepLines.push(`    Source = ${sourceConnector(loadStep)}`);
    if (loadStep.where) {
      const where = nextName("Filtered");
      stepLines.push(`    ${where} = Table.SelectRows(${lastStep}, each ${qlikExprToM(loadStep.where)})`);
      lastStep = where;
    }
    const selectedFields = (loadStep.fields || []).filter((f) => f.name !== "*").map((f) => f.name);
    if (selectedFields.length) {
      const sel = nextName("Selected");
      stepLines.push(`    ${sel} = Table.SelectColumns(${lastStep}, {${selectedFields.map((f) => `"${escapeM(f)}"`).join(", ")}}, MissingField.UseNull)`);
      lastStep = sel;
    }
  } else if (loadStep?.kind === "RESIDENT") {
    stepLines.push(`    Source = Table.Buffer(${quoteStep(loadStep.from || "UnknownSource")})`);
    if (loadStep.where) {
      const where = nextName("Filtered");
      stepLines.push(`    ${where} = Table.SelectRows(${lastStep}, each ${qlikExprToM(loadStep.where)})`);
      lastStep = where;
    }
    const selectedFields = (loadStep.fields || []).filter((f) => f.name !== "*").map((f) => f.name);
    if (selectedFields.length) {
      const sel = nextName("Selected");
      stepLines.push(`    ${sel} = Table.SelectColumns(${lastStep}, {${selectedFields.map((f) => `"${escapeM(f)}"`).join(", ")}}, MissingField.UseNull)`);
      lastStep = sel;
    }
  }

  for (const step of steps) {
    if (step === loadStep) continue;
    switch (step.kind) {
      case "DERIVED": {
        const expr = step.expression != null ? String(step.expression) : "null";
        const nm = nextName(`Added_${step.name || "Col"}`);
        stepLines.push(`    ${nm} = Table.AddColumn(${lastStep}, "${escapeM(step.name)}", each ${qlikExprToM(expr)}, ${TYPE_MAP[(table.columns || []).find((c) => c.name === step.name)?.dataType || ""] || inferMType(step.name || "")})`);
        lastStep = nm;
        break;
      }
      case "RENAME_FIELD": {
        const nm = nextName("Renamed");
        stepLines.push(`    ${nm} = Table.RenameColumns(${lastStep}, {{"${escapeM(step.from)}", "${escapeM(step.to)}"}}, MissingField.Ignore)`);
        lastStep = nm;
        break;
      }
      case "DROP_FIELD": {
        const nm = nextName("Removed");
        stepLines.push(`    ${nm} = Table.RemoveColumns(${lastStep}, {"${escapeM(step.field)}"}, MissingField.Ignore)`);
        lastStep = nm;
        break;
      }
      case "JOIN": {
        const right = inlineSourceStep(step, step.withTable || "", sources, allTables);
        const withFields = Array.isArray(step.withFields) ? step.withFields : [];
        const keyFields = (step.keyFields?.length ? step.keyFields : [guessKey(table, withFields)].filter(Boolean)) as string[];
        if (!keyFields.length) {
          stepLines.push(`    // WARNING: Join for ${table.name} has no analyzed key fields — skipped`);
          break;
        }
        const joinKind = step.joinType === "Inner" ? "JoinKind.Inner" : `JoinKind.${step.joinType || "Left"}Outer`;
        const merged = nextName("Merged");
        const keys = `{${keyFields.map((k) => `"${escapeM(k)}"`).join(", ")}}`;
        stepLines.push(`    ${merged} = Table.NestedJoin(${lastStep}, ${keys}, ${right}, ${keys}, "_join", ${joinKind})`);
        const expandCols = withFields.filter((f) => f !== "*" && !keyFields.includes(f));
        if (expandCols.length) {
          const expanded = nextName("Expanded");
          stepLines.push(`    ${expanded} = Table.ExpandTableColumn(${merged}, "_join", {${expandCols.map((f) => `"${escapeM(f)}"`).join(", ")}}, {${expandCols.map((f) => `"${escapeM(f)}"`).join(", ")}})`);
          lastStep = expanded;
        } else {
          lastStep = merged;
        }
        break;
      }
      case "KEEP": {
        const right = quoteStep(step.withTable || "UnknownTable");
        const keyGuess = guessKey(table, []) || table.keys?.[0];
        if (!keyGuess) {
          stepLines.push(`    // WARNING: KEEP for ${table.name} has no analyzed key field — skipped`);
          break;
        }
        const joinKind = step.joinType === "Inner" ? "JoinKind.Inner" : `JoinKind.${step.joinType || "Left"}Outer`;
        const merged = nextName("KeepJoin");
        stepLines.push(`    ${merged} = Table.NestedJoin(${lastStep}, {"${escapeM(keyGuess)}"}, ${right}, {"${escapeM(keyGuess)}"}, "_keep", ${joinKind})`);
        const filtered = nextName("KeepFiltered");
        stepLines.push(`    ${filtered} = Table.SelectRows(${merged}, each Table.RowCount([_keep]) > 0)`);
        const removed = nextName("KeepCleaned");
        stepLines.push(`    ${removed} = Table.RemoveColumns(${filtered}, {"_keep"})`);
        lastStep = removed;
        break;
      }
      case "CONCATENATE": {
        const right = inlineSourceStep(step, step.withTable || "", sources, allTables);
        const combined = nextName("Combined");
        stepLines.push(`    ${combined} = Table.Combine({${lastStep}, ${right}})`);
        lastStep = combined;
        break;
      }
      case "APPLYMAP": {
        const mapName = step.mapName != null ? String(step.mapName) : "";
        const mapTbl = mapName ? findMappingTable(mapName, allTables) : undefined;
        const keyField = mapTbl?.columns?.[0]?.name;
        const valField = mapTbl?.columns?.[1]?.name;
        if (!keyField || !valField) {
          stepLines.push(`    // WARNING: ApplyMap ${mapName} skipped — mapping table metadata incomplete`);
          break;
        }
        const nm = nextName(`Mapped_${step.asField || "Val"}`);
        const dflt = step.defaultValue ? qlikExprToM(step.defaultValue) : `_[${step.sourceField || "Key"}]`;
        const mappingSource = tableSourceExpression(mapTbl, sources, allTables);
        stepLines.push(`    ${nm} = Table.AddColumn(${lastStep}, "${escapeM(step.asField)}", each let m = Table.SelectRows(Table.Buffer(${mappingSource}), (r) => ${recordField("r", keyField)} = ${recordField("_", step.sourceField || "")}) in if Table.RowCount(m) > 0 then ${recordField("m{0}", valField)} else ${dflt})`);
        lastStep = nm;
        break;
      }
      case "LOAD":
      case "RESIDENT":
        break;
    }
  }

  if (!stepLines.length) {
    stepLines.push(`    Source = #table({}, {})`);
  }

  if ((table.columns || []).length) {
    const typed = nextName("Typed");
    stepLines.push(`    ${typed} = Table.TransformColumnTypes(${lastStep}, {\n${typedColumnsBlock(table.columns)}\n    }, "en-US")`);
    lastStep = typed;
  }

  const header = `// Power Query M — ${table.name} (${table.type})\n// Generated from merged Business Metadata + QVS Technical Metadata\n// Surviving table lineage: ${(table.lineage || table.sourceTables || []).join(" -> ") || table.name}`;
  return `${header}\nlet\n${stepLines.join(",\n")}\nin\n    ${lastStep}`;
}

export function generatePowerQueriesFromMigrationMetadata(
  business: BusinessMetadata,
  technical: TechnicalMetadata,
): { table: FinalTable; code: string }[] {
  const report = validateMigrationMetadata(business, technical);
  if (report.blockingErrors) {
    throw new Error(report.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" "));
  }
  return (technical.finalTables || [])
    .filter((t) => t.isFinal && t.type !== "Mapping")
    .map((table) => ({ table, code: generatePowerQuery(table, technical.sourceTables || [], technical.allTables || []) }));
}

export function buildBusinessMetadata(requirement: Requirement, ruleBookMd: string, expectedRelationships: Relationship[] = []): BusinessMetadata {
  const split = (s: string) => (s || "").split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
  const rules = [...ruleBookMd.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1].trim());
  const expectedFinalTables = split(requirement.expectedOutput).flatMap((x) => {
    const explicit = [...x.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]);
    const labelled = x.match(/(?:final\s+table|output\s+table|dataset|model)\s*[:=-]\s*([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
    const singleModelName = /^(Fact|Dim|Bridge|Calendar)[A-Za-z0-9_]*$/i.test(x) ? x : undefined;
    return [...explicit, labelled, singleModelName].filter(Boolean) as string[];
  });
  return {
    reportName: requirement.reportName,
    businessObjective: requirement.businessObjective,
    businessRequirement: requirement.businessRequirement,
    expectedOutput: requirement.expectedOutput,
    businessRules: rules,
    expectedTables: split(requirement.sourceTableNames),
    expectedFinalTables,
    expectedColumns: split(requirement.sourceColumnNames).map((c) => c.replace(/^[A-Za-z0-9_]+\./, "")),
    expectedRelationships,
  };
}

export function validateMigrationMetadata(business: BusinessMetadata, technical: TechnicalMetadata): MigrationValidationReport {
  const issues: MigrationValidationIssue[] = [];
  const add = (severity: MigrationValidationIssue["severity"], area: MigrationValidationIssue["area"], message: string, detail?: string) => {
    issues.push({ id: `val_${issues.length + 1}`, severity, area, message, detail });
  };

  if (!business.reportName || !business.businessRequirement || !business.expectedOutput) {
    add("error", "Business Metadata", "Requirement Input is incomplete.", "Report name, business requirement, and expected output are required before Power Query generation.");
  }
  if (!(technical.sourceTables || []).length) add("error", "Technical Metadata", "No source tables were parsed from the Source QVS.");
  if (!(technical.finalTables || []).length) add("error", "Technical Metadata", "No final surviving tables were identified from the ETL dependency graph.");

  for (const expected of (business.expectedTables || [])) {
    const exists = (technical.sourceTables || []).some((t) => eqName(t.name, expected)) || (technical.finalTables || []).some((t) => eqName(t.name, expected));
    if (!exists) add("warning", "Business Metadata", "Expected table not found in QVS metadata: " + expected);
  }
  for (const expected of (business.expectedFinalTables || [])) {
    const exists = (technical.finalTables || []).some((t) => eqName(t.name, expected));
    if (!exists) add("warning", "Business Metadata", "Expected final table not identified as surviving ETL table: " + expected);
  }
  for (const expected of (business.expectedColumns || [])) {
    const exists = (technical.finalTables || []).some((t) => (t.columns || []).some((c) => eqName(c.name, expected))) || (technical.sourceTables || []).some((t) => (t.columns || []).some((c) => eqName(c.name, expected)));
    if (!exists) add("warning", "Business Metadata", "Expected column not found in parsed tables: " + expected);
  }
  for (const source of (technical.sourceTables || [])) {
    if (!(source.columns || []).length) add("warning", "Technical Metadata", "Source table parsed without column metadata: " + source.name);
    if (source.platform === "Unknown") add("warning", "Technical Metadata", "Source platform could not be classified: " + source.name, source.connectionPath);
  }
  for (const table of (technical.finalTables || [])) {
    if (!table.steps?.length) add("warning", "Technical Metadata", "Final table has no ETL steps: " + table.name);
    if (!(table.columns || []).length) add("warning", "Technical Metadata", "Final table has no analyzed columns: " + table.name);
    for (const step of (table.steps || [])) {
      const withFields: string[] = Array.isArray(step.withFields) ? step.withFields : [];
      const keyFields: string[] = Array.isArray(step.keyFields) ? step.keyFields : [];
      const stepExpression = step.expression != null ? String(step.expression) : "";
      const stepMapName = step.mapName != null ? String(step.mapName) : "";
      if (step.kind === "JOIN" && !(keyFields.length || guessKey(table, withFields))) {
        add("warning", "Technical Metadata", "Join has no detectable key in: " + table.name, "Joined fields: " + (withFields.join(", ") || "none"));
      }
      if (step.kind === "JOIN") {
        const keys = keyFields.length ? keyFields : [guessKey(table, withFields)].filter(Boolean);
        for (const key of keys) {
          if (key && !(table.columns || []).some((c) => eqName(c.name, key))) add("warning", "Technical Metadata", "Join key not confirmed in columns: " + key);
        }
      }
      if (step.kind === "APPLYMAP" && stepMapName && !(technical.allTables || []).some((t) => eqName(t.name, stepMapName))) {
        add("warning", "Technical Metadata", "ApplyMap references mapping table not found: " + stepMapName);
      }
      if (step.kind === "DERIVED" && stepExpression) {
        if (stepExpression.trim() === "*") add("warning", "Power Query", "Derived column has wildcard expression: " + step.name);
        if (/\b(peek|previous|intervalmatch|hierarchy|generic|crosstable)\s*\(/i.test(stepExpression)) {
          add("warning", "Power Query", "Derived column uses complex Qlik syntax: " + step.name, stepExpression);
        }
      }
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    blockingErrors: issues.some((i) => i.severity === "error"),
    issues,
  };
}

function eqName(a: string, b: string) {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;
  return a.replace(/[^a-z0-9]/gi, "").toLowerCase() === b.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function generateDaxMeasures(tables: FinalTable[], variables: Record<string, string>): string {
  const facts = (tables || []).filter((t) => t.type === "Fact");
  const lines: string[] = ["// Auto-generated DAX measures from analyzed Qlik metadata", ""];

  for (const fact of facts) {
    const numericCols = (fact.columns || []).filter((c) => /Decimal|Integer|Number/.test(c.dataType));
    for (const col of numericCols) {
      const measureName = `Total ${col.name}`;
      lines.push(`${measureName} = SUM('${fact.name}'[${col.name}])`, "");
    }
    if (numericCols.length) {
      lines.push(`${fact.name} Row Count = COUNTROWS('${fact.name}')`, "");
    }
  }

  for (const [varName, expr] of Object.entries(variables || {})) {
    const dax = convertSetAnalysis(expr, tables);
    lines.push(`${varName} = ${dax}`, "");
  }

  if (lines.length === 2) {
    lines.push("// No numeric measures could be auto-generated from the current schema.");
  }
  return lines.join("\n");
}

function convertSetAnalysis(expr: string, tables: FinalTable[]): string {
  if (!expr) return "BLANK()";
  const setMatch = expr.match(/\bSum\s*\(\s*\{[^}]*\}\s*([^)]+)\)/i);
  if (!setMatch) return expr.replace(/\bSum\s*\(/gi, "SUM(");
  return `CALCULATE(SUM('FactTable'[${setMatch[1].trim()}]))  // Converted from: ${expr.slice(0, 80)}`;
}

export function generateSemanticModel(tables: FinalTable[], rels: Relationship[]) {
  return {
    name: "MigratedSemanticModel",
    tables: (tables || []).map((t) => ({
      name: t.name,
      columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })),
      keys: (t.keys || (t.columns || []).filter((c) => /(_id|Id|Key|_KEY)$/.test(c.name) || /^id$/i.test(c.name)).map((c) => c.name)),
    })),
    relationships: (rels || []).map((r) => ({
      fromTable: r.fromTable, fromColumn: r.fromColumn,
      toTable: r.toTable, toColumn: r.toColumn,
      cardinality: r.cardinality,
    })),
  };
}

export function buildGenerationArgs(args: {
  businessMetadata: BusinessMetadata;
  technicalMetadata: TechnicalMetadata;
  finalTables: FinalTable[];
  relationships: Relationship[];
  variables: Record<string, string>;
}) {
  return {
    tables: args.finalTables || [],
    relationships: args.relationships || [],
    variables: args.variables || {},
    keys: (args.finalTables || []).map((t) => ({ table: t.name, columns: (t.keys || (t.columns || []).filter((c) => /(_id|Id|Key|_KEY)$/.test(c.name) || /^id$/i.test(c.name)).map((c) => c.name)) })),
  };
}

export function buildTableDependencyOrder(tables: FinalTable[]): FinalTable[] {
  const visited = new Set<string>();
  const order: FinalTable[] = [];
  function visit(t: FinalTable) {
    if (visited.has(t.name)) return;
    visited.add(t.name);
    for (const s of (t.steps || [])) {
      if (s.kind === "JOIN" || s.kind === "CONCATENATE") {
        const dep = (tables || []).find((x) => x.name === s.withTable);
        if (dep) visit(dep);
      }
      if (s.kind === "RESIDENT") {
        const dep = (tables || []).find((x) => x.name === s.from);
        if (dep) visit(dep);
      }
    }
    order.push(t);
  }
  for (const t of (tables || [])) visit(t);
  return order;
}

export function qlikExprToM(expr: string): string {
  if (expr == null) return "null";
  let e = String(expr).trim();
  if (!e || e === "*") return "true";
  e = e.replace(/\$\(([A-Za-z0-9_]+)\)/g, "$1");
  e = convertIfExpr(e);
  e = e.replace(/\bdate#?\s*\(([^,)]+)(?:,\s*'([^']+)')?\)/gi, (_m, v) => `Date.From(${qlikExprToM(v.trim())})`);
  e = e.replace(/\bnum#?\s*\(([^,)]+)(?:,[^)]*)?'\)/gi, (_m, v) => `Number.From(${qlikExprToM(v.trim())})`);
  e = e.replace(/\btext\s*\(([^)]+)\)/gi, (_m, v) => `Text.From(${qlikExprToM(v.trim())})`);
  e = e.replace(/\bupper\s*\(([^)]+)\)/gi, (_m, v) => `Text.Upper(${qlikExprToM(v.trim())})`);
  e = e.replace(/\blower\s*\(([^)]+)\)/gi, (_m, v) => `Text.Lower(${qlikExprToM(v.trim())})`);
  e = e.replace(/\btrim\s*\(([^)]+)\)/gi, (_m, v) => `Text.Trim(${qlikExprToM(v.trim())})`);
  e = e.replace(/\bleft\s*\(([^,]+),\s*([^)]+)\)/gi, (_m, v, n) => `Text.Start(${qlikExprToM(v.trim())}, ${n.trim()})`);
  e = e.replace(/\bright\s*\(([^,]+),\s*([^)]+)\)/gi, (_m, v, n) => `Text.End(${qlikExprToM(v.trim())}, ${n.trim()})`);
  e = e.replace(/\bmid\s*\(([^,]+),\s*([^,]+),\s*([^)]+)\)/gi, (_m, v, start, len) => `Text.Middle(${qlikExprToM(v.trim())}, ${start.trim()} - 1, ${len.trim()})`);
  e = e.replace(/\blen\s*\(([^)]+)\)/gi, (_m, v) => `Text.Length(${qlikExprToM(v.trim())})`);
  e = e.replace(/\byear\s*\(([^)]+)\)/gi, (_m, v) => `Date.Year(${qlikExprToM(v.trim())})`);
  e = e.replace(/\bmonth\s*\(([^)]+)\)/gi, (_m, v) => `Date.Month(${qlikExprToM(v.trim())})`);
  e = e.replace(/\bday\s*\(([^)]+)\)/gi, (_m, v) => `Date.Day(${qlikExprToM(v.trim())})`);
  e = e.replace(/\btoday\s*\(\s*\)/gi, "Date.From(DateTime.LocalNow())");
  e = e.replace(/'([^']*)'/g, '"$1"');
  const strings: string[] = [];
  const bracketRefs: string[] = [];
  e = e.replace(/"[^"]*"/g, (m) => {
    strings.push(m);
    return `\u0015${strings.length - 1}\u0015`;
  });
  e = e.replace(/\[[^\]]+\]/g, (m) => {
    bracketRefs.push(mField(m.slice(1, -1)));
    return `\u000f${bracketRefs.length - 1}\u000f`;
  });
  e = e.replace(/\bAND\b/gi, "and").replace(/\bOR\b/gi, "or").replace(/\bNOT\b/gi, "not");
  e = e.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (match, _ident, offset, full) => {
    const prev = full[offset - 1];
    const next = full[offset + match.length];
    if (prev === '"' || next === '"') return match;
    if (/^(and|or|not|if|then|else|true|false|null|each|let|in|is|as|meta|error|try|otherwise|section|shared)$/i.test(match)) return match;
    if (next === "(") return match;
    return mField(match);
  });
  e = e.replace(/\u000f(\d+)\u000f/g, (_m, i) => bracketRefs[Number(i)] || "");
  e = e.replace(/\u0015(\d+)\u0015/g, (_m, i) => strings[Number(i)] || '""');
  return e;
}

function splitTopLevel(body: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, inStr: string | null = null, cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function convertIfExpr(expr: string): string {
  const match = expr.match(/^\s*if\s*\((.*)\)\s*$/i);
  if (!match) return expr;
  const parts = splitTopLevel(match[1]);
  if (parts.length < 3) return expr;
  return `if ${qlikExprToM(parts[0])} then ${qlikExprToM(parts[1])} else ${qlikExprToM(parts.slice(2).join(","))}`;
}
