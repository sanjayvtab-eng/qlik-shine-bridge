import type { Requirement, FinalTable, Relationship, SourceTable } from "./types";

const splitList = (s: string) =>
  s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);

export function generateRuleBook(r: Requirement): string {
  const tables = splitList(r.sourceTableNames);
  const columns = splitList(r.sourceColumnNames);
  const date = new Date().toISOString().slice(0, 10);

  return `# Migration Rule Book — ${r.reportName || "Untitled Report"}

_Generated on ${date} • Qlik → Power BI Migration_

---

## 1. Report Overview
**Report Name:** ${r.reportName || "—"}

${r.businessRequirement ? r.businessRequirement.split("\n")[0] : "_No overview provided._"}

## 2. Business Objective
${r.businessObjective || "_Not specified._"}

## 3. Business Requirement
${r.businessRequirement || "_Not specified._"}

## 4. Source Tables
${tables.length ? tables.map((t) => `- \`${t}\``).join("\n") : "_No source tables declared._"}

## 5. Source Columns
${columns.length ? columns.map((c) => `- \`${c}\``).join("\n") : "_No source columns declared._"}

## 6. Business Rules
${deriveBusinessRules(r).map((rule, i) => `${i + 1}. ${rule}`).join("\n") || "- _None inferred._"}

## 7. Expected Output
${r.expectedOutput || "_Not specified._"}

${r.sampleData ? `## 8. Sample Data\n\n\`\`\`\n${r.sampleData.trim()}\n\`\`\`\n` : ""}

## ${r.sampleData ? "9" : "8"}. Migration Guidelines
- Preserve all business logic from the original Qlik application.
- Apply star-schema modelling in the Power BI semantic layer.
- Convert Qlik Set Analysis expressions to equivalent DAX with full variable resolution.
- Drop transient/intermediate tables produced by the Qlik ETL.
- Generate a Calendar/Date dimension when any date column is detected.
- Maintain referential integrity through enforced relationships.
- Validate every generated DAX measure against the final Power BI schema.
`;
}

function deriveBusinessRules(r: Requirement): string[] {
  const rules: string[] = [];
  const text = `${r.businessRequirement} ${r.businessObjective} ${r.expectedOutput}`.toLowerCase();
  if (/ytd|year to date/.test(text)) rules.push("Year-to-Date (YTD) aggregations required.");
  if (/last year|previous year|py|yoy/.test(text)) rules.push("Prior-year / YoY comparisons required.");
  if (/rolling|moving avg|moving average/.test(text)) rules.push("Rolling/moving average calculations required.");
  if (/top\s*\d|rank/.test(text)) rules.push("Ranking and Top-N analyses required.");
  if (/filter|slice|by\s+(region|country|category|product)/.test(text))
    rules.push("Multiple slice-and-dice dimensions required.");
  if (/forecast|projection|target/.test(text)) rules.push("Forecast vs. actuals comparison required.");
  if (!rules.length) rules.push("Standard aggregations and KPI calculations as described.");
  return rules;
}

/**
 * Lightweight AI-style analysis of the Rule Book text — extracts tables,
 * columns and likely relationships to seed the centralised metadata model.
 */
export function analyzeRuleBook(md: string, r?: Requirement): {
  finalTables: FinalTable[];
  relationships: Relationship[];
  sourceTables: SourceTable[];
} {
  const tableNames = r
    ? splitList(r.sourceTableNames)
    : extractListUnder(md, /##\s*\d+\.\s*Source Tables/i);
  const columnNames = r
    ? splitList(r.sourceColumnNames)
    : extractListUnder(md, /##\s*\d+\.\s*Source Columns/i);

  // Heuristically allocate each column to a table by prefix or shared token
  const finalTables: FinalTable[] = tableNames.map((name, i) => {
    const lower = name.toLowerCase();
    const cols = columnNames
      .filter((c) => {
        const cl = c.toLowerCase();
        const matchesTable = cl.startsWith(lower) || cl.includes(lower);
        return matchesTable || tableNames.length === 1;
      })
      .map((c) => ({ name: c.replace(/^[A-Za-z]+\./, ""), dataType: inferType(c) }));

    return {
      id: `ai_${i}_${name}`,
      name,
      type: classify(name),
      columns: cols.length ? cols : columnNames.slice(0, 3).map((c) => ({ name: c, dataType: inferType(c) })),
      sourceTables: [name],
      isFinal: true,
    };
  });

  // Relationships: shared *_ID/Key columns
  const relationships: Relationship[] = [];
  const keyIndex = new Map<string, { table: string; col: string }[]>();
  for (const t of finalTables) {
    for (const c of t.columns) {
      if (/_id$|id$|key$/i.test(c.name)) {
        const k = c.name.toLowerCase();
        if (!keyIndex.has(k)) keyIndex.set(k, []);
        keyIndex.get(k)!.push({ table: t.name, col: c.name });
      }
    }
  }
  let ridx = 0;
  for (const [, refs] of keyIndex) {
    if (refs.length < 2) continue;
    const dim = refs.find((r) => classify(r.table) === "Dimension") || refs[0];
    for (const r of refs) {
      if (r === dim) continue;
      relationships.push({
        id: `rel_ai_${++ridx}`,
        fromTable: r.table, fromColumn: r.col,
        toTable: dim.table, toColumn: dim.col,
        cardinality: "N:1",
      });
    }
  }

  const sourceTables: SourceTable[] = tableNames.map((name, i) => ({
    id: `srcai_${i}`,
    name,
    platform: "Unknown",
    connectionPath: "",
    columns: finalTables[i]?.columns.map((c) => ({ name: c.name, dataType: c.dataType })) ?? [],
  }));

  return { finalTables, relationships, sourceTables };
}

function extractListUnder(md: string, header: RegExp): string[] {
  const idx = md.search(header);
  if (idx < 0) return [];
  const after = md.slice(idx).split(/\n##\s/)[0];
  return [...after.matchAll(/^[-*]\s+`?([^`\n]+)`?\s*$/gm)].map((m) => m[1].trim());
}

