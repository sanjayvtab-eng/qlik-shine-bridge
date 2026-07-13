// ============================================================
// QLIK → Power BI Enterprise Analysis Engine
// Ported from qlik2pbi_enterprise_app Python source
// ============================================================

// ──────────────────────────────────────────────────────────────
// SECTION 1: Models
// ──────────────────────────────────────────────────────────────

export interface ProjectFile {
  path: string;
  ext: string;
  size: number;
  isText: boolean;
  content: string;
  note: string;
}

export interface Operation {
  id: string;
  table: string;
  opType: string;
  role: string;
  file: string;
  startLine: number;
  endLine: number;
  raw: string;
  resolvedRaw: string;
  fields: string[];
  calculatedFields: string[];
  fieldExpressions: Record<string, string>;
  sourceRefs: string[];
  resident: string[];
  qvdInputs: string[];
  qvdOutputs: string[];
  inlineColumns: string[];
  inlineRows: string[][];
  where: string;
  groupBy: string[];
  joinTarget: string;
  concatTarget: string;
  applymaps: string[];
  aggregations: string[];
  warnings: string[];
}

export interface TableProfile {
  table: string;
  classification: string;
  status: string;
  confidence: number;
  reason: string;
  fields: string[];
  sourceRefs: string[];
  qvdInputs: string[];
  qvdOutputs: string[];
  dependencies: string[];
  mappingDependencies: string[];
  inlineDependencies: string[];
  droppedIntermediates: string[];
  joinLogic: string[];
  concatLogic: string[];
  filters: string[];
  calculatedColumns: string[];
  lineageIds: string[];
  lineageScript: string;
  flowSteps: Record<string, string | number>[];
  etlStory: string;
  reviewNotes: string[];
}

export interface SourceMap {
  originalRef: string;
  mappedRef: string;
  connectorType: string;
  status: string;
  notes: string;
  table: string;
  sourceRole: string;
  effectiveRef: string;
  qvdProducerTable: string;
  bypassQvd: boolean;
}

export interface DaxMeasure {
  measureName: string;
  dax: string;
  qlikExpression: string;
  table: string;
  confidence: number;
  notes: string;
  source: string;
  warning: string;
}

export interface Relationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  score: number;
  active: boolean;
  status: string;
  reason: string;
  cardinality: string;
  filterDirection: string;
  confidence: number;
}

export interface ValidationIssue {
  severity: string;
  area: string;
  objectName: string;
  message: string;
  recommendation: string;
}

export interface EnterpriseAnalysis {
  inventory: {
    totalFiles: number;
    textFiles: number;
    files: ProjectFile[];
  };
  operations: Operation[];
  variables: Record<string, string>;
  connections: { type: string; connection: string; file: string; line: number }[];
  profiles: Record<string, TableProfile>;
  finalTables: TableProfile[];
  excludedTables: TableProfile[];
  sourceMappings: SourceMap[];
  sourceCatalog: Record<string, string | boolean>[];
  columnTypes: Record<string, Record<string, string>>;
  columnTypeMeta: Record<string, Record<string, { source: string; confidence: number; reason: string; sampleValues: string[] }>>;
  daxMeasures: DaxMeasure[];
  mQueries: Record<string, string>;
  mQueryDiagnostics: Record<string, string>[];
  relationships: Relationship[];
  semanticModel: { name: string; tables: Record<string, unknown>[]; relationships: Record<string, unknown>[] };
  validation: { isReadyForPbipExport: boolean; errorCount: number; warningCount: number; issues: ValidationIssue[]; desktopDiagnostics: Record<string, string>[] };
  migrationReport: string;
  logs: string[];
}

// ──────────────────────────────────────────────────────────────
// SECTION 2: Utilities
// ──────────────────────────────────────────────────────────────

export function cleanName(v: string, fallback = 'Object'): string {
  v = (v || '').trim().replace(/^['"\[\]`]+|['"\[\]`]+$/g, '');
  v = v.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.$#@-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return v || fallback;
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(x => { const s = String(x || '').trim(); if (!s || seen.has(s)) return false; seen.add(s); return true; });
}

export function canonicalRef(ref: string): string {
  let x = (ref || '').trim().replace(/^['"\[\]]+|['"\[\]]+$/g, '');
  x = x.replace(/\\/g, '/').replace(/\/\//g, '/');
  x = x.replace(/\$\([^)]+\)/g, '');
  return x.toLowerCase();
}

export function basenameRef(ref: string): string {
  const c = canonicalRef(ref);
  return c.split('/').pop() || '';
}

// ──────────────────────────────────────────────────────────────
// SECTION 3: Qlik Parser
// ──────────────────────────────────────────────────────────────

const AGG_RE = /\b(Sum|Count|Avg|Min|Max|RangeSum|Aggr)\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi;
const UNSUPPORTED_PATTERNS = [
  'IntervalMatch','CrossTable','Generic Load','Peek','Previous','Exists','Autonumber',
  'Hierarchy','NoOfRows','FieldValue','SubField','Interval','FirstSortedValue'
];

function stripComments(s: string): string {
  // Remove block comments preserving line counts
  s = s.replace(/\/\*.*?\*\//gs, m => '\n'.repeat((m.match(/\n/g) || []).length));
  const lines: string[] = [];
  for (const line of s.split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('//') || t.toUpperCase().startsWith('REM ')) { lines.push(''); continue; }
    let out = '', q: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if ((ch === '"' || ch === "'") && !q) q = ch;
      else if (q === ch) q = null;
      if (!q && ch === '/' && i + 1 < line.length && line[i+1] === '/' && (i === 0 || line[i-1] !== ':')) break;
      out += ch;
    }
    lines.push(out);
  }
  return lines.join('\n');
}

function splitStatements(text: string): [string, number, number][] {
  text = stripComments(text);
  const out: [string, number, number][] = [];
  let cur: string[] = [], line = 1, start: number | null = null, bracketDepth = 0;
  let q: string | null = null;
  for (const ch of text) {
    if (start === null && !ch.trim()) { if (ch === '\n') line++; continue; }
    if (start === null) start = line;
    cur.push(ch);
    if (ch === '\n') { line++; continue; }
    if ((ch === '"' || ch === "'") && !q) q = ch;
    else if (q === ch) q = null;
    if (!q) {
      if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === ';' && bracketDepth === 0) {
        const raw = cur.join('').trim();
        if (raw) out.push([raw, start!, line]);
        cur = []; start = null; q = null; bracketDepth = 0;
      }
    }
  }
  const raw = cur.join('').trim();
  if (raw) out.push([raw, start ?? line, line]);
  return out;
}

function splitCsvTop(s: string): string[] {
  const out: string[] = []; let cur: string[] = [], depth = 0; let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ((ch === '"' || ch === "'") && !q) q = ch;
    else if (q === ch) q = null;
    else if (!q) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) { out.push(cur.join('').trim()); cur = []; continue; }
    }
    cur.push(ch);
  }
  if (cur.length) out.push(cur.join('').trim());
  return out.filter(x => x);
}

function cleanVarValue(v: string): string {
  v = (v || '').trim().replace(/;+$/, '').trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
  return v;
}

function resolveVariables(text: string, variables: Record<string, string>): string {
  let prev: string | null = null, out = text;
  for (let i = 0; i < 5; i++) {
    if (out === prev) break;
    prev = out;
    out = out.replace(/\$\(\s*([^)]+?)\s*\)/g, (m, key) => {
      const k = cleanName(key);
      return cleanVarValue(variables[k] ?? m);
    });
  }
  return out;
}

function unqRef(x: string): string {
  x = (x || '').trim().replace(/;+$/, '').trim();
  if ((x.startsWith('[') && x.endsWith(']')) || (x.startsWith('"') && x.endsWith('"')) || (x.startsWith("'") && x.endsWith("'")))
    return x.slice(1, -1);
  return x;
}

function parseFields(body: string): [string[], string[], Record<string, string>] {
  const m = body.trim().match(/^(LOAD|SELECT)\s+(.*)/is);
  if (!m) return [[], [], {}];
  const rest = m[2];
  const b = rest.search(/\b(FROM|RESIDENT|INLINE|WHERE|GROUP\s+BY|ORDER\s+BY)\b/i);
  const txt = b >= 0 ? rest.slice(0, b).trim() : rest.trim();
  if (txt === '*') return [['*'], [], { '*': '*' }];
  const fields: string[] = [], calcs: string[] = [], exprs: Record<string, string> = {};
  for (const x of splitCsvTop(txt)) {
    const am = x.match(/(.+?)\s+AS\s+(.+)$/is);
    const expr = am ? am[1].trim() : x.trim();
    const alias = cleanName(am ? am[2] : expr);
    fields.push(alias); exprs[alias] = expr;
    if (/[()+*/]|\b(if|date|num|text|ApplyMap|pick|match|wildmatch|year|month|floor|ceil|round)\b/i.test(expr) || alias !== cleanName(expr)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.$#@-]*$/.test(expr)) calcs.push(alias);
    }
  }
  return [uniq(fields), uniq(calcs), exprs];
}

function parseInline(body: string): [string[], string[][]] {
  const m = body.match(/\bINLINE\s*\[(.*?)\]/is);
  if (!m) return [[], []];
  const lines = m[1].trim().split('\n').map(l => l.trim()).filter(l => l);
  if (!lines.length) return [[], []];
  const rows = lines.map(l => l.split(',').map(c => c.trim()));
  return [rows[0].map(c => cleanName(c)), rows.slice(1)];
}

function parseClause(body: string, clause: string, ends: string[]): string {
  const pattern = new RegExp('\\b' + clause.replace(' ', '\\s+') + '\\b\\s+(.*)$', 'is');
  const m = body.match(pattern);
  if (!m) return '';
  let t = m[1].trim();
  const stops: number[] = [];
  for (const e of ends) {
    const em = new RegExp('\\b' + e.replace(' ', '\\s+') + '\\b', 'i');
    const mm = t.match(em);
    if (mm?.index !== undefined) stops.push(mm.index);
  }
  return stops.length ? t.slice(0, Math.min(...stops)).trim() : t;
}

