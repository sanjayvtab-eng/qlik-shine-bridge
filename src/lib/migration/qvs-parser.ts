import type {
  SourcePlatform, SourceTable, SourceColumn, EtlOperation,
  FinalTable, Relationship, TableStep,
} from "./types";

let _id = 0;
const uid = (p: string) => `${p}_${++_id}_${Date.now().toString(36)}`;

const PLATFORM_HINTS: { match: RegExp; platform: SourcePlatform }[] = [
  { match: /sqlserver|mssql|sql_server|Provider=SQLOLEDB|Driver=\{SQL Server/i, platform: "SQL Server" },
  { match: /oracle|oci|tns/i, platform: "Oracle" },
  { match: /mysql/i, platform: "MySQL" },
  { match: /postgres|postgresql/i, platform: "PostgreSQL" },
  { match: /snowflake/i, platform: "Snowflake" },
  { match: /databricks/i, platform: "Databricks" },
  { match: /\.xlsx?|excel|ooxml|biff/i, platform: "Excel" },
  { match: /\.csv|txt.*delimiter|\.tsv/i, platform: "CSV" },
  { match: /\.parquet/i, platform: "Parquet" },
  { match: /\.json/i, platform: "JSON" },
  { match: /\.xml/i, platform: "XML" },
  { match: /sap|abap|bw|hana/i, platform: "SAP" },
  { match: /rest|http[s]?:\/\/|api\./i, platform: "REST API" },
  { match: /\.qvd/i, platform: "QVD" },
];

function detectPlatform(text: string): SourcePlatform {
  for (const { match, platform } of PLATFORM_HINTS) if (match.test(text)) return platform;
  if (/^SQL:/i.test(text)) return "SQL Server";
  if (/\bSQL\s+SELECT\b/i.test(text)) return "SQL Server";
  return "Unknown";
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*REM\s.*$/gim, "");
}

interface FieldExpr { name: string; expr?: string; alias?: boolean; }