function classify(name: string): FinalTable["type"] {
  if (/calendar|date|time/i.test(name)) return "Calendar";
  if (/^(dim|d_)/i.test(name) || /_dim$/i.test(name)) return "Dimension";
  if (/^(fact|f_)/i.test(name) || /_fact$/i.test(name) || /sales|orders|transactions|revenue|invoice|shipments?|payments?/i.test(name)) return "Fact";
  // Default unknown tables to Dimension — Fact requires positive evidence
  return "Dimension";
}


function inferType(col: string): string {
  const c = col.toLowerCase();
  if (/date|_dt$/.test(c)) return "Date";
  if (/qty|quantity|count|amount|price|revenue|cost|total|sum/.test(c)) return "Decimal";
  if (/_id$|id$|key$/.test(c)) return "Integer";
  return "String";
}

export function parseSetAnalysisFile(text: string): { name: string; expression: string }[] {
  // Accept CSV (Name,Expression), TSV, or "Name: expression"
  const rows: { name: string; expression: string }[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    if (/^(name|measure)\s*[,\t;]\s*(expression|formula)/i.test(line)) continue; // header
    const csv = line.match(/^\s*"?([^",\t;]+)"?\s*[,\t;]\s*"?(.+?)"?\s*$/);
    if (csv) { rows.push({ name: csv[1].trim(), expression: csv[2].trim() }); continue; }
    const colon = line.match(/^([A-Za-z0-9_\s]+?)\s*[:=]\s*(.+)$/);
    if (colon) rows.push({ name: colon[1].trim(), expression: colon[2].trim() });
  }
  return rows;
}

export function parseVariableLogicFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*"?([A-Za-z0-9_]+)"?\s*[,\t;:=]\s*"?(.+?)"?\s*$/);
    if (m && !/^(name|variable)$/i.test(m[1])) vars[m[1]] = m[2];
  }
  return vars;
}