function parseLoad(raw: string, resolved: string, file: string, start: number, end: number, idx: number): Operation | null {
  let text = resolved.replace(/;+$/, '').trim(), original = raw.replace(/;+$/, '').trim();
  let table = '', body = text;
  const lm = text.match(/^\s*([A-Za-z0-9_.$#@ -]+?)\s*:\s*(.*)/s);
  if (lm) { table = cleanName(lm[1]); body = lm[2].trim(); }
  const prefixes: string[] = [];
  let joinTarget = '', concatTarget = '';
  while (true) {
    let m: RegExpMatchArray | null;
    m = body.match(/^(MAPPING|NOCONCATENATE)\s+(.*)/is);
    if (m) { prefixes.push(m[1].toUpperCase()); body = m[2].trim(); continue; }
    m = body.match(/^((?:LEFT|RIGHT|INNER|OUTER)\s+)?JOIN\s*(?:\(([^)]+)\))?\s*(.*)/is);
    if (m) {
      prefixes.push(((m[1] || '') + 'JOIN').trim().toUpperCase());
      joinTarget = cleanName(m[2] || ''); body = m[3].trim(); continue;
    }
    m = body.match(/^CONCATENATE\s*(?:\(([^)]+)\))?\s*(.*)/is);
    if (m) { prefixes.push('CONCATENATE'); concatTarget = cleanName(m[1] || ''); body = m[2].trim(); continue; }
    break;
  }
  if (!/^(LOAD|SELECT)\b/i.test(body)) return null;
  if (!table) table = joinTarget ? `JoinPayload_${String(idx).padStart(5,'0')}` : concatTarget ? `ConcatenatePayload_${String(idx).padStart(5,'0')}` : `Anonymous_${String(idx).padStart(5,'0')}`;
  let role = 'load', opType = 'load';
  if (prefixes.some(p => p.includes('MAPPING'))) { role = 'mapping'; opType = 'mapping_load'; }
  else if (prefixes.some(p => p.includes('JOIN'))) { role = 'join_payload'; opType = 'join_load'; }
  else if (prefixes.includes('CONCATENATE')) { role = 'concat_payload'; opType = 'concat_load'; }
  const [fields, calcs, exprs] = parseFields(body);
  const sources = Array.from(body.matchAll(/\bFROM\s+(\[[^\]]+\]|"[^"]+"|'[^']+'|[^\s;]+)/gi)).map(m => unqRef(m[1]));
  const resident = Array.from(body.matchAll(/\bRESIDENT\s+(\[[^\]]+\]|"[^"]+"|'[^']+'|[A-Za-z0-9_.$#@-]+)/gi)).map(m => cleanName(unqRef(m[1])));
  const qvds = sources.filter(s => s.toLowerCase().endsWith('.qvd'));
  const [inlineCols, inlineRows] = parseInline(body);
  if (inlineCols.length) role = 'inline_static';
  const where = parseClause(body, 'WHERE', ['GROUP BY', 'ORDER BY']);
  const g = parseClause(body, 'GROUP BY', ['ORDER BY']);
  const groupBy = g ? splitCsvTop(g) : [];
  const aggs: string[] = [];
  AGG_RE.lastIndex = 0;
  let am: RegExpExecArray | null;
  while ((am = AGG_RE.exec(body)) !== null) aggs.push(am[0]);
  const apps = Array.from(body.matchAll(/ApplyMap\s*\(\s*["']?([^,"']+)/gi)).map(m => cleanName(m[1]));
  const warns: string[] = [];
  for (const pat of UNSUPPORTED_PATTERNS) {
    if (new RegExp('\\b' + pat + '\\b', 'i').test(body)) warns.push(`${pat} requires manual review`);
  }
  return {
    id: `OP${String(idx).padStart(5,'0')}`, table: cleanName(table), opType, role, file,
    startLine: start, endLine: end, raw, resolvedRaw: resolved,
    fields, calculatedFields: calcs, fieldExpressions: exprs,
    sourceRefs: sources, resident, qvdInputs: qvds, qvdOutputs: [],
    inlineColumns: inlineCols, inlineRows, where, groupBy,
    joinTarget, concatTarget, applymaps: apps, aggregations: uniq(aggs), warnings: warns,
  };
}

export function parseProject(files: ProjectFile[]): { operations: Operation[]; variables: Record<string, string>; connections: { type: string; connection: string; file: string; line: number }[] } {
  const statements: [ProjectFile, string, number, number][] = [];
  const variables: Record<string, string> = {};
  const connections: { type: string; connection: string; file: string; line: number }[] = [];
  for (const pf of files) {
    if (!pf.isText) continue;
    for (const [raw, start, end] of splitStatements(pf.content)) {
      const norm = raw.replace(/;+$/, '').trim().replace(/\s+/g, ' ');
      const vm = norm.match(/^(SET|LET)\s+([^=]+?)\s*=\s*(.*)$/i);
      if (vm) { variables[cleanName(vm[2])] = cleanVarValue(vm[3]); continue; }
      statements.push([pf, raw, start, end]);
    }
  }
  const operations: Operation[] = [];
  let count = 0;
  for (const [pf, raw, start, end] of statements) {
    const resolved = resolveVariables(raw, variables);
    const norm = resolved.replace(/;+$/, '').trim().replace(/\s+/g, ' ');
    const cm = norm.match(/^(ODBC|OLEDB|LIB|CUSTOM)\s+CONNECT(?:\s+TO)?\s+(.*)/i);
    if (cm) { connections.push({ type: cm[1].toUpperCase(), connection: cm[2], file: pf.path, line: start }); continue; }
    const dm = norm.match(/^DROP\s+TABLES?\s+(.+)/i);
    if (dm) {
      for (const t of dm[1].split(/,|\s+/)) {
        const tn = t.trim().replace(/;+$/, '');
        if (tn) { count++; operations.push({ id: `OP${String(count).padStart(5,'0')}`, table: cleanName(tn), opType: 'drop', role: 'dropped', file: pf.path, startLine: start, endLine: end, raw, resolvedRaw: resolved, fields: [], calculatedFields: [], fieldExpressions: {}, sourceRefs: [], resident: [], qvdInputs: [], qvdOutputs: [], inlineColumns: [], inlineRows: [], where: '', groupBy: [], joinTarget: '', concatTarget: '', applymaps: [], aggregations: [], warnings: [] }); }
      }
      continue;
    }
    const sm = norm.match(/^STORE\s+(.+?)\s+INTO\s+(.*?)(?:\s*\(.*?\))?$/i);
    if (sm) {
      count++;
      operations.push({ id: `OP${String(count).padStart(5,'0')}`, table: cleanName(sm[1]), opType: 'store_qvd', role: 'qvd_output', file: pf.path, startLine: start, endLine: end, raw, resolvedRaw: resolved, fields: [], calculatedFields: [], fieldExpressions: {}, sourceRefs: [], resident: [], qvdInputs: [], qvdOutputs: [unqRef(sm[2])], inlineColumns: [], inlineRows: [], where: '', groupBy: [], joinTarget: '', concatTarget: '', applymaps: [], aggregations: [], warnings: [] });
      continue;
    }
    const op = parseLoad(raw, resolved, pf.path, start, end, count + 1);
    if (op) { count++; operations.push(op); }
  }
  return { operations, variables, connections };
}

// ──────────────────────────────────────────────────────────────
// SECTION 4: Final Table Detector
// ──────────────────────────────────────────────────────────────

const STAGE_RE = /(^tmp|^temp|^stg|^stage|_tmp$|_stg$|working|_raw$|^raw_|intermediate|scratch|work_)/i;
const METRIC_TABLE_RE = /(metric|kpi|summary|aggregate|agg|measure)/i;

function qvdProducer(q: string, qvdProducerMap: Map<string, string>, qvdProducerByName: Map<string, string>): string {
  return qvdProducerMap.get(canonicalRef(q)) || qvdProducerByName.get(basenameRef(q)) || '';
}

function classifyTable(t: string, ops: Operation[], load: Operation[], dropped: Set<string>, qvdOut: Map<string, string[]>, referencedBy: Map<string, string[]>, joins: Map<string, Operation[]>, concats: Map<string, Operation[]>): [string, string, number, string] {
  if (dropped.has(t)) return ['dropped', 'excluded', 99, 'Table is explicitly dropped in Qlik script; retained only for lineage.'];
  if (load.some(o => o.opType === 'mapping_load')) return ['mapping', 'excluded', 98, 'MAPPING LOAD helper table used by ApplyMap; not exported as a Power BI table.'];
  if (load.some(o => o.opType === 'join_load') || t.startsWith('JoinPayload_')) return ['join payload', 'excluded', 96, 'JOIN payload is merged into its target table lineage and is not a standalone model table.'];
  if (load.some(o => o.opType === 'concat_load') || t.startsWith('ConcatenatePayload_')) return ['concatenate payload', 'excluded', 96, 'CONCATENATE payload is merged into its target table lineage and is not a standalone model table.'];
  const isAgg = load.some(o => (o.groupBy.length || METRIC_TABLE_RE.test(t)) && o.resident.length && o.aggregations.length);
  if (isAgg) return ['aggregated metric table', 'excluded', 91, 'Aggregated resident logic detected; converted to DAX measures by default instead of materializing as M.'];
  const hasStore = (qvdOut.get(t) || []).length > 0;
  const usedByOther = (referencedBy.get(t) || []).some(x => x !== t);
  const hasLoad = load.some(o => o.opType === 'load');
  const hasJoinInto = (joins.get(t) || []).length > 0;
  const hasConcatInto = (concats.get(t) || []).length > 0;
  const inline = load.some(o => o.inlineColumns.length > 0);
  if (hasStore && (usedByOther || load.some(o => o.sourceRefs.length)) && !hasJoinInto && !hasConcatInto) return ['qvd-generator-only', 'excluded', 90, 'Table is used to create QVD/source staging output; it is retained in lineage but excluded from final Power BI model.'];
  if (inline) return ['inline/static', 'generated', 89, 'INLINE/static table parsed as a safe Power BI static table.'];
  if (STAGE_RE.test(t) && (usedByOther || hasStore)) return ['temporary/staging', 'excluded', 88, 'Generic staging/raw pattern plus dependency/store evidence; retained in lineage only.'];
  if (STAGE_RE.test(t)) return ['temporary/staging', 'manual review', 65, 'Generic staging/raw name pattern detected, but no downstream usage was found; review whether this should be final.'];
  if (hasLoad || hasJoinInto || hasConcatInto) return ['final data model', 'generated', 88, 'Surviving Qlik data-model table after helper, staging, qvd-generator, join/concat payload, and dropped tables are excluded.'];
  return ['unsupported/manual-review', 'manual review', 50, 'Insufficient evidence to classify dynamically; requires review.'];
}

function buildLineage(table: string, operations: Operation[], by: Map<string, Operation[]>, joins: Map<string, Operation[]>, concats: Map<string, Operation[]>, qvdProducerMap: Map<string, string>, qvdProducerByName: Map<string, string>, visited: Set<string>): Operation[] {
  if (visited.has(table)) return [];
  visited.add(table);
  const out: Operation[] = [];
  const current = [...(by.get(table) || []), ...(joins.get(table) || []), ...(concats.get(table) || [])];
  for (const o of current) {
    out.push(o);
    const deps = [...o.resident, ...o.applymaps];
    for (const q of o.qvdInputs) { const prod = qvdProducer(q, qvdProducerMap, qvdProducerByName); if (prod) deps.push(prod); }
    for (const d of deps) { if (d && d !== table) out.push(...buildLineage(d, operations, by, joins, concats, qvdProducerMap, qvdProducerByName, visited)); }
  }
  const order = new Map(operations.map((o, i) => [o.id, i]));
  const seen = new Set<string>(); const res: Operation[] = [];
  for (const o of [...out].sort((a, b) => (order.get(a.id) ?? 999999) - (order.get(b.id) ?? 999999))) {
    if (!seen.has(o.id)) { seen.add(o.id); res.push(o); }
  }
  return res;
}

function buildFlowSteps(lineageOps: Operation[]): Record<string, string | number>[] {
  return lineageOps.map((o, i) => {
    let action = o.opType;
    if (o.opType === 'load') action = o.sourceRefs.length ? 'Source extraction' : o.resident.length ? 'Resident transformation' : o.inlineColumns.length ? 'Inline/static load' : 'LOAD transformation';
    else if (o.opType === 'mapping_load') action = 'Mapping load / ApplyMap lookup';
    else if (o.opType === 'join_load') action = `Join payload into ${o.joinTarget}`;
    else if (o.opType === 'concat_load') action = `Concatenate payload into ${o.concatTarget}`;
    else if (o.opType === 'store_qvd') action = 'Store QVD output';
    else if (o.opType === 'drop') action = 'Drop intermediate table';
    return { Seq: i+1, Operation: o.id, Table: o.table, Action: action, Role: o.role, 'Source Files': o.sourceRefs.join(', '), 'Resident Inputs': o.resident.join(', '), 'Join Target': o.joinTarget, 'Concat Target': o.concatTarget, 'QVD Inputs': o.qvdInputs.join(', '), 'QVD Outputs': o.qvdOutputs.join(', '), Where: o.where, 'Group By': o.groupBy.join(', '), Fields: (o.inlineColumns.length ? o.inlineColumns : o.fields).join(', '), 'Calculated Columns': o.calculatedFields.join(', '), ApplyMap: o.applymaps.join(', '), File: o.file, Lines: `${o.startLine}-${o.endLine}` };
  });
}

function buildEtlStory(table: string, profile: TableProfile, lineageOps: Operation[]): string {
  const lines = [`${table} is classified as ${profile.classification} with confidence ${profile.confidence}.`];
  for (const o of lineageOps) {
    if (o.opType === 'load' && o.sourceRefs.length) lines.push(`${o.table} reads source ${o.sourceRefs.join(', ')}.`);
    if (o.opType === 'store_qvd') lines.push(`${o.table} is stored to QVD ${o.qvdOutputs.join(', ')}.`);
    if (o.opType === 'load' && o.qvdInputs.length) lines.push(`${o.table} reads QVD ${o.qvdInputs.join(', ')}.`);
    if (o.opType === 'load' && o.resident.length) {
      let msg = `${o.table} is built from resident table ${o.resident.join(', ')}`;
      if (o.where) msg += ` with filter ${o.where}`;
      lines.push(msg + '.');
    }
    if (o.opType === 'join_load') lines.push(`${o.joinTarget} receives a JOIN from ${(o.resident.length ? o.resident : o.sourceRefs).join(', ') || 'inline/source load'} using fields ${o.fields.join(', ')}.`);
    if (o.opType === 'concat_load') lines.push(`${o.concatTarget} receives CONCATENATE payload from ${(o.resident.length ? o.resident : o.sourceRefs).join(', ') || 'inline/source load'}.`);
    if (o.opType === 'drop') lines.push(`Intermediate table ${o.table} is dropped and excluded from the Power BI final model.`);
  }
  if (profile.mappingDependencies.length) lines.push(`Mapping dependencies detected: ${profile.mappingDependencies.join(', ')}.`);
  if (profile.reviewNotes.length) lines.push(`Manual review notes: ${profile.reviewNotes.join('; ')}`);
  return lines.join(' ');
}

export function detectTables(operations: Operation[]): Record<string, TableProfile> {
  const by = new Map<string, Operation[]>();
  for (const o of operations) { if (!by.has(o.table)) by.set(o.table, []); by.get(o.table)!.push(o); }
  const dropped = new Set(operations.filter(o => o.opType === 'drop').map(o => o.table));
  const qvdOut = new Map<string, string[]>();
  const qvdProducerMap = new Map<string, string>();
  const qvdProducerByName = new Map<string, string>();
  for (const o of operations) {
    if (o.opType === 'store_qvd') {
      if (!qvdOut.has(o.table)) qvdOut.set(o.table, []);
      for (const q of o.qvdOutputs) { qvdOut.get(o.table)!.push(q); qvdProducerMap.set(canonicalRef(q), o.table); qvdProducerByName.set(basenameRef(q), o.table); }
    }
  }
  const joins = new Map<string, Operation[]>();
  const concats = new Map<string, Operation[]>();
  for (const o of operations) {
    if (o.opType === 'join_load' && o.joinTarget) { if (!joins.has(o.joinTarget)) joins.set(o.joinTarget, []); joins.get(o.joinTarget)!.push(o); }
    if (o.opType === 'concat_load' && o.concatTarget) { if (!concats.has(o.concatTarget)) concats.set(o.concatTarget, []); concats.get(o.concatTarget)!.push(o); }
  }
  const referencedBy = new Map<string, string[]>();
  const dependenciesOf = new Map<string, string[]>();
  for (const o of operations) {
    const deps = [...o.resident, ...o.applymaps];
    for (const q of o.qvdInputs) { const prod = qvdProducer(q, qvdProducerMap, qvdProducerByName); if (prod) deps.push(prod); }
    for (const d of deps) {
      if (!d) continue;
      if (!referencedBy.has(d)) referencedBy.set(d, []);
      referencedBy.get(d)!.push(o.table);
      if (!dependenciesOf.has(o.table)) dependenciesOf.set(o.table, []);
      dependenciesOf.get(o.table)!.push(d);
    }
    if (o.joinTarget) { if (!referencedBy.has(o.table)) referencedBy.set(o.table, []); referencedBy.get(o.table)!.push(o.joinTarget); if (!dependenciesOf.has(o.joinTarget)) dependenciesOf.set(o.joinTarget, []); dependenciesOf.get(o.joinTarget)!.push(o.table); }
    if (o.concatTarget) { if (!referencedBy.has(o.table)) referencedBy.set(o.table, []); referencedBy.get(o.table)!.push(o.concatTarget); if (!dependenciesOf.has(o.concatTarget)) dependenciesOf.set(o.concatTarget, []); dependenciesOf.get(o.concatTarget)!.push(o.table); }
  }
  const profiles: Record<string, TableProfile> = {};
  for (const [t, ops] of by) {
    const load = ops.filter(o => ['load','mapping_load','join_load','concat_load'].includes(o.opType));
    const fields = uniq(ops.flatMap(o => (o.inlineColumns.length ? o.inlineColumns : o.fields).filter(f => f !== '*')));
    const src = uniq(ops.flatMap(o => o.sourceRefs));
    const qvdi = uniq(ops.flatMap(o => o.qvdInputs));
    const deps = uniq((dependenciesOf.get(t) || []).filter(d => d && d !== t));
    const [cls, status, conf, reason] = classifyTable(t, ops, load, dropped, qvdOut, referencedBy, joins, concats);
    profiles[t] = { table: t, classification: cls, status, confidence: conf, reason, fields, sourceRefs: src, qvdInputs: qvdi, qvdOutputs: uniq(qvdOut.get(t) || []), dependencies: deps, mappingDependencies: [], inlineDependencies: [], droppedIntermediates: [], joinLogic: [], concatLogic: [], filters: uniq(ops.map(o => o.where).filter(Boolean)), calculatedColumns: uniq(ops.flatMap(o => o.calculatedFields)), lineageIds: [], lineageScript: '', flowSteps: [], etlStory: '', reviewNotes: uniq(ops.flatMap(o => o.warnings)) };
  }
  for (const [t, p] of Object.entries(profiles)) {
    if (p.status === 'generated') {
      const visited = new Set<string>();
      const lin = buildLineage(t, operations, by, joins, concats, qvdProducerMap, qvdProducerByName, visited);
      p.lineageIds = lin.map(o => o.id);
      p.lineageScript = lin.map(o => `// ${o.file} | lines ${o.startLine}-${o.endLine} | ${o.opType} | ${o.table}\n${o.raw.trim()}`).join('\n\n');
      p.fields = uniq(lin.flatMap(o => (o.inlineColumns.length ? o.inlineColumns : o.fields).filter(f => f !== '*')));
      p.sourceRefs = uniq(lin.flatMap(o => o.sourceRefs));
      p.qvdInputs = uniq(lin.flatMap(o => o.qvdInputs));
      p.qvdOutputs = uniq(lin.flatMap(o => o.qvdOutputs));
      p.dependencies = uniq(lin.flatMap(o => [...o.resident, ...o.applymaps, o.joinTarget, o.concatTarget].filter(d => d && d !== t)));
      p.mappingDependencies = uniq([...lin.filter(o => o.opType === 'mapping_load').map(o => o.table), ...lin.flatMap(o => o.applymaps)]);
      p.inlineDependencies = uniq(lin.filter(o => o.inlineColumns.length && o.table !== t).map(o => o.table));
      p.droppedIntermediates = [...visited].filter(x => dropped.has(x) && x !== t).sort();
      p.joinLogic = uniq(lin.filter(o => o.opType === 'join_load').map(o => o.raw));
      p.concatLogic = uniq(lin.filter(o => o.opType === 'concat_load').map(o => o.raw));
      p.filters = uniq(lin.map(o => o.where).filter(Boolean));
      p.calculatedColumns = uniq(lin.flatMap(o => o.calculatedFields));
      p.reviewNotes = uniq([...p.reviewNotes, ...lin.flatMap(o => o.warnings)]);
      p.flowSteps = buildFlowSteps(lin);
      p.etlStory = buildEtlStory(t, p, lin);
    }
  }
  return profiles;
}

// ──────────────────────────────────────────────────────────────
// SECTION 5: Source Connector
// ──────────────────────────────────────────────────────────────

export function connector(path: string): string {
  const p = (path || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const noQuery = p.split('?')[0];
  if (p.startsWith('odbc') || p.startsWith('oledb') || p.startsWith('sql:') || p.startsWith('server=') || p.startsWith('database=') || p.includes('dsn=')) return 'Database/SQL';
  if (/^[a-z]+:\/\//.test(p) && !p.startsWith('lib://')) {
    if (noQuery.endsWith('.csv') || noQuery.endsWith('.txt') || noQuery.endsWith('.tsv') || noQuery.endsWith('.dat')) return 'CSV/Text';
    if (noQuery.endsWith('.xlsx') || noQuery.endsWith('.xls') || noQuery.endsWith('.xlsm')) return 'Excel';
    if (noQuery.endsWith('.parquet')) return 'Parquet';
    if (noQuery.endsWith('.json')) return 'JSON';
    if (noQuery.endsWith('.xml')) return 'XML';
    return 'Web/API';
  }
  if (p.includes('$(') || p.startsWith('lib://')) {
    if (noQuery.endsWith('.csv') || noQuery.endsWith('.txt') || noQuery.endsWith('.tsv') || noQuery.endsWith('.dat')) return 'CSV/Text';
    if (noQuery.endsWith('.xlsx') || noQuery.endsWith('.xls') || noQuery.endsWith('.xlsm')) return 'Excel';
    if (noQuery.endsWith('.parquet')) return 'Parquet';
    if (noQuery.endsWith('.json')) return 'JSON';
    if (noQuery.endsWith('.xml')) return 'XML';
    if (noQuery.endsWith('.qvd')) return 'QVD - map to supported source';
    return 'Unknown';
  }
  if (noQuery.endsWith('.csv') || noQuery.endsWith('.txt') || noQuery.endsWith('.tsv') || noQuery.endsWith('.dat')) return 'CSV/Text';
  if (noQuery.endsWith('.xlsx') || noQuery.endsWith('.xls') || noQuery.endsWith('.xlsm')) return 'Excel';
  if (noQuery.endsWith('.parquet')) return 'Parquet';
  if (noQuery.endsWith('.json')) return 'JSON';
  if (noQuery.endsWith('.xml')) return 'XML';
  if (noQuery.endsWith('.qvd')) return 'QVD - map to supported source';
  if (p.endsWith('/') || p.endsWith('\\')) return 'Folder';
  if (/^[a-zA-Z_][\w$#@-]*(\.[a-zA-Z_][\w$#@-]*){1,3}$/.test((path || '').trim())) return 'Database/SQL';
  return 'Unknown';
}

// ──────────────────────────────────────────────────────────────
// SECTION 6: Source Mappings
// ──────────────────────────────────────────────────────────────

function isQvd(ref: string): boolean { return (ref || '').toLowerCase().endsWith('.qvd'); }

function primaryLoad(ops: Operation[]): Operation | null {
  const loads = ops.filter(o => ['load','mapping_load'].includes(o.opType));
  if (!loads.length) return null;
  const regular = loads.filter(o => o.opType === 'load');
  return regular.length ? regular[regular.length-1] : loads[loads.length-1];
}

class QvdLineageResolver {
  private producerOpByQvd = new Map<string, Operation>();
  private producerTableByQvd = new Map<string, string>();
  private by: Map<string, Operation[]>;
  constructor(private operations: Operation[]) {
    this.by = new Map();
    for (const o of operations) { if (!this.by.has(o.table)) this.by.set(o.table, []); this.by.get(o.table)!.push(o); }
    this._build();
  }
  private _build() {
    const lastLoad: Record<string, Operation> = {};
    for (const o of this.operations) {
      if (['load','mapping_load'].includes(o.opType)) lastLoad[o.table] = o;
      else if (o.opType === 'store_qvd') {
        const prod = lastLoad[o.table];
        for (const q of o.qvdOutputs) {
          for (const key of [canonicalRef(q), basenameRef(q)]) {
            if (!key) continue;
            if (prod) this.producerOpByQvd.set(key, prod);
            this.producerTableByQvd.set(key, o.table);
          }
        }
      }
    }
  }
  producerOp(qvdRef: string): Operation | null { return this.producerOpByQvd.get(canonicalRef(qvdRef)) || this.producerOpByQvd.get(basenameRef(qvdRef)) || null; }
  producerTable(qvdRef: string): string { return this.producerTableByQvd.get(canonicalRef(qvdRef)) || this.producerTableByQvd.get(basenameRef(qvdRef)) || ''; }
  upstreamSources(qvdRef: string): string[] {
    const op = this.producerOp(qvdRef);
    return op ? this._sourcesForOp(op, new Set()) : [];
  }
  private _sourcesForTable(table: string, visited: Set<string>): string[] {
    if (visited.has(table)) return [];
    visited.add(table);
    const op = primaryLoad(this.by.get(table) || []);
    return op ? this._sourcesForOp(op, visited) : [];
  }
  private _sourcesForOp(op: Operation, visited: Set<string>): string[] {
    const refs: string[] = [];
    for (const src of op.sourceRefs) {
      if (isQvd(src)) { const prod = this.producerOp(src); if (prod) { refs.push(...this._sourcesForOp(prod, visited)); } else { refs.push(src); } }
      else { refs.push(src); }
    }
    for (const r of op.resident) refs.push(...this._sourcesForTable(r, visited));
    return uniq(refs);
  }
}

function physicalStatus(ref: string, mapped: string, ct: string, explicitStatus = ''): string {
  const rawRef = (ref || '').trim();
  mapped = (mapped || rawRef).trim();
  ct = ct || connector(mapped || rawRef);
  const stillQlikLogical = mapped === rawRef && (mapped.includes('$(') || mapped.toLowerCase().startsWith('lib://'));
  const unsupported = ['Unknown','QVD - map to supported source'].includes(ct);
  const dbIncomplete = ct === 'Database/SQL' && !(mapped.toLowerCase().includes('server=') && mapped.toLowerCase().includes('database='));
  if (explicitStatus && explicitStatus !== 'Needs review' && !dbIncomplete) return explicitStatus;
  if (mapped && mapped !== rawRef && !unsupported && !mapped.toLowerCase().endsWith('.qvd') && !dbIncomplete) return 'Mapped';
  return (unsupported || stillQlikLogical || dbIncomplete) ? 'Needs review' : 'Mapped';
}

export function buildSourceMappings(operations: Operation[], updates: Record<string, { mappedRef?: string; connectorType?: string; status?: string; notes?: string }> = {}): SourceMap[] {
  const resolver = new QvdLineageResolver(operations);
  const rows: SourceMap[] = [];
  const seen = new Set<string>();

  function getUpdate(ref: string) {
    return updates[ref] || updates[canonicalRef(ref)] || updates[basenameRef(ref)] || {};
  }

  function add(ref: string, table = '', role = 'physical source', effectiveRef?: string, producerTable = '', bypass = false, notes = '') {
    if (!ref) return;
    const key = `${ref}||${table}||${role}`;
    if (seen.has(key)) return;
    seen.add(key);
    const u = getUpdate(ref);
    if (bypass) {
      const upstream = effectiveRef || resolver.upstreamSources(ref).join('; ');
      rows.push({ originalRef: ref, mappedRef: u.mappedRef || upstream || ref, connectorType: u.connectorType || 'QVD bypassed via lineage', status: u.status || 'Bypassed', notes: u.notes || notes || 'QVD is not loaded directly. Power Query rebuilds this step from the producer table and original source lineage.', table, sourceRole: role, effectiveRef: upstream || ref, qvdProducerTable: producerTable, bypassQvd: true });
      return;
    }
    const mapped = (u.mappedRef || effectiveRef || ref).trim();
    let ct = u.connectorType || connector(mapped) || connector(ref);
    if (['Unknown','QVD - map to supported source'].includes(ct) && mapped && mapped !== ref) ct = connector(mapped);
    const status = physicalStatus(ref, mapped, ct, u.status || '');
    rows.push({ originalRef: ref, mappedRef: mapped, connectorType: ct, status, notes: u.notes || notes, table, sourceRole: role, effectiveRef: mapped, qvdProducerTable: producerTable, bypassQvd: false });
  }

  for (const o of operations) {
    for (const src of o.sourceRefs) {
      if (isQvd(src)) {
        const prodTable = resolver.producerTable(src);
        const upstream = resolver.upstreamSources(src);
        if (prodTable && upstream.length) {
          add(src, o.table, 'qvd bypass / intermediate handoff', upstream.join('; '), prodTable, true);
          for (const uref of upstream) add(uref, prodTable, 'original source for bypassed QVD', uref, prodTable, false);
        } else {
          add(src, o.table, 'unresolved qvd source', src, '', false, 'No STORE producer found in uploaded scripts. Map this QVD to CSV/Excel/Parquet/SQL or upload the generator script.');
        }
      } else {
        add(src, o.table, 'direct source', src);
      }
    }
    for (const qvd of o.qvdInputs) {
      const prodTable = resolver.producerTable(qvd);
      const upstream = resolver.upstreamSources(qvd);
      if (prodTable && upstream.length) {
        add(qvd, o.table, 'qvd bypass / intermediate handoff', upstream.join('; '), prodTable, true);
      } else if (!o.sourceRefs.includes(qvd)) {
        add(qvd, o.table, 'unresolved qvd source', qvd, '', false, 'No STORE producer found in uploaded scripts. Map this QVD to CSV/Excel/Parquet/SQL or upload the generator script.');
      }
    }
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────
// SECTION 7: Data Types
// ──────────────────────────────────────────────────────────────

export const TYPE_OPTIONS = ['Text','Whole Number','Decimal Number','Currency / Fixed Decimal','Date','Date/Time','True/False','Any'];

const M_TYPE: Record<string, string> = { 'Text': 'type text', 'Whole Number': 'Int64.Type', 'Decimal Number': 'type number', 'Currency / Fixed Decimal': 'Currency.Type', 'Date': 'type date', 'Date/Time': 'type datetime', 'True/False': 'type logical', 'Any': 'type any' };
const BIM_TYPE: Record<string, string> = { 'Text': 'string', 'Whole Number': 'int64', 'Decimal Number': 'double', 'Currency / Fixed Decimal': 'decimal', 'Date': 'dateTime', 'Date/Time': 'dateTime', 'True/False': 'boolean', 'Any': 'string' };
const FORMAT_STRING: Record<string, string> = { 'Date': 'Short Date', 'Date/Time': 'General Date', 'Currency / Fixed Decimal': '#,0.00' };

function normalizeType(value: string): string {
  const v = (value || '').trim().toLowerCase();
  const aliases: Record<string, string> = { 'string': 'Text', 'text': 'Text', 'int': 'Whole Number', 'integer': 'Whole Number', 'int64': 'Whole Number', 'whole number': 'Whole Number', 'number': 'Decimal Number', 'decimal': 'Decimal Number', 'double': 'Decimal Number', 'currency': 'Currency / Fixed Decimal', 'fixed decimal': 'Currency / Fixed Decimal', 'date': 'Date', 'datetime': 'Date/Time', 'date/time': 'Date/Time', 'bool': 'True/False', 'boolean': 'True/False', 'logical': 'True/False', 'any': 'Any' };
  return aliases[v] || (TYPE_OPTIONS.includes(value) ? value : 'Text');
}

function mType(dtype: string): string { return M_TYPE[normalizeType(dtype)] || 'type text'; }
function bimType(dtype: string): string { return BIM_TYPE[normalizeType(dtype)] || 'string'; }
function formatString(dtype: string): string { return FORMAT_STRING[normalizeType(dtype)] || ''; }

function inferDataType(columnName: string, expression = ''): string {
  const name = cleanName(columnName).toLowerCase();
  const expr = (expression || '').toLowerCase();
  if (/(name|type|code|category|subcategory|brand|segment|band|status|city|country|region|currency|description|desc|address|email|phone)$/.test(name)) return 'Text';
  if (name === 'year' || name === 'month' || name === 'quarter' || name === 'week' || /(year|month|quarter|week)$/.test(name)) return 'Whole Number';
  if (/(date|dt$|datetime|timestamp|created|modified|shipdate|orderdate|hiredate)/.test(name) || expr.includes('date#') || expr.includes('date(')) {
    return /(time|timestamp|datetime)/.test(name) ? 'Date/Time' : 'Date';
  }
  if (/(qty|quantity|count|orders|units|age|days|hours|minutes|seq|index)$/.test(name)) return 'Whole Number';
  if (/(amount|sales|cost|profit|margin|discount|price|rate|ratio|percent|pct|latitude|longitude|usd|value|total|balance|revenue|salary)/.test(name)) return 'Decimal Number';
  if (/(^is_|^has_|flag$|active$|enabled$|valid$)/.test(name)) return 'True/False';
  return 'Text';
}

export function buildColumnTypes(profiles: Record<string, TableProfile>, operations: Operation[], updates: Record<string, string> = {}): [Record<string, Record<string, string>>, Record<string, Record<string, { source: string; confidence: number; reason: string; sampleValues: string[] }>>] {
  const exprByTableCol: Record<string, string> = {};
  for (const op of operations) {
    for (const [col, expr] of Object.entries(op.fieldExpressions || {})) {
      exprByTableCol[`${op.table}|${col}`] = expr;
    }
  }
  const result: Record<string, Record<string, string>> = {};
  const meta: Record<string, Record<string, { source: string; confidence: number; reason: string; sampleValues: string[] }>> = {};
  for (const [table, profile] of Object.entries(profiles)) {
    if (profile.status !== 'generated') continue;
    result[table] = {}; meta[table] = {};
    for (const col of profile.fields) {
      const key = `${table}.${col}`;
      if (updates[key]) {
        result[table][col] = normalizeType(updates[key]);
        meta[table][col] = { source: 'User override', confidence: 100, reason: 'Selected by user.', sampleValues: [] };
      } else {
        const dtype = inferDataType(col, exprByTableCol[`${table}|${col}`] || '');
        result[table][col] = normalizeType(dtype);
        meta[table][col] = { source: 'Script heuristic', confidence: 60, reason: 'No source sample available; inferred from Qlik expression and column name.', sampleValues: [] };
      }
    }
  }
  return [result, meta];
}

// ──────────────────────────────────────────────────────────────
// SECTION 8: M Query Generator
// ──────────────────────────────────────────────────────────────

const KEY_RE_M = /(id$|_id$|key$|_key$|code$|number$|no$|guid$)/i;
const UNSAFE_M_RE = /\b(LOAD|RESIDENT|ApplyMap|IntervalMatch|CrossTable|Generic Load|Peek|Previous|Autonumber)\b/i;

function esc(s: string): string { return '"' + (s || '').replace(/"/g, '""') + '"'; }
function qname(n: string): string { return '#"' + String(n).replace(/"/g, '""') + '"'; }
function lit(v: string): string {
  v = (v || '').trim();
  if (!v) return 'null';
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return esc(v);
}
function isPlainField(expr: string): boolean { return /^[A-Za-z_][A-Za-z0-9_.$#@-]*$/.test((expr || '').trim()); }

function inlineExpression(op: Operation): string {
  const cols = op.inlineColumns;
  const rows = op.inlineRows.map(r => {
    const vals = [...r, ...Array(Math.max(0, cols.length - r.length)).fill('')];
    return '{' + vals.slice(0, cols.length).map(lit).join(', ') + '}';
  });
  return `#table(\n        {${cols.map(esc).join(', ')}},\n        {\n        ${rows.join(',\n        ')}\n        }\n    )`;
}

function dbSourceExpression(mappedRef: string, connectorType: string): string {
  const parts: Record<string, string> = {};
  for (const piece of (mappedRef || '').split(/;|\n/)) {
    if (piece.includes('=')) { const [k, v] = piece.split('=', 2); parts[k.trim().toLowerCase()] = v.trim().replace(/^["']|["']$/g, ''); }
  }
  const server = parts['server'] || parts['host'] || parts['data source'];
  const database = parts['database'] || parts['db'] || parts['initial catalog'];
  const query = parts['query'] || parts['sql'];
  const schema = parts['schema'] || 'dbo';
  const table = parts['table'] || parts['item'];
  const empty = '#table({}, {})';
  if (!server || !database) return empty;
  
  let dbFunc = 'Sql.Database';
  if (connectorType === 'PostgreSQL') dbFunc = 'PostgreSQL.Database';
  if (connectorType === 'MySQL') dbFunc = 'MySQL.Database';
  
  if (query) return `let _empty = ${empty}, _try = try ${dbFunc}(${esc(server)}, ${esc(database)}, [Query=${esc(query)}]) in if _try[HasError] then _empty else _try[Value]`;
  
  if (table) {
    if (connectorType === 'MySQL') {
      return `let _empty = ${empty}, _db = try ${dbFunc}(${esc(server)}, ${esc(database)}), _tbl = if _db[HasError] then [HasError=true, Value=_empty] else try _db[Value]{[Item=${esc(table)}]}[Data] in if _db[HasError] or _tbl[HasError] then _empty else _tbl[Value]`;
    }
    return `let _empty = ${empty}, _db = try ${dbFunc}(${esc(server)}, ${esc(database)}), _tbl = if _db[HasError] then [HasError=true, Value=_empty] else try _db[Value]{[Schema=${esc(schema)},Item=${esc(table)}]}[Data] in if _db[HasError] or _tbl[HasError] then _empty else _tbl[Value]`;
  }
  return empty;
}

function sharepointSourceExpression(mappedRef: string): string {
  const parts: Record<string, string> = {};
  for (const piece of (mappedRef || '').split(/;|\n/)) {
    if (piece.includes('=')) { const [k, v] = piece.split('=', 2); parts[k.trim().toLowerCase()] = v.trim().replace(/^["']|["']$/g, ''); }
  }
  const url = parts['siteurl'] || parts['url'] || mappedRef;
  const empty = '#table({}, {})';
  if (!url) return empty;
  return `let _empty = ${empty}, _try = try SharePoint.Files(${esc(url)}, [ApiVersion = 15]) in if _try[HasError] then _empty else _try[Value]`;
}

function sourceExpression(m: SourceMap | null, _table: string): string {
  const empty = '#table({}, {})';
  if (!m || m.status !== 'Mapped') return empty;
  const rawPath = (m.mappedRef || '').trim().replace(/^["']|["']$/g, '');
  const p = esc(rawPath);
  const contentFn = /^[a-z]+:\/\//.test(rawPath.toLowerCase()) ? 'Web.Contents' : 'File.Contents';
  const ct = m.connectorType;
  if (ct === 'CSV/Text') return `let _empty = ${empty}, _read = try Csv.Document(${contentFn}(${p}), [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]), _promote = if _read[HasError] then [HasError=true, Value=_empty] else try Table.PromoteHeaders(_read[Value], [PromoteAllScalars=true]) in if _read[HasError] or _promote[HasError] then _empty else _promote[Value]`;
  if (ct === 'Excel') return `let _empty = ${empty}, _book = try Excel.Workbook(${contentFn}(${p}), null, true), _first = if _book[HasError] or Table.RowCount(_book[Value]) = 0 then [HasError=true, Value=_empty] else try _book[Value]{0}[Data], _promote = if _first[HasError] then [HasError=true, Value=_empty] else try Table.PromoteHeaders(_first[Value], [PromoteAllScalars=true]) in if _book[HasError] or _first[HasError] or _promote[HasError] then _empty else _promote[Value]`;
  if (ct === 'Parquet') return `let _empty = ${empty}, _try = try Parquet.Document(${contentFn}(${p})) in if _try[HasError] then _empty else _try[Value]`;
  if (ct === 'JSON') return `let _empty = ${empty}, _json = try Json.Document(${contentFn}(${p})), _table = if _json[HasError] then [HasError=true, Value=_empty] else try if Value.Is(_json[Value], type list) then Table.FromRecords(_json[Value]) else if Value.Is(_json[Value], type record) then Record.ToTable(_json[Value]) else _empty in if _json[HasError] or _table[HasError] then _empty else _table[Value]`;
  if (ct === 'XML') return `let _empty = ${empty}, _try = try Xml.Tables(${contentFn}(${p})) in if _try[HasError] then _empty else _try[Value]`;
  if (ct === 'Web/API') return `let _empty = ${empty}, _web = try Web.Contents(${p}), _json = if _web[HasError] then [HasError=true, Value=_empty] else try Json.Document(_web[Value]), _table = if _json[HasError] then [HasError=true, Value=_empty] else try if Value.Is(_json[Value], type list) then Table.FromRecords(_json[Value]) else if Value.Is(_json[Value], type record) then Record.ToTable(_json[Value]) else _empty in if _web[HasError] or _json[HasError] or _table[HasError] then _empty else _table[Value]`;
  if (ct === 'Folder') return `let _empty = ${empty}, _try = try Folder.Files(${p}) in if _try[HasError] then _empty else _try[Value]`;
  if (ct === 'Database/SQL' || ct === 'SQL Server' || ct === 'PostgreSQL' || ct === 'MySQL') return dbSourceExpression((m.mappedRef || '').trim(), ct);
  if (ct === 'SharePoint') return sharepointSourceExpression((m.mappedRef || '').trim());
  return empty;
}

function converterFunction(dtype: string): string {
  const d = normalizeType(dtype);
  if (d === 'Text') return 'try (if _ = null then null else Text.From(_)) otherwise null';
  if (d === 'Whole Number') return 'try (if _ = null then null else Int64.From(_)) otherwise null';
  if (d === 'Decimal Number') return 'try (if _ = null then null else Number.From(_)) otherwise null';
  if (d === 'Currency / Fixed Decimal') return 'try (if _ = null then null else Currency.From(_)) otherwise null';
  if (d === 'Date') return 'try (if _ = null then null else Date.From(_)) otherwise null';
  if (d === 'Date/Time') return 'try (if _ = null then null else DateTime.From(_)) otherwise null';
  if (d === 'True/False') return 'try (if _ = null then null else Logical.From(_)) otherwise null';
  return 'try _ otherwise null';
}

class MBuilder {
  private assignments: [string, string][] = [];
  private step = 1;
  private cache = new Map<string, string>();
  private opCache = new Map<string, string>();
  private stack = new Set<string>();
  private ensureFn: string;
  private mappingLookup: Map<string, SourceMap>;

  constructor(
    private by: Map<string, Operation[]>,
    private joins: Map<string, Operation[]>,
    private concats: Map<string, Operation[]>,
    private generated: Set<string>,
    private mappings: Map<string, SourceMap>,
    private qvdResolver: QvdLineageResolver,
    private columnTypes: Record<string, Record<string, string>>
  ) {
    this.mappingLookup = mappings;
    this.ensureFn = this.addStep('QLIK2PBI_EnsureColumns', '(tbl as table, cols as list) as table => List.Accumulate(cols, tbl, (state, col) => if List.Contains(Table.ColumnNames(state), col) then state else Table.AddColumn(state, col, each null))');
  }

  private nextStep(prefix: string): string { const name = `${cleanName(prefix)}_${this.step}`; this.step++; return name; }
  private addStep(name: string, expr: string): string { this.assignments.push([name, expr || '#table({}, {}']); return name; }

  private render(finalStep: string): string {
    const lines = ['let'];
    for (let i = 0; i < this.assignments.length; i++) {
      const [name, expr] = this.assignments[i];
      const exprLines = expr.split('\n');
      lines.push(`    ${name} = ${exprLines[0]}`);
      for (const line of exprLines.slice(1)) lines.push('        ' + line);
      if (i < this.assignments.length - 1) lines[lines.length-1] += ',';
    }
    lines.push('in'); lines.push(`    ${finalStep}`);
    return lines.join('\n');
  }

  buildFinalTable(table: string): string {
    try {
      let prev = this.buildTable(table, false);
      for (const c of (this.concats.get(table) || [])) {
        const payload = this.buildPayload(c);
        const nm = this.nextStep(`Concat_${table}`);
        this.addStep(nm, `Table.Combine({${prev}, ${payload}})`);
        prev = nm;
      }
      for (const j of (this.joins.get(table) || [])) {
        prev = this.applyJoin(prev, j);
      }
      prev = this.applyTypeConversions(prev, table);
      return this.render(prev);
    } catch (ex) {
      return `let\n    Source = #table({}, {})\nin\n    Source`;
    }
  }

  private buildTable(table: string, allowQueryRef = true): string {
    if (allowQueryRef && this.generated.has(table)) return qname(table);
    if (this.cache.has(table)) return this.cache.get(table)!;
    if (this.stack.has(table)) { const nm = this.nextStep(`Cycle_${table}`); this.addStep(nm, '#table({}, {})'); return nm; }
    this.stack.add(table);
    const op = primaryLoad(this.by.get(table) || []);
    if (!op) { const nm = this.nextStep(`Missing_${table}`); this.addStep(nm, '#table({}, {})'); this.stack.delete(table); return nm; }
    const prev = this.buildOp(op);
    this.cache.set(table, prev); this.stack.delete(table);
    return prev;
  }

  private buildPayload(op: Operation): string { return this.buildOp(op); }

  private mappingFor(src: string): SourceMap | null {
    return this.mappingLookup.get(src) || this.mappingLookup.get(canonicalRef(src)) || this.mappingLookup.get(basenameRef(src)) || null;
  }

  private buildOp(op: Operation): string {
    if (op.id && this.opCache.has(op.id)) return this.opCache.get(op.id)!;
    let result: string;
    if (op.inlineColumns.length) {
      const nm = this.nextStep(`Inline_${op.table}`);
      this.addStep(nm, inlineExpression(op));
      result = nm;
    } else if (op.sourceRefs.length) {
      const src = op.sourceRefs[0];
      if (isQvd(src)) {
        const prodOp = this.qvdResolver.producerOp(src);
        if (prodOp) {
          const base = this.buildOpWithoutCache(prodOp);
          result = this.applyLoadSteps(base, op);
        } else {
          const nm = this.nextStep(`Source_${op.table}`);
          this.addStep(nm, sourceExpression(this.mappingFor(src), op.table));
          result = this.applyLoadSteps(nm, op);
        }
      } else {
        const nm = this.nextStep(`Source_${op.table}`);
        this.addStep(nm, sourceExpression(this.mappingFor(src), op.table));
        result = this.applyLoadSteps(nm, op);
      }
    } else if (op.resident.length) {
      const base = this.buildTable(op.resident[0], true);
      result = this.applyLoadSteps(base, op);
    } else {
      const nm = this.nextStep(`Manual_${op.table}`);
      this.addStep(nm, '#table({}, {})');
      result = nm;
    }
    if (op.id) this.opCache.set(op.id, result);
    return result;
  }

  private buildOpWithoutCache(op: Operation): string {
    if (op.inlineColumns.length) { const nm = this.nextStep(`Inline_${op.table}`); this.addStep(nm, inlineExpression(op)); return nm; }
    if (op.sourceRefs.length) {
      const src = op.sourceRefs[0];
      if (isQvd(src)) { const prod = this.qvdResolver.producerOp(src); if (prod && prod.id !== op.id) { const base = this.buildOpWithoutCache(prod); return this.applyLoadSteps(base, op); } }
      const nm = this.nextStep(`OriginalSource_${op.table}`);
      this.addStep(nm, sourceExpression(this.mappingFor(src), op.table));
      return this.applyLoadSteps(nm, op);
    }
    if (op.resident.length) { const base = this.buildTable(op.resident[0], true); return this.applyLoadSteps(base, op); }
    const nm = this.nextStep(`Manual_${op.table}`); this.addStep(nm, '#table({}, {})'); return nm;
  }

  private applyLoadSteps(prev: string, op: Operation): string {
    if (op.where) {
      const nm = this.nextStep('FilteredRows');
      const mWhere = op.where.replace(/\bAND\b/gi, 'and').replace(/\bOR\b/gi, 'or');
      this.addStep(nm, `Table.SelectRows(${prev}, each try (${mWhere}) otherwise false)`);
      prev = nm;
    }
    return this.applyProjectionAndCalcs(prev, op);
  }

  private applyProjectionAndCalcs(prev: string, op: Operation): string {
    if (!op.fields.length || op.fields[0] === '*') return prev;
    const direct: string[] = [], renames: [string, string][] = [], calcs: [string, string][] = [];
    for (const alias of op.fields) {
      const expr = op.fieldExpressions[alias] || alias;
      if (isPlainField(expr)) {
        const src = cleanName(expr);
        direct.push(src);
        if (src !== alias) renames.push([src, alias]);
      } else {
        calcs.push([alias, 'null']);
      }
    }
    if (direct.length) {
      const nm = this.nextStep('SelectedColumns');
      this.addStep(nm, `Table.SelectColumns(${prev}, {${uniq(direct).map(esc).join(', ')}}, MissingField.UseNull)`);
      prev = nm;
    }
    if (renames.length) {
      const nm = this.nextStep('RenamedColumns');
      const pairs = renames.map(([a, b]) => '{' + esc(a) + ', ' + esc(b) + '}').join(', ');
      this.addStep(nm, `Table.RenameColumns(${prev}, {${pairs}}, MissingField.Ignore)`);
      prev = nm;
    }
    for (const [alias, calc] of calcs) {
      const nm = this.nextStep(`Added_${alias}`);
      this.addStep(nm, `Table.AddColumn(${prev}, ${esc(alias)}, each ${calc})`);
      prev = nm;
    }
    const nm = this.nextStep('FinalColumns');
    this.addStep(nm, `Table.SelectColumns(${prev}, {${op.fields.map(esc).join(', ')}}, MissingField.UseNull)`);
    return nm;
  }

  private ensureColumns(tableExpr: string, columns: string[], prefix = 'EnsureColumns'): string {
    const cols = uniq(columns);
    if (!cols.length) return tableExpr;
    const nm = this.nextStep(prefix);
    this.addStep(nm, `${this.ensureFn}(${tableExpr}, {${cols.map(esc).join(', ')}})`);
    return nm;
  }

  private applyJoin(prev: string, joinOp: Operation): string {
    let joinTableExpr: string, rightName: string;
    if (joinOp.resident.length) { joinTableExpr = this.buildTable(joinOp.resident[0], true); rightName = joinOp.resident[0]; }
    else if (joinOp.sourceRefs.length || joinOp.inlineColumns.length) { joinTableExpr = this.buildPayload(joinOp); rightName = joinOp.table; }
    else return prev;
    const keys = (joinOp.fields.filter(f => KEY_RE_M.test(f)) || joinOp.fields.filter(f => f.toLowerCase().endsWith('id')) || []).slice(0, 1);
    const key = keys[0] || joinOp.fields[0] || 'ID';
    const expand = joinOp.fields.filter(f => f !== key);
    let kind = 'JoinKind.LeftOuter';
    const rawUp = (joinOp.raw || '').toUpperCase();
    if (rawUp.includes('INNER JOIN')) kind = 'JoinKind.Inner';
    else if (rawUp.includes('RIGHT JOIN')) kind = 'JoinKind.RightOuter';
    const leftReady = this.ensureColumns(prev, [key], 'EnsureLeftJoinKey');
    const rightReady = this.ensureColumns(joinTableExpr, [key, ...expand], 'EnsureRightJoinColumns');
    const nested = this.nextStep(`Join_${rightName}`);
    this.addStep(nested, `Table.NestedJoin(${leftReady}, {${esc(key)}}, ${rightReady}, {${esc(key)}}, ${esc(rightName)}, ${kind})`);
    if (expand.length) {
      const ex = this.nextStep(`Expand_${rightName}`);
      this.addStep(ex, `Table.ExpandTableColumn(${nested}, ${esc(rightName)}, {${expand.map(esc).join(', ')}}, {${expand.map(esc).join(', ')}})`);
      return ex;
    }
    return nested;
  }

  private applyTypeConversions(prev: string, table: string): string {
    const types = this.columnTypes[table] || {};
    const transforms: string[] = [];
    for (const [col, dtype] of Object.entries(types)) {
      const d = normalizeType(dtype);
      if (d === 'Any') continue;
      transforms.push('{' + esc(col) + ', each ' + converterFunction(d) + ', ' + mType(d) + '}');
    }
    if (!transforms.length) return prev;
    const nm = this.nextStep('SafeTypeConversions');
    this.addStep(nm, `Table.TransformColumns(${prev}, {${transforms.join(', ')}}, null, MissingField.Ignore)`);
    return nm;
  }
}

export function buildMQueries(profiles: Record<string, TableProfile>, operations: Operation[], mappings: SourceMap[], columnTypes: Record<string, Record<string, string>>): Record<string, string> {
  const mp = new Map<string, SourceMap>();
  for (const m of mappings) {
    if (m.bypassQvd) continue;
    for (const key of [m.originalRef, canonicalRef(m.originalRef), basenameRef(m.originalRef)]) {
      if (key && !mp.has(key)) mp.set(key, m);
    }
  }
  const by = new Map<string, Operation[]>();
  const joins = new Map<string, Operation[]>();
  const concats = new Map<string, Operation[]>();
  for (const o of operations) {
    if (!by.has(o.table)) by.set(o.table, []);
    by.get(o.table)!.push(o);
    if (o.opType === 'join_load' && o.joinTarget) { if (!joins.has(o.joinTarget)) joins.set(o.joinTarget, []); joins.get(o.joinTarget)!.push(o); }
    if (o.opType === 'concat_load' && o.concatTarget) { if (!concats.has(o.concatTarget)) concats.set(o.concatTarget, []); concats.get(o.concatTarget)!.push(o); }
  }
  const generated = new Set(Object.entries(profiles).filter(([,p]) => p.status === 'generated').map(([t]) => t));
  const resolver = new QvdLineageResolver(operations);
  const res: Record<string, string> = {};
  for (const [t, p] of Object.entries(profiles)) {
    if (p.status !== 'generated') continue;
    const builder = new MBuilder(by, joins, concats, generated, mp, resolver, columnTypes);
    res[t] = builder.buildFinalTable(t);
  }
  return res;
}

// ──────────────────────────────────────────────────────────────
// SECTION 9: DAX Translator
// ──────────────────────────────────────────────────────────────

function toDax(expr: string, table: string): [string, string, number, string, string] | null {
  const setwarn = /\{[^}]*<.*?>[^}]*\}/s.test(expr) ? 'Set Analysis detected; filters need manual review.' : '';
  const x = expr.replace(/\{[^}]*<.*?>[^}]*\}/gs, '');
  const m = x.match(/\b(Sum|Count|Avg|Average|Min|Max)\s*\(\s*(DISTINCT\s+)?([^)]+)\)/i);
  if (!m) {
    if (/\b(RangeSum|Aggr)\s*\(/i.test(x)) {
      const name = cleanName('Review_' + x.replace(/\W+/g, '_').slice(0, 50));
      return [name, `/* Manual review required for Qlik expression: ${x.slice(0, 200)} */ BLANK()`, 35, 'Complex Qlik aggregation requires manual DAX review.', 'RangeSum/Aggr requires manual review.'];
    }
    return null;
  }
  const fn = m[1].toLowerCase(), distinct = !!m[2], field = cleanName(m[3].replace(/[^A-Za-z0-9_ ]/g, ''));
  let dax = '', name = '';
  if (fn === 'sum') { dax = `SUM('${table}'[${field}])`; name = `Total_${field}`; }
  else if (fn === 'count' && distinct) { dax = `DISTINCTCOUNT('${table}'[${field}])`; name = `Distinct_${field}`; }
  else if (fn === 'count') { dax = `COUNT('${table}'[${field}])`; name = `Count_${field}`; }
  else if (fn === 'avg' || fn === 'average') { dax = `AVERAGE('${table}'[${field}])`; name = `Average_${field}`; }
  else if (fn === 'min') { dax = `MIN('${table}'[${field}])`; name = `Min_${field}`; }
  else { dax = `MAX('${table}'[${field}])`; name = `Max_${field}`; }
  if (setwarn) dax = `CALCULATE(${dax})`;
  return [cleanName(name), dax, setwarn ? 62 : 92, 'Aggregation converted to DAX measure.', setwarn];
}

export function buildDaxMeasures(operations: Operation[], profiles: Record<string, TableProfile>): DaxMeasure[] {
  const finals = new Set(Object.entries(profiles).filter(([,p]) => p.status === 'generated').map(([t]) => t));
  const out: DaxMeasure[] = [];
  const seen = new Set<string>();
  for (const o of operations) {
    let table = finals.has(o.table) ? o.table : o.resident.find(r => finals.has(r));
    if (!table) table = [...finals][0] || o.table;
    for (const e of uniq(o.aggregations)) {
      const m = toDax(e, table);
      if (m) {
        const key = `${table}||${e}||${m[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ measureName: m[0], dax: m[1], qlikExpression: e, table, confidence: m[2], notes: m[3], source: `${o.file}:${o.startLine}`, warning: m[4] });
        }
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// SECTION 10: Relationship Inference
// ──────────────────────────────────────────────────────────────

const KEY_RE_R = /(id$|_id$|key$|_key$|code$|number$|no$|guid$)/i;
const FACT_RE = /(fact|sales|invoice|order|transaction|ledger|claim|payment|movement|event|detail|line)/i;
const DIM_RE = /(dim|customer|product|item|vendor|supplier|date|calendar|account|region|country|employee|store|lookup|master)/i;

export function tableRole(p: TableProfile): string {
  if (p.classification === 'inline/static') return 'reference';
  if (/bridge|link/i.test(p.table)) return 'bridge';
  if (FACT_RE.test(p.table)) return 'fact';
  if (DIM_RE.test(p.table)) return 'dimension';
  const measures = p.fields.filter(f => /(amount|sales|qty|quantity|price|cost|value|revenue|margin|total|balance)/i.test(f));
  return measures.length >= 2 || p.fields.length > 12 ? 'fact' : 'dimension';
}

function matchPrefix(t: string, f: string): boolean {
  t = t.replace(/^(dim|fact|tbl|ref)_?/i, '').toLowerCase(); f = f.toLowerCase();
  return !!(t && (f.startsWith(t.slice(0, Math.max(3, Math.min(8, t.length)))) || t.includes(f)));
}

function hasPath(edges: [string, string][], a: string, b: string): boolean {
  const g = new Map<string, Set<string>>();
  for (const [x, y] of edges) {
    if (!g.has(x)) g.set(x, new Set()); g.get(x)!.add(y);
    if (!g.has(y)) g.set(y, new Set()); g.get(y)!.add(x);
  }
  const q = [a]; const seen = new Set([a]);
  while (q.length) {
    const n = q.shift()!;
    if (n === b) return true;
    for (const m of (g.get(n) || [])) { if (!seen.has(m)) { seen.add(m); q.push(m); } }
  }
  return false;
}

function scoreRel(a: [string, string], b: [string, string], roles: Record<string, string>): Relationship {
  let [t1, f1] = a, [t2] = b;
  let r1 = roles[t1] || 'dimension', r2 = roles[t2] || 'dimension';
  let fromT = t1, toT = t2;
  if (r2 === 'fact' && (r1 === 'dimension' || r1 === 'reference')) { [fromT, toT] = [t2, t1]; [r1, r2] = [r2, r1]; }
  let score = 0; const reason: string[] = [];
  if ((r1 === 'fact' || r1 === 'bridge') && (r2 === 'dimension' || r2 === 'reference')) { score += 100; reason.push('Fact/bridge to dimension/reference preferred.'); }
  else if (r1 === 'dimension' && r2 === 'dimension') { score -= 100; reason.push('Dimension-dimension mesh relationship discouraged.'); }
  if (KEY_RE_R.test(f1)) { score += 60; reason.push('Shared field looks like ID/Key/Code/Number.'); }
  if (matchPrefix(toT, f1) || matchPrefix(fromT, f1)) { score += 40; reason.push('Table name matches field prefix.'); }
  if ((roles[toT] === 'dimension' || roles[toT] === 'reference') && (roles[fromT] === 'fact' || roles[fromT] === 'bridge')) { score += 80; reason.push('Metadata role suggests one-side dimension and many-side fact.'); }
  return { fromTable: fromT, fromColumn: f1, toTable: toT, toColumn: f1, score, active: false, status: 'candidate', reason: reason.join(' ') || 'Shared field detected.', cardinality: 'manyToOne', filterDirection: 'single', confidence: Math.max(10, Math.min(98, score > 0 ? score : 30)) };
}

export function inferRelationships(profiles: Record<string, TableProfile>): Relationship[] {
  const gen = Object.fromEntries(Object.entries(profiles).filter(([,p]) => p.status === 'generated'));
  const roles: Record<string, string> = {};
  for (const [t, p] of Object.entries(gen)) roles[t] = tableRole(p);
  const fieldTables = new Map<string, [string, string][]>();
  for (const [t, p] of Object.entries(gen)) {
    for (const f of p.fields) {
      const key = f.toLowerCase();
      if (!fieldTables.has(key)) fieldTables.set(key, []);
      fieldTables.get(key)!.push([t, f]);
    }
  }
  const cands: Relationship[] = [];
  for (const pairs of fieldTables.values()) {
    if (pairs.length < 2) continue;
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i+1; j < pairs.length; j++) {
        cands.push(scoreRel(pairs[i], pairs[j], roles));
      }
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const edges: [string, string][] = [];
  const out: Relationship[] = [];
  for (const r of cands) {
    if (r.score <= 0) { r.active = false; r.status = 'rejected/manual review'; out.push(r); continue; }
    if (hasPath(edges, r.fromTable, r.toTable)) {
      r.active = false; r.status = 'inactive/manual review'; r.reason += ' Existing active path exists; kept inactive to avoid ambiguity.'; r.confidence = Math.min(r.confidence, 55);
    } else {
      r.active = true; r.status = 'active'; edges.push([r.fromTable, r.toTable]);
    }
    out.push(r);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// SECTION 11: Semantic Model
// ──────────────────────────────────────────────────────────────

function buildSemanticModel(profiles: Record<string, TableProfile>, measures: DaxMeasure[], relationships: Relationship[], mQueries: Record<string, string>, columnTypes: Record<string, Record<string, string>>): { name: string; tables: Record<string, unknown>[]; relationships: Record<string, unknown>[] } {
  const tables = [];
  for (const [t, p] of Object.entries(profiles)) {
    if (p.status !== 'generated') continue;
    const cols = p.fields.map(f => {
      const dtype = (columnTypes[t] || {})[f] || 'Text';
      const col: Record<string, string> = { name: f, data_type: bimType(dtype), source_type: dtype };
      const fmt = formatString(dtype);
      if (fmt) col['formatString'] = fmt;
      return col;
    });
    tables.push({ name: t, role: tableRole(p), classification: p.classification, columns: cols, partition: mQueries[t] || '', measures: measures.filter(m => m.table === t).map(m => ({ name: m.measureName, expression: m.dax, source: m.qlikExpression, confidence: m.confidence })) });
  }
  return { name: 'QLIK2PBI_Migrated_Model', tables, relationships: relationships.map(r => ({ ...r })) };
}

// ──────────────────────────────────────────────────────────────
// SECTION 12: M Query Diagnostics
// ──────────────────────────────────────────────────────────────

const QLIK_ONLY_RE = /\b(LOAD|RESIDENT|ApplyMap|IntervalMatch|CrossTable|Generic\s+Load|Peek|Previous|Autonumber)\b/i;
const AGG_IN_M_RE = /\b(Sum|Avg)\s*\(|Count\s*\(\s*DISTINCT/i;

function delimiterBalance(text: string): [boolean, string] {
  const s = text.replace(/"([^"]|"")*"/g, m => ' '.repeat(m.length));
  const stack: [string, number][] = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if ('({['.includes(ch)) stack.push([ch, i]);
    else if (')}]'.includes(ch)) {
      if (!stack.length || stack[stack.length-1][0] !== pairs[ch]) return [false, `Unexpected '${ch}' near char ${i}.`];
      stack.pop();
    }
  }
  if (stack.length) return [false, `Unclosed '${stack[stack.length-1][0]}' near char ${stack[stack.length-1][1]}.`];
  return [true, 'Balanced delimiters.'];
}

function mStaticCheckRows(table: string, query: string, columnTypes: Record<string, string> = {}): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const add = (status: string, check: string, root: string, fix: string) => rows.push({ Status: status, Table: table, Check: check, 'Possible root cause': root, 'Recommended fix': fix });
  const q = query || '';
  if (!q.trim()) { add('Fail', 'M query exists', 'No Power Query M was generated for this final table.', 'Complete source mapping and regenerate conversion.'); return rows; }
  const hasLet = /(^|\n)\s*let\b/i.test(q), hasIn = /(^|\n)\s*in\b/i.test(q);
  add(hasLet && hasIn ? 'Pass' : 'Fail', 'let/in structure', hasLet && hasIn ? 'Complete let/in expression detected.' : 'M query must be a complete let/in expression.', hasLet && hasIn ? 'No action needed.' : 'Regenerate M after source mapping.');
  const [balOk, balMsg] = delimiterBalance(q);
  add(balOk ? 'Pass' : 'Fail', 'delimiter balance', balMsg, balOk ? 'No action needed.' : 'Regenerate M and check parentheses/braces.');
  const leadingComma = /\n\s*,\s*(#"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*=/.test(q);
  add(leadingComma ? 'Fail' : 'Pass', 'no leading-comma step syntax', leadingComma ? 'Power Query steps cannot start with a comma.' : 'No leading-comma step syntax found.', leadingComma ? 'Regenerate with safe M writer.' : 'No action needed.');
  const qlik = QLIK_ONLY_RE.test(q);
  add(qlik ? 'Fail' : 'Pass', 'no Qlik-only syntax in M', qlik ? 'Qlik script text was written into M.' : 'No known Qlik-only syntax detected.', qlik ? 'Keep unsupported logic in review notes.' : 'No action needed.');
  const aggs = AGG_IN_M_RE.test(q);
  add(aggs ? 'Fail' : 'Pass', 'aggregations not in M', aggs ? 'Qlik aggregation syntax generated as Power Query.' : 'No Qlik-style aggregations in M.', aggs ? 'Convert aggregations to DAX measures.' : 'No action needed.');
  const manual = ['Manual source mapping required', 'Unsupported connector for table', 'Database connector placeholder'].some(s => q.includes(s));
  add(manual ? 'Fail' : 'Pass', 'no manual/unsupported source placeholder', manual ? 'M still contains a manual mapping placeholder.' : 'No manual source placeholders detected.', manual ? 'Update source mapping.' : 'No action needed.');
  const hasTypeStep = q.includes('Table.TransformColumns') && q.includes('MissingField.Ignore');
  if (Object.keys(columnTypes).length) add(hasTypeStep ? 'Pass' : 'Warning', 'safe datatype conversion step', hasTypeStep ? 'Defensive type conversion step detected.' : 'User-selected data types exist but no defensive Table.TransformColumns step was detected.', hasTypeStep ? 'No action needed.' : 'Click Apply data types and regenerate M.');
  else add('Warning', 'safe datatype conversion step', 'No column type metadata for this table.', 'Review parser output and type inference.');
  return rows;
}

function buildMQueryDiagnostics(mQueries: Record<string, string>, columnTypes: Record<string, Record<string, string>>): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  for (const table of Object.keys(mQueries).sort()) {
    rows.push(...mStaticCheckRows(table, mQueries[table], (columnTypes || {})[table] || {}));
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────
// SECTION 13: Source Catalog
// ──────────────────────────────────────────────────────────────

function sourceKind(ref: string, connectorType = ''): string {
  const r = (ref || '').trim();
  const low = r.toLowerCase();
  const ct = connectorType || connector(r);
  if (low.endsWith('.qvd')) return 'QVD handoff / staging file';
  if (low.startsWith('lib://')) return 'Qlik library file reference';
  if (low.includes('$(')) return 'Qlik variable-based file reference';
  if (/^[a-z]+:\/\//.test(low)) return 'Web/API file reference';
  if (['CSV/Text','Excel','Parquet','JSON','XML','Folder'].includes(ct)) return 'File source';
  if (ct === 'Database/SQL') return 'Relational database object/query';
  return 'Unknown / manual review';
}

function requiredDetails(connectorType: string, ref = ''): string {
  const ct = connectorType || connector(ref);
  if (ct === 'CSV/Text') return 'Mapped file path, delimiter, encoding, header-row confirmation.';
  if (ct === 'Excel') return 'Workbook path plus optional sheet/table name.';
  if (ct === 'Parquet') return 'Parquet file path or folder path.';
  if (ct === 'JSON') return 'JSON file path or web URL plus record/list expansion rules if nested.';
  if (ct === 'XML') return 'XML file path plus element/table extraction rule if nested.';
  if (ct === 'Folder') return 'Folder path and file-combine rule/pattern.';
  if (ct === 'Database/SQL') return 'Server, database, schema/table or native SQL query, authentication method. Format: server=SERVER;database=DB;schema=dbo;table=TableName';
  if (ref.toLowerCase().includes('qvd')) return 'Upload the QVD generator script or map to the original CSV/Excel/SQL source.';
  return 'Choose connector type and provide a Power BI-readable mapped source reference.';
}

function buildSourceCatalog(mappings: SourceMap[], _operations: Operation[], _connections: { type: string; connection: string; file: string; line: number }[]): Record<string, string | boolean>[] {
  const rows: Record<string, string | boolean>[] = [];
  const seen = new Set<string>();
  for (const m of mappings || []) {
    const key = `${m.originalRef}||${m.table}||${m.sourceRole}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ct = m.connectorType || connector(m.mappedRef || m.originalRef);
    rows.push({
      'Table': m.table,
      'Source role': m.sourceRole,
      'Original Qlik reference': m.originalRef,
      'Mapped / effective reference': m.mappedRef || m.effectiveRef,
      'Inferred connector': ct,
      'Source kind': sourceKind(m.originalRef, ct),
      'Required connection details': requiredDetails(ct, m.originalRef),
      'QVD bypassed': m.bypassQvd,
      'QVD producer table': m.qvdProducerTable,
      'Status': m.status,
      'Notes': m.notes,
    });
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────
// SECTION 14: Validator
// ──────────────────────────────────────────────────────────────

function validate(profiles: Record<string, TableProfile>, mappings: SourceMap[], mQueries: Record<string, string>, measures: DaxMeasure[], relationships: Relationship[], columnTypes: Record<string, Record<string, string>>): { isReadyForPbipExport: boolean; errorCount: number; warningCount: number; issues: ValidationIssue[]; desktopDiagnostics: Record<string, string>[] } {
  const issues: ValidationIssue[] = [];
  for (const m of mappings) {
    if (m.bypassQvd || m.status === 'Bypassed' || m.connectorType === 'QVD bypassed via lineage') continue;
    if (m.status !== 'Mapped') issues.push({ severity: 'Error', area: 'Source Mapping', objectName: m.originalRef, message: 'Required source mapping is not confirmed.', recommendation: 'Update connector type and mapped path.' });
    if (m.connectorType.includes('QVD')) issues.push({ severity: 'Error', area: 'Source Mapping', objectName: m.originalRef, message: 'Unresolved QVD cannot be loaded directly by standard Power Query.', recommendation: 'Upload the QVD generator script or map this QVD to CSV/Excel/Parquet/SQL.' });
  }
  const allowedTypes = new Set(TYPE_OPTIONS);
  for (const [table, cols] of Object.entries(columnTypes || {})) {
    for (const [col, dtype] of Object.entries(cols)) {
      if (!allowedTypes.has(dtype)) issues.push({ severity: 'Error', area: 'Data Types', objectName: `${table}.${col}`, message: `Unsupported Power BI data type: ${dtype}`, recommendation: 'Choose a supported type.' });
    }
  }
  for (const [t, p] of Object.entries(profiles)) {
    if (p.status !== 'generated') continue;
    const q = mQueries[t] || '';
    if (!q) issues.push({ severity: 'Error', area: 'Power Query', objectName: t, message: 'No M query generated.', recommendation: '' });
    else if (!/\blet\b/i.test(q) || !/\bin\b/i.test(q)) issues.push({ severity: 'Error', area: 'Power Query', objectName: t, message: 'M query must contain let/in.', recommendation: '' });
    else if (['Manual source mapping required','Unsupported connector for table','Database connector placeholder'].some(s => q.includes(s))) issues.push({ severity: 'Error', area: 'Power Query', objectName: t, message: 'Generated M contains source mapping error.', recommendation: 'Complete source mapping.' });
    else if (QLIK_ONLY_RE.test(q)) issues.push({ severity: 'Error', area: 'Power Query', objectName: t, message: 'Qlik-only syntax found inside generated M.', recommendation: '' });
    else if (!/Table\.TransformColumns[^)]*MissingField\.Ignore/s.test(q)) issues.push({ severity: 'Info', area: 'Power Query', objectName: t, message: 'No explicit defensive type-conversion step detected.', recommendation: 'Use M Query & Data Types to confirm data types before export.' });
  }
  for (const m of measures) {
    if (m.warning) issues.push({ severity: 'Warning', area: 'DAX', objectName: m.measureName, message: m.warning, recommendation: 'Manual review required.' });
  }
  for (const r of relationships) {
    if (r.status !== 'active' && r.score > 0) issues.push({ severity: 'Info', area: 'Relationships', objectName: `${r.fromTable}-${r.toTable}`, message: r.reason, recommendation: 'Review inactive relationship if needed.' });
  }
  const desktopDiagnostics: Record<string, string>[] = [];
  const addDiag = (status: string, area: string, check: string, root: string, fix: string) => desktopDiagnostics.push({ Status: status, Area: area, Check: check, 'Possible root cause': root, 'Recommended fix': fix });
  const errors = issues.filter(i => i.severity === 'Error').length;
  if (errors === 0) addDiag('Pass', 'Validation', 'No blocking migration validation errors', 'All required source mappings and generated M checks passed.', 'Proceed to PBIP export.');
  else addDiag('Fail', 'Validation', 'Blocking migration validation errors exist', 'Power BI Desktop may reject or open with broken queries.', 'Fix all Error rows in Validation.');
  for (const [table, query] of Object.entries(mQueries || {})) {
    if (!query || !/\blet\b/i.test(query) || !/\bin\b/i.test(query)) addDiag('Fail', 'Power Query', `${table}: let/in structure`, 'Generated M expression is incomplete.', 'Regenerate M after source mapping.');
    else addDiag('Pass', 'Power Query', `${table}: safe M syntax pre-check`, 'M query has let/in and no known Qlik-only syntax.', 'Open PBIP and refresh.');
  }
  const finalTables = Object.values(profiles).filter(p => p.status === 'generated');
  if (finalTables.length) addDiag('Pass', 'Semantic model', `${finalTables.length} final model tables`, 'Only generated final tables are written to model.bim.', 'Excluded Qlik helper/staging tables remain in review metadata.');
  else addDiag('Fail', 'Semantic model', 'No final model tables', 'Final table detector did not find generated tables.', 'Review parser inventory and final table detector rules.');
  return { isReadyForPbipExport: errors === 0, errorCount: errors, warningCount: issues.filter(i => i.severity === 'Warning').length, issues, desktopDiagnostics };
}

// ──────────────────────────────────────────────────────────────
// SECTION 15: Migration Report
// ──────────────────────────────────────────────────────────────

function buildMigrationReport(profiles: Record<string, TableProfile>, mappings: SourceMap[], measures: DaxMeasure[], relationships: Relationship[], validation: { isReadyForPbipExport: boolean; errorCount: number; warningCount: number; issues: ValidationIssue[] }): string {
  const final = Object.values(profiles).filter(p => p.status === 'generated');
  const excl = Object.values(profiles).filter(p => p.status !== 'generated');
  const bypassed = mappings.filter(m => m.bypassQvd || m.status === 'Bypassed');
  const editable = mappings.filter(m => !m.bypassQvd && m.status !== 'Bypassed');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines = [
    '# QLIK2PBI Migration Report', '', `Generated: ${now}`, '',
    '## Executive Summary',
    `- Final/static tables generated: **${final.length}**`,
    `- Helper/excluded tables: **${excl.length}**`,
    `- DAX measures generated: **${measures.length}**`,
    `- Relationship candidates: **${relationships.length}**`,
    `- QVD handoffs bypassed by lineage: **${bypassed.length}**`,
    `- Editable physical source mappings: **${editable.length}**`,
    `- PBIP readiness: **${validation.isReadyForPbipExport ? 'Ready' : 'Blocked'}**`,
    `- Errors: **${validation.errorCount}**`,
    `- Warnings: **${validation.warningCount}**`, '',
    '## Final Tables',
    ...final.flatMap(p => [`### ${p.table}`, `- Classification: ${p.classification}`, `- Confidence: ${p.confidence}`, `- Sources: ${p.sourceRefs.join(', ') || 'None parsed'}`, `- QVD handoffs in lineage: ${p.qvdInputs.join(', ') || 'None'}`, `- Dependencies: ${p.dependencies.join(', ') || 'None'}`, `- Reason: ${p.reason}`, '']),
    '## Excluded / Helper Tables',
    ...excl.map(p => `- **${p.table}** — ${p.classification}; ${p.reason}`), '',
    '## Source Mapping and QVD Bypass Plan',
    ...mappings.map(m => `- **${m.originalRef}** → \`${m.mappedRef}\` [${m.connectorType}] — ${m.status}. ${m.notes}${m.bypassQvd ? ` Producer table: **${m.qvdProducerTable}**.` : m.table ? ` Table: **${m.table}**; role: ${m.sourceRole}.` : ''}`), '',
    '## DAX Measures',
    ...measures.flatMap(m => [`### ${m.measureName}`, `- Table: ${m.table}`, `- DAX: \`${m.dax}\``, `- Source Qlik: \`${m.qlikExpression}\``, `- Confidence: ${m.confidence}`, '']),
    '## Relationships',
    ...relationships.map(r => `- **${r.active ? 'Active' : 'Inactive/Review'}** ${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}], score ${r.score}. ${r.reason}`), '',
    '## Validation Issues',
    ...(validation.issues.length ? validation.issues.map(i => `- **${i.severity}** | ${i.area} | ${i.objectName}: ${i.message} ${i.recommendation}`) : ['No validation issues found.']),
  ];
  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────
// SECTION 16: M Query Export Helpers
// ──────────────────────────────────────────────────────────────

export function combinedMQueriesText(mQueries: Record<string, string>): string {
  const parts: string[] = [];
  for (const table of Object.keys(mQueries).sort()) {
    parts.push('/' + '*'.repeat(78));
    parts.push(`Power Query M for table: ${table}`);
    parts.push('Copy only the query expression below this header into Power BI Advanced Editor.');
    parts.push('*'.repeat(78) + '/');
    parts.push((mQueries[table] || '').trim());
    parts.push('');
  }
  return parts.join('\n').trim() + '\n';
}

// ──────────────────────────────────────────────────────────────
// SECTION 17: Rows-to-Updates helpers
// ──────────────────────────────────────────────────────────────

export function rowsToUpdates(rows: Record<string, string>[]): Record<string, { mappedRef: string; connectorType: string; status: string; notes: string }> {
  const updates: Record<string, { mappedRef: string; connectorType: string; status: string; notes: string }> = {};
  for (const r of rows || []) {
    const bypass = String(r['bypass_qvd'] || '').toLowerCase();
    if (bypass === 'true' || bypass === '1' || r['status'] === 'Bypassed') continue;
    const original = (r['original_ref'] || r['originalRef'] || '').trim();
    if (!original) continue;
    const mapped = (r['mapped_ref'] || r['mappedRef'] || original).trim();
    const ct = connector(mapped || original);
    const db_incomplete = ct === 'Database/SQL' && !(mapped.toLowerCase().includes('server=') && mapped.toLowerCase().includes('database='));
    let status = r['status'] || 'Needs review';
    if (!status || status === 'Needs review') {
      if (mapped && mapped !== original && !['Unknown','QVD - map to supported source'].includes(ct) && !mapped.toLowerCase().endsWith('.qvd') && !db_incomplete) status = 'Mapped';
    }
    const notes = (r['notes'] || '').trim();
    const update = { mappedRef: mapped, connectorType: ct, status, notes };
    updates[original] = update;
    updates[canonicalRef(original)] = update;
    const base = basenameRef(original);
    if (base) updates[base] = update;
  }
  return updates;
}

// ──────────────────────────────────────────────────────────────
// SECTION 18: Main Pipeline
// ──────────────────────────────────────────────────────────────

export function runEnterpriseAnalysis(files: ProjectFile[], mappingUpdates: Record<string, { mappedRef?: string; connectorType?: string; status?: string; notes?: string }> = {}, dataTypeUpdates: Record<string, string> = {}): EnterpriseAnalysis {
  const parsed = parseProject(files);
  const ops = parsed.operations;
  const profiles = detectTables(ops);
  const maps = buildSourceMappings(ops, mappingUpdates);
  const sourceCatalog = buildSourceCatalog(maps, ops, parsed.connections);
  const [columnTypes, columnTypeMeta] = buildColumnTypes(profiles, ops, dataTypeUpdates);
  const dax = buildDaxMeasures(ops, profiles);
  const mQueries = buildMQueries(profiles, ops, maps, columnTypes);
  const mDiagnostics = buildMQueryDiagnostics(mQueries, columnTypes);
  const rels = inferRelationships(profiles);
  const model = buildSemanticModel(profiles, dax, rels, mQueries, columnTypes);
  const val = validate(profiles, maps, mQueries, dax, rels, columnTypes);
  const rep = buildMigrationReport(profiles, maps, dax, rels, val);
  const finalTables = Object.values(profiles).filter(p => p.status === 'generated');
  const excludedTables = Object.values(profiles).filter(p => p.status !== 'generated');
  return {
    inventory: { totalFiles: files.length, textFiles: files.filter(f => f.isText).length, files },
    operations: ops, variables: parsed.variables, connections: parsed.connections,
    profiles, finalTables, excludedTables,
    sourceMappings: maps, sourceCatalog, columnTypes, columnTypeMeta,
    daxMeasures: dax, mQueries, mQueryDiagnostics: mDiagnostics,
    relationships: rels, semanticModel: model, validation: val, migrationReport: rep,
    logs: [
      `Upload/extraction: ${files.length} files`,
      `Parser: ${ops.length} operations`,
      `Final table detector: ${finalTables.length} generated tables`,
      `Source mapper: ${maps.length} source refs`,
      `Source catalog: ${sourceCatalog.length} connector-planning rows`,
      `Data-type designer: ${Object.values(columnTypes).reduce((s, v) => s + Object.keys(v).length, 0)} columns typed`,
      `DAX translator: ${dax.length} measures`,
      `M query diagnostics: ${mDiagnostics.filter(d => d['Status'] === 'Pass').length} pass / ${mDiagnostics.length} checks`,
      `Relationship engine: ${rels.length} candidates`,
      `PBIP readiness: ${val.isReadyForPbipExport ? 'Ready' : 'Blocked'} (${val.errorCount} errors, ${val.warningCount} warnings)`,
    ],
  };
}