interface ParsedLoadBody {
  fields: FieldExpr[];
  from?: string;
  resident?: string;
  where?: string;
  sourceQuery?: string;
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

function parseFieldExpr(raw: string): FieldExpr | null {
  let s = raw.trim().replace(/;$/, "");
  if (!s) return null;
  if (/^(LOAD|SQL|RESIDENT|FROM|WHERE|GROUP|ORDER|MAPPING)\b/i.test(s)) return null;
  if (s === "*") return { name: "*" };
  // alias: "expr AS name" or "expr as [name]" (handle case-insensitively, last AS at top level)
  const asMatch = s.match(/^([\s\S]+?)\s+AS\s+\[?([A-Za-z0-9_ #]+?)\]?\s*$/i);
  if (asMatch) {
    const expr = asMatch[1].trim();
    const name = asMatch[2].trim();
    // Pure field reference?
    if (/^\[?[A-Za-z0-9_ ]+\]?$/.test(expr) && expr.replace(/[\[\]]/g, "").trim() === name) {
      return { name };
    }
    return { name, expr, alias: true };
  }
  // plain field
  const bare = s.replace(/^\[|\]$/g, "").trim();
  if (!/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(bare)) {
    // expression without alias — synthesize name
    return { name: `Calc${Math.floor(Math.random() * 1e4)}`, expr: s, alias: true };
  }
  return { name: bare };
}

function parseFieldList(body: string): FieldExpr[] {
  return splitTopLevel(body).map(parseFieldExpr).filter(Boolean) as FieldExpr[];
}

function inferTypeForField(f: FieldExpr): string {
  const s = (f.expr || f.name).toLowerCase();
  if (/\bif\s*\([^)]*['"][^'"]+['"]/.test(s)) return "String";
  if (/\bdate#|\bdate\(|today\(|year\(|month\(|monthstart|day\(|orderdate|shipdate|invoice.?date|created.?date/.test(s)) return "Date";
  if (/\bint\(|round\(|floor\(|ceil\(/.test(s)) return "Integer";
  if (/\bnum#|\bsum\(|\bcount\(|\bavg\(|\bmin\(|\bmax\(|money|\bprice|\bqty|quantity|\bamount|\brevenue|\bcost|profit|margin|\btotal|usd|eur|gbp/.test(s)) return "Decimal";
  if (/(_id|id|key)$/i.test(f.name)) return "Integer";
  if (/date|_dt$/i.test(f.name)) return "Date";
  return "String";
}

interface Statement {
  raw: string;
  prefixes: string[]; // tokens before LOAD/SQL: MAPPING, LEFT JOIN(T), CONCATENATE(T), KEEP(T), NOCONCATENATE
  tableLabel?: string;
  body: string;       // after table label, includes LOAD ... etc
}

function splitStatements(src: string): Statement[] {
  // Split on ; at top level (respect quotes)
  const stmts: string[] = [];
  let depth = 0, inStr: string | null = null, cur = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { cur += ch; if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '"') { inStr = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === ";" && depth === 0) { stmts.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) stmts.push(cur);

  const out: Statement[] = [];
  for (const s of stmts) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    // Table label
    const labelMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
    let body = trimmed;
    let tableLabel: string | undefined;
    if (labelMatch && /^(MAPPING\s+|NOCONCATENATE\s+|(?:LEFT|RIGHT|INNER|OUTER)\s+(?:JOIN|KEEP)\s*(?:\([^)]*\))?\s*|JOIN\s*(?:\([^)]*\))?\s*|KEEP\s*(?:\([^)]*\))?\s*|CONCATENATE\s*(?:\([^)]*\))?\s*|ADD\s+|REPLACE\s+|BUFFER\s+)*(LOAD|SQL|SELECT)\b/i.test(labelMatch[2])) {
      tableLabel = labelMatch[1];
      body = labelMatch[2];
    }
    // Extract prefixes (before LOAD/SQL/SELECT)
    const prefixes: string[] = [];
    const prefixRegex = /^\s*(MAPPING|NOCONCATENATE|(?:LEFT|RIGHT|INNER|OUTER)\s+(?:JOIN|KEEP)|JOIN|KEEP|CONCATENATE|ADD|REPLACE|BUFFER)\s*(?:\(\s*[A-Za-z0-9_]+\s*\))?\s*/i;
    while (true) {
      const m = body.match(prefixRegex);
      if (!m) break;
      prefixes.push(m[0].trim());
      body = body.slice(m[0].length);
    }
    out.push({ raw: trimmed, prefixes, tableLabel, body });
  }
  return out;
}

function parseLoadBody(body: string): ParsedLoadBody {
  const isSql = /^\s*SQL\s+/i.test(body) || /^\s*SELECT\s+/i.test(body);
  if (isSql) {
    // SQL SELECT ... FROM ... WHERE ...
    const sql = body.replace(/^\s*SQL\s+/i, "").trim();
    const sel = sql.match(/^SELECT\s+([\s\S]+?)\s+FROM\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
    if (sel) {
      const fields = sel[1].split(",").map((c) => {
        const a = c.trim().match(/^([\s\S]+?)(?:\s+AS\s+([A-Za-z0-9_]+))?$/i);
        const name = a?.[2] || a?.[1]?.replace(/.*\./, "").trim() || c.trim();
        return { name } as FieldExpr;
      });
      return { fields, from: `SQL: ${sel[2].trim()}`, where: sel[3]?.trim(), sourceQuery: sql };
    }
    return { fields: [], from: sql, sourceQuery: sql };
  }
  const loadMatch = body.match(/LOAD\s+([\s\S]*?)(?:\s+(FROM|RESIDENT)\s+([\s\S]+))?$/i);
  if (!loadMatch) return { fields: [] };
  const fields = parseFieldList(loadMatch[1]);
  const kind = loadMatch[2]?.toUpperCase();
  const rest = loadMatch[3] || "";
  if (kind === "FROM") {
    const whereSplit = rest.split(/\bWHERE\b/i);
    return { fields, from: whereSplit[0].trim(), where: whereSplit[1]?.trim() };
  }
  if (kind === "RESIDENT") {
    const whereSplit = rest.split(/\bWHERE\b/i);
    const resName = whereSplit[0].trim().split(/\s+/)[0];
    return { fields, resident: resName, where: whereSplit[1]?.trim() };
  }
  return { fields };
}

function parseConnectionName(raw: string): string | undefined {
  const lib = raw.match(/^\s*LIB\s+CONNECT\s+TO\s+['"]?([^;'"\]]+)['"]?/i);
  if (lib) return lib[1].trim();
  const connect = raw.match(/^\s*CONNECT\s+(?:TO\s+)?(?:\[([^\]]+)\]|'([^']+)'|"([^"]+)"|([^;]+))/i);
  return (connect?.[1] || connect?.[2] || connect?.[3] || connect?.[4])?.trim();
}

function inferSqlParts(from: string): { database?: string; schema?: string; table?: string } {
  const table = (from.match(/^SQL:\s*([A-Za-z0-9_.\[\]"]+)/i) || [])[1]?.replace(/[\[\]"]/g, "");
  if (!table) return {};
  const parts = table.split(".").filter(Boolean);
  if (parts.length >= 3) return { database: parts[0], schema: parts[1], table: parts[2] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { table: parts[0] };
}

function isWildcardField(f: FieldExpr): boolean {
  return f.name === "*";
}

function addColumns(target: FinalTable, fields: FieldExpr[]) {
  for (const f of fields) {
    if (isWildcardField(f)) continue;
    if (!target.columns.find((c) => c.name === f.name)) {
      target.columns.push({
        name: f.name,
        dataType: inferTypeForField(f),
        derived: !!f.expr && !/^\[?[A-Za-z_][A-Za-z0-9_ ]*\]?$/.test(f.expr),
        expression: f.expr,
      });
    }
  }
  target.keys = target.columns
    .map((c) => c.name)
    .filter((n) => /(_id|Id|Key|_KEY)$/.test(n) || /^id$/i.test(n));
}

function parsePrefixTarget(prefix: string): string | undefined {
  const m = prefix.match(/\(\s*([A-Za-z0-9_]+)\s*\)/);
  return m?.[1];
}

function joinTypeFromPrefix(prefix: string): "Left" | "Right" | "Inner" | "Outer" {
  if (/LEFT/i.test(prefix)) return "Left";
  if (/RIGHT/i.test(prefix)) return "Right";
  if (/OUTER/i.test(prefix)) return "Outer";
  return "Inner";
}

export function parseSourceQvs(text: string): SourceTable[] {
  const src = stripComments(text);
  const stmts = splitStatements(src);
  const tables: SourceTable[] = [];
  let idx = 0;
  let currentConnection: string | undefined;
  for (const s of stmts) {
    const connection = parseConnectionName(s.raw);
    if (connection) {
      currentConnection = connection;
      continue;
    }
    const body = parseLoadBody(s.body);
    if (!body.from) continue;
    const platform = detectPlatform(body.from + " " + s.raw);
    const qvdName = (body.from.match(/([A-Za-z0-9_\-]+\.qvd)/i) || [])[1];
    const filePath = (body.from.match(/([A-Za-z]:[\\\/][^\s\)]+|\/[^\s\)]+|lib:\/\/[^\s\)]+)/i) || [])[1];
    const sql = inferSqlParts(body.from);
    const name = s.tableLabel || sql.table || qvdName?.replace(/\.qvd$/i, "") || `Table_${++idx}`;
    const columns: SourceColumn[] = body.fields.filter((f) => !isWildcardField(f)).map((f) => ({ name: f.name, dataType: inferTypeForField(f) }));
    tables.push({
      id: uid("src"), name, platform, database: sql.database, schema: sql.schema,
      connectionName: currentConnection,
      sourceQuery: body.sourceQuery,
      connectionPath: filePath || body.from.slice(0, 200),
      qvdName, filePath, columns,
    });
  }
  return tables;
}

export interface EtlAnalysisResult {
  etlOperations: EtlOperation[];
  allTables: FinalTable[];
  finalTables: FinalTable[];
  relationships: Relationship[];
  droppedTables: string[];
  intermediateTables: string[];
  variables: Record<string, string>;
}

export function parseEtlQvs(text: string, sourceTables: SourceTable[] = []): EtlAnalysisResult {
  const src = stripComments(text);
  const ops: EtlOperation[] = [];
  const variables: Record<string, string> = {};
  const dropped = new Set<string>();
  const renamesTable: Record<string, string> = {};
  const tables = new Map<string, FinalTable>();
  const mappings = new Map<string, { keyField: string; valueField: string }>();
  let lastTable: string | undefined;
  let currentConnection: string | undefined;

  // Vars
  for (const m of src.matchAll(/SET\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi)) variables[m[1]] = m[2].trim();
  for (const m of src.matchAll(/LET\s+([A-Za-z0-9_]+)\s*=\s*([^;]+);/gi)) variables[m[1]] = m[2].trim();

  // Top-level non-LOAD ops (drop / rename / store) — scanned globally first
  for (const m of src.matchAll(/DROP\s+TABLE[S]?\s+([A-Za-z0-9_, ]+);/gi)) {
    for (const n of m[1].split(",").map((s) => s.trim())) {
      dropped.add(n);
      ops.push({ kind: "DROP", table: n, raw: m[0] });
    }
  }
  for (const m of src.matchAll(/RENAME\s+TABLE\s+([A-Za-z0-9_]+)\s+TO\s+([A-Za-z0-9_]+);/gi)) {
    renamesTable[m[1]] = m[2];
    ops.push({ kind: "RENAME_TABLE", table: m[1], target: m[2], raw: m[0] });
  }
  for (const m of src.matchAll(/STORE\s+([A-Za-z0-9_]+)\s+INTO/gi)) {
    ops.push({ kind: "STORE", table: m[1], raw: m[0] });
  }

  const stmts = splitStatements(src);

  const ensure = (name: string, type: FinalTable["type"] = "Dimension"): FinalTable => {
    if (!tables.has(name)) {
      tables.set(name, {
        id: uid("ft"), name, type, columns: [], sourceTables: [], isFinal: true, steps: [], keys: [], lineage: [],
      });
    }
    return tables.get(name)!;
  };

  const findSourceColumns = (from?: string, resident?: string): FieldExpr[] => {
    if (resident) {
      const rt = tables.get(resident);
      return rt?.columns.map((c) => ({ name: c.name })) ?? [];
    }
    if (!from) return [];
    const clean = from.toLowerCase();
    const match = sourceTables.find((s) => {
      const tokens = [s.name, s.qvdName, s.filePath, s.connectionPath, s.sourceQuery].filter(Boolean).map((x) => String(x).toLowerCase());
      return tokens.some((token) => clean.includes(token) || token.includes(clean.slice(0, 80)));
    });
    return match?.columns.map((c) => ({ name: c.name })) ?? [];
  };

  const expandWildcards = (body: ParsedLoadBody): FieldExpr[] => {
    if (!body.fields.some(isWildcardField)) return body.fields;
    const expanded = findSourceColumns(body.from, body.resident);
    return [
      ...body.fields.filter((f) => !isWildcardField(f)),
      ...expanded.filter((f) => !body.fields.some((existing) => existing.name === f.name)),
    ];
  };

  const appendFieldSteps = (t: FinalTable, fields: FieldExpr[]) => {
    for (const f of fields) {
      if (!f.expr) continue;
      const applyMap = f.expr.match(/ApplyMap\s*\(\s*['"]?([^,'"]+)['"]?\s*,\s*([^,\)]+)(?:,\s*([^\)]+))?\)/i);
      if (applyMap) {
        t.steps!.push({
          kind: "APPLYMAP",
          mapName: applyMap[1].trim(),
          sourceField: applyMap[2].replace(/[\[\]]/g, "").trim(),
          asField: f.name,
          defaultValue: applyMap[3]?.trim(),
        });
        continue;
      }
      const simple = f.expr.replace(/[\[\]]/g, "").trim();
      if (/^[A-Za-z_][A-Za-z0-9_ ]*$/.test(simple) && simple !== f.name) {
        t.steps!.push({ kind: "RENAME_FIELD", from: simple, to: f.name });
      } else {
        t.steps!.push({ kind: "DERIVED", name: f.name, expression: f.expr });
      }
    }
  };

  for (const s of stmts) {
    const connection = parseConnectionName(s.raw);
    if (connection) {
      currentConnection = connection;
      continue;
    }
    const body = parseLoadBody(s.body);
    if (!body.fields.length && !body.from && !body.resident) continue;
    const fields = expandWildcards(body);

    const isMapping = s.prefixes.some((p) => /^MAPPING$/i.test(p));
    const joinPrefix = s.prefixes.find((p) => /JOIN/i.test(p));
    const keepPrefix = s.prefixes.find((p) => /KEEP/i.test(p));
    const concatPrefix = s.prefixes.find((p) => /^CONCATENATE/i.test(p));

    // Pure RENAME FIELD statement
    const renameFieldMatch = s.raw.match(/^RENAME\s+FIELD[S]?\s+([\s\S]+)$/i);
    if (renameFieldMatch) {
      const pairs = splitTopLevel(renameFieldMatch[1]);
      for (const p of pairs) {
        const pm = p.trim().match(/([A-Za-z0-9_]+)\s+TO\s+([A-Za-z0-9_]+)/i);
        if (pm && lastTable) {
          const t = tables.get(lastTable);
          if (t) {
            t.steps!.push({ kind: "RENAME_FIELD", from: pm[1], to: pm[2] });
            const c = t.columns.find((x) => x.name === pm[1]);
            if (c) c.name = pm[2];
          }
          ops.push({ kind: "RENAME_FIELD", table: lastTable, raw: p });
        }
      }
      continue;
    }

    // MAP ... USING ... → ApplyMap
    const mapUsing = s.raw.match(/MAP\s+([A-Za-z0-9_,\s]+)\s+USING\s+([A-Za-z0-9_]+)/i);
    if (mapUsing) {
      const target = lastTable;
      if (target) {
        for (const f of mapUsing[1].split(",").map((x) => x.trim())) {
          tables.get(target)?.steps!.push({
            kind: "APPLYMAP", mapName: mapUsing[2], sourceField: f, asField: f,
          });
        }
      }
      ops.push({ kind: "APPLYMAP", table: mapUsing[2], raw: s.raw.slice(0, 200) });
      continue;
    }

    if (isMapping) {
      // MAPPING LOAD key, value FROM/RESIDENT ...
      const name = s.tableLabel || `Map_${tables.size + 1}`;
      const t = ensure(name, "Mapping");
      t.type = "Mapping";
      t.isFinal = false;
      t.columns = fields.map((f) => ({ name: f.name, dataType: inferTypeForField(f) }));
      if (fields.length >= 2) {
        mappings.set(name, { keyField: fields[0].name, valueField: fields[1].name });
      }
      t.steps!.push(body.from
        ? { kind: "LOAD", from: body.from, fields, where: body.where, platform: detectPlatform(body.from), connectionName: currentConnection, sourceQuery: body.sourceQuery }
        : { kind: "RESIDENT", from: body.resident!, fields, where: body.where });
      ops.push({ kind: "MAPPING", table: name, raw: s.raw.slice(0, 200) });
      continue;
    }

    if (joinPrefix || keepPrefix || concatPrefix) {
      const target = parsePrefixTarget(joinPrefix || keepPrefix || concatPrefix || "") || lastTable;
      if (!target) continue;
      const t = ensure(target);
      const fieldNames = fields.map((f) => f.name);
      const keyFields = t.columns.map((c) => c.name).filter((name) => fieldNames.includes(name));
      // also add new columns to the target so generator knows them
      addColumns(t, fields);
      appendFieldSteps(t, fields);
      if (body.resident) t.lineage = [...new Set([...(t.lineage || []), body.resident])];
      if (body.from) {
        t.sourceTables.push(body.from.slice(0, 120));
        t.lineage = [...new Set([...(t.lineage || []), body.from.slice(0, 120)])];
      }
      if (concatPrefix) {
        t.steps!.push({
          kind: "CONCATENATE", withTable: target, withFields: fieldNames,
          resident: body.resident, fromClause: body.from, connectionName: currentConnection, sourceQuery: body.sourceQuery, platform: body.from ? detectPlatform(body.from) : undefined,
        });
        ops.push({ kind: "CONCATENATE", table: target, raw: s.raw.slice(0, 200) });
      } else if (keepPrefix) {
        t.steps!.push({
          kind: "KEEP", joinType: joinTypeFromPrefix(keepPrefix) === "Outer" ? "Inner" : joinTypeFromPrefix(keepPrefix) as "Left" | "Right" | "Inner", withTable: body.resident || target,
        });
        ops.push({ kind: "KEEP", table: target, detail: joinTypeFromPrefix(keepPrefix), raw: s.raw.slice(0, 200) });
      } else if (joinPrefix) {
        t.steps!.push({
          kind: "JOIN", joinType: joinTypeFromPrefix(joinPrefix), withTable: body.resident || target,
          withFields: fieldNames, keyFields, resident: body.resident, fromClause: body.from, connectionName: currentConnection, sourceQuery: body.sourceQuery, platform: body.from ? detectPlatform(body.from) : undefined,
        });
        ops.push({ kind: "JOIN", table: target, detail: joinTypeFromPrefix(joinPrefix), raw: s.raw.slice(0, 200) });
      }
      lastTable = target;
      continue;
    }

    // Plain LOAD
    if (!s.tableLabel && !body.from && !body.resident) continue;
    const precedingTarget = !s.tableLabel && !!body.from && !!lastTable && !!tables.get(lastTable)
      && !(tables.get(lastTable)!.steps || []).some((step) => step.kind === "LOAD" || step.kind === "RESIDENT");
    const name = precedingTarget ? lastTable! : s.tableLabel || (body.from?.match(/([A-Za-z0-9_]+)\.qvd/i)?.[1]) || `Table_${tables.size + 1}`;
    const t = ensure(name);
    addColumns(t, fields);
    appendFieldSteps(t, fields);
    if (body.from) {
      const platform = detectPlatform(body.from);
      t.sourcePlatform = platform;
      t.sourceConnection = body.from.slice(0, 300);
      t.sourceTables.push(body.from.slice(0, 80));
      t.lineage = [...new Set([...(t.lineage || []), body.from.slice(0, 120)])];
      // Insert LOAD step at front
      t.steps!.unshift({ kind: "LOAD", from: body.from, fields, where: body.where, platform, connectionName: currentConnection, sourceQuery: body.sourceQuery });
      ops.push({ kind: "LOAD", table: name, raw: s.raw.slice(0, 200) });
    } else if (body.resident) {
      t.sourceTables.push(body.resident);
      t.lineage = [...new Set([...(t.lineage || []), body.resident])];
      t.steps!.unshift({ kind: "RESIDENT", from: body.resident, fields, where: body.where });
      ops.push({ kind: "RESIDENT", table: name, detail: body.resident, raw: s.raw.slice(0, 200) });
    }
    lastTable = name;
  }

  // Apply DROP + RENAME table
  for (const name of [...tables.keys()]) {
    if (dropped.has(name)) tables.get(name)!.isFinal = false;
  }
  for (const [from, to] of Object.entries(renamesTable)) {
    const t = tables.get(from);
    if (t) { t.name = to; tables.set(to, t); tables.delete(from); }
  }

  const allTables = [...tables.values()];
  const finalTables = allTables.filter((t) => t.isFinal && t.type !== "Mapping");

  // Classify Fact/Dimension based on structure
  for (const t of finalTables) {
    t.type = classifyTable(t, finalTables);
  }

  // Detect relationships via shared key column names
  const relationships: Relationship[] = [];
  const keyMap = new Map<string, { table: string; col: string }[]>();
  for (const t of finalTables) {
    for (const c of t.columns) {
      if (/(_id|Id|Key|_KEY)$/.test(c.name) || /^id$/i.test(c.name)) {
        if (!keyMap.has(c.name)) keyMap.set(c.name, []);
        keyMap.get(c.name)!.push({ table: t.name, col: c.name });
      }
    }
  }
  for (const [, refs] of keyMap) {
    if (refs.length < 2) continue;
    const dim = refs.find((r) => tables.get(r.table)?.type === "Dimension") || refs[0];
    for (const r of refs) {
      if (r === dim) continue;
      relationships.push({
        id: uid("rel"),
        fromTable: r.table, fromColumn: r.col,
        toTable: dim.table, toColumn: dim.col,
        cardinality: "N:1",
      });
    }
  }

  // Include mapping tables in metadata via etlOperations only (not as final)
  return {
    etlOperations: ops,
    allTables,
    finalTables,
    relationships,
    droppedTables: [...dropped],
    intermediateTables: allTables.filter((t) => !t.isFinal && t.type !== "Mapping").map((t) => t.name),
    variables,
  };
}

function classifyTable(t: FinalTable, all: FinalTable[]): FinalTable["type"] {
  const n = t.name;
  if (/calendar|date_dim|^date$|^time$/i.test(n)) return "Calendar";
  if (/^(dim|d_)/i.test(n) || /_dim$/i.test(n)) return "Dimension";
  if (/^(fact|f_)/i.test(n) || /_fact$/i.test(n)) return "Fact";

  // Structural: a Fact has multiple FK-like columns referencing other tables,
  // many numeric measures, and is "wide" with joins/concatenates.
  const cols = t.columns;
  const idCols = cols.filter((c) => /(_id|Id|Key|_KEY)$/.test(c.name) || /^id$/i.test(c.name));
  const numericCols = cols.filter((c) => /Decimal|Integer|Number/.test(c.dataType));
  const otherIdRefs = idCols.filter((c) =>
    all.some((o) => o.name !== t.name && o.columns.some((oc) => oc.name === c.name)),
  );
  const hasJoinSteps = (t.steps || []).some((s) => s.kind === "JOIN" || s.kind === "CONCATENATE" || s.kind === "KEEP");
  const score =
    otherIdRefs.length * 2 + (numericCols.length >= 3 ? 2 : 0) + (hasJoinSteps ? 1 : 0) +
    (/sales|orders|transactions|revenue|invoice|shipment|payment|ledger/i.test(n) ? 3 : 0);

  if (score >= 3) return "Fact";
  return "Dimension";
}
