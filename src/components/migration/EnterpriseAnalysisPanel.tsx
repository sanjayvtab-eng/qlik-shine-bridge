import { useState, useCallback } from "react";
import {
  runEnterpriseAnalysis,
  combinedMQueriesText,
  rowsToUpdates,
  TYPE_OPTIONS,
  connector,
  tableRole,
  type EnterpriseAnalysis,
  type ProjectFile,
} from "@/lib/migration/enterprise-parser";
import { cn } from "@/lib/utils";
import {
  Database, FileText, Table2, GitBranch, Layers, BarChart3,
  Network, ShieldCheck, Download, Braces, Loader2, AlertCircle,
  Check, ChevronDown, ChevronRight, RefreshCw, Info, X, Sparkles
} from "lucide-react";
import type { ExtractedFile } from "./MultiFileDropzone";
import { useMigration } from "@/lib/migration/store";
import { generatePowerQueryViaAi } from "@/lib/migration/gemini";
import { BulkMeasureTranslator } from "./BulkMeasureTranslator";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

interface MappingRow {
  originalRef: string;
  mappedRef: string;
  connectorType: string;
  status: string;
  notes: string;
  table: string;
  sourceRole: string;
  bypassQvd: boolean;
  effectiveRef: string;
  qvdProducerTable: string;
}

const CONNECTOR_OPTIONS = [
  "CSV/Text","Excel","Parquet","JSON","XML","Web/API","Folder","Database/SQL",
  "QVD bypassed via lineage","QVD - map to supported source","Unknown",
];
const STATUS_OPTIONS = ["Mapped","Needs review","Bypassed"];

// ────────────────────────────────────────────────────────────────
// Small Helpers
// ────────────────────────────────────────────────────────────────

function Badge({ label, variant = "default" }: { label: string | number; variant?: "default" | "success" | "error" | "warning" | "info" }) {
  const cls = {
    default: "bg-primary/10 text-primary",
    success: "bg-green-500/10 text-green-400",
    error: "bg-red-500/10 text-red-400",
    warning: "bg-amber-500/10 text-amber-400",
    info: "bg-sky-500/10 text-sky-400",
  }[variant];
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${cls}`}>{label}</span>;
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="surface-card p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-2xl font-bold text-foreground">{value}</span>
      {sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </div>
  );
}

function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-3">
      <h4 className="font-display font-semibold text-base text-foreground">{title}</h4>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function CodeBlock({ code, lang = "powerquery" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-xl overflow-hidden border border-border bg-surface-elevated">
      <button
        onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-surface border border-border hover:bg-surface-elevated"
      >
        {copied ? <><Check className="h-3 w-3" /> Copied</> : "Copy"}
      </button>
      <pre className="p-4 text-xs font-mono overflow-auto max-h-72 text-foreground whitespace-pre-wrap">{code}</pre>
    </div>
  );
}

function DataTable({ rows, columns }: { rows: Record<string, unknown>[]; columns?: string[] }) {
  if (!rows || rows.length === 0) return <p className="text-xs text-muted-foreground italic">No data.</p>;
  const cols = columns || Object.keys(rows[0]);
  return (
    <div className="overflow-auto rounded-xl border border-border">
      <table className="w-full text-xs">
        <thead className="bg-surface-elevated border-b border-border">
          <tr>{cols.map(c => <th key={c} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className={i % 2 === 0 ? "bg-surface" : "bg-surface-elevated/40"}>
              {cols.map(c => <td key={c} className="px-3 py-1.5 text-foreground/80 whitespace-nowrap max-w-[300px] truncate">{String(row[c] ?? "")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// File-to-ProjectFile converter
// ────────────────────────────────────────────────────────────────

function toProjectFiles(files: ExtractedFile[]): ProjectFile[] {
  return files
    .filter(f => f.parsedAsText)
    .map(f => ({
      path: f.path || f.name,
      ext: f.extension || "",
      size: Math.round((f.sizeKb || 0) * 1024),
      isText: true,
      content: f.text || "",
      note: "",
    }));
}

// ────────────────────────────────────────────────────────────────
// TAB 1 — Upload & Summary (handled by parent, shown here as results)
// ────────────────────────────────────────────────────────────────

function TabSummary({ analysis }: { analysis: EnterpriseAnalysis }) {
  const inv = analysis.inventory;
  const val = analysis.validation;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard label="Files" value={inv.totalFiles} />
        <MetricCard label="Text Parsed" value={inv.textFiles} />
        <MetricCard label="Operations" value={analysis.operations.length} />
        <MetricCard label="Final Tables" value={analysis.finalTables.length} />
        <MetricCard label="DAX Measures" value={analysis.daxMeasures.length} />
        <MetricCard label="PBIP Ready" value={val.isReadyForPbipExport ? "✓ Ready" : "✗ Blocked"} />
      </div>

      <div className="surface-card p-4">
        <SectionHeader title="Files Inventory" />
        <DataTable rows={inv.files.map(f => ({ Path: f.path, Extension: f.ext, "Size KB": (f.size / 1024).toFixed(2), Parsed: f.isText ? "Yes" : "No", Note: f.note }))} />
      </div>

      <div className="surface-card p-4">
        <SectionHeader title="Pipeline Logs" />
        <div className="space-y-1">
          {analysis.logs.map((l, i) => <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground"><Check className="h-3.5 w-3.5 text-green-400 mt-0.5 shrink-0" />{l}</div>)}
        </div>
      </div>

      <div className="surface-card p-4">
        <SectionHeader title="Summary" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          {[
            ["Final tables", analysis.finalTables.map(p => p.table).join(", ") || "None"],
            ["Excluded tables", analysis.excludedTables.map(p => `${p.table} (${p.classification})`).join(", ") || "None"],
            ["Inline tables", Object.values(analysis.profiles).filter(p => p.classification === "inline/static").map(p => p.table).join(", ") || "None"],
            ["Columns typed", String(Object.values(analysis.columnTypes).reduce((s, v) => s + Object.keys(v).length, 0))],
            ["DAX measures", String(analysis.daxMeasures.length)],
            ["Source mapping needed", String(analysis.sourceMappings.filter(m => m.status !== "Mapped" && !m.bypassQvd).length)],
            ["QVD handoffs bypassed", String(analysis.sourceMappings.filter(m => m.bypassQvd).length)],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="font-semibold text-foreground/70 shrink-0">{k}:</span>
              <span className="text-muted-foreground">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 2 — Source Mapping Editor
// ────────────────────────────────────────────────────────────────

function TabSourceMapping({
  analysis, mappingRows, onMappingChange, onApply, applying
}: {
  analysis: EnterpriseAnalysis;
  mappingRows: MappingRow[];
  onMappingChange: (rows: MappingRow[]) => void;
  onApply: () => void;
  applying: boolean;
}) {
  const [bulkFolder, setBulkFolder] = useState("");
  const [convertQvd, setConvertQvd] = useState(true);
  const editable = mappingRows.filter(m => !m.bypassQvd);
  const bypassed = mappingRows.filter(m => m.bypassQvd);
  const unresolved = editable.filter(m => m.status !== "Mapped").length;

  const handleCellChange = (idx: number, field: keyof MappingRow, value: string) => {
    const updated = mappingRows.map((r, i) => {
      if (i !== idx) return r;
      const newRow = { ...r, [field]: value };
      if (field === "mappedRef") newRow.connectorType = connector(value) || newRow.connectorType;
      return newRow;
    });
    onMappingChange(updated);
  };

  const handleBulkFill = () => {
    if (!bulkFolder.trim()) return;
    const updated = mappingRows.map(r => {
      if (r.bypassQvd || r.status === "Bypassed") return r;
      const rawPath = r.originalRef.replace(/^\$\([^)]+\)/, "");
      let basename = (rawPath.split("/").pop() || rawPath.split("\\").pop() || "").split("?")[0];
      if (!basename) return r;
      if (convertQvd && basename.toLowerCase().endsWith(".qvd")) {
        basename = basename.substring(0, basename.length - 4) + ".csv";
      }
      const sep = bulkFolder.includes("\\") || /^[A-Za-z]:/.test(bulkFolder) ? "\\" : "/";
      const mapped = bulkFolder.replace(/[/\\]+$/, "") + sep + basename;
      const ct = connector(mapped);
      return { ...r, mappedRef: mapped, connectorType: ct, status: ["Unknown","QVD - map to supported source"].includes(ct) ? "Needs review" : "Mapped" };
    });
    onMappingChange(updated);
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="Editable Physical Sources" value={editable.length} />
        <MetricCard label="QVDs Bypassed" value={bypassed.length} />
        <MetricCard label="Needs Review" value={unresolved} />
      </div>

      {analysis.sourceCatalog.length > 0 && (
        <div className="surface-card p-4">
          <SectionHeader title="Source Catalog" sub="Connector planning from Qlik script metadata" />
          <DataTable rows={analysis.sourceCatalog as Record<string, unknown>[]} />
        </div>
      )}

      <div className="surface-card p-4">
        <SectionHeader title="Bulk Alternate Folder" sub="Auto-fill all unresolved file sources by replacing path prefix" />
        <div className="flex gap-2">
          <input
            type="text"
            value={bulkFolder}
            onChange={e => setBulkFolder(e.target.value)}
            placeholder="C:\MigrationSources\Data"
            className="flex-1 px-3 py-2 rounded-lg border border-border bg-surface text-sm text-foreground"
          />
          <button onClick={handleBulkFill} className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium">Auto-fill</button>
        </div>
      </div>

      <div className="surface-card p-4">
        <SectionHeader title="Source Mapping Editor" sub="Set mapped paths and connector types. Leave bypassed QVDs as-is." />
        <div className="overflow-auto rounded-xl border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-elevated border-b border-border">
              <tr>
                {["Table","Source Role","Original Qlik Ref","Connector Type","Mapped Power BI Path","Status","Bypass","Notes"].map(h =>
                  <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {mappingRows.map((row, i) => (
                <tr key={i} className={cn("border-b border-border/30", row.bypassQvd && "opacity-60")}>
                  <td className="px-3 py-1.5 text-foreground/70 max-w-[120px] truncate">{row.table}</td>
                  <td className="px-3 py-1.5 text-muted-foreground max-w-[100px] truncate">{row.sourceRole}</td>
                  <td className="px-3 py-1.5 font-mono text-foreground/80 max-w-[180px] truncate" title={row.originalRef}>{row.originalRef}</td>
                  <td className="px-3 py-1.5">
                    {row.bypassQvd ? <Badge label={row.connectorType} variant="info" /> : (
                      <select value={row.connectorType} onChange={e => handleCellChange(i, "connectorType", e.target.value)}
                        className="px-2 py-1 rounded border border-border bg-surface text-xs text-foreground">
                        {CONNECTOR_OPTIONS.map(o => <option key={o}>{o}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {row.bypassQvd ? <span className="text-muted-foreground text-[10px]">{row.effectiveRef}</span> : (
                      <input value={row.mappedRef} onChange={e => handleCellChange(i, "mappedRef", e.target.value)}
                        className="w-full min-w-[200px] px-2 py-1 rounded border border-border bg-surface text-xs text-foreground font-mono" />
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    {row.bypassQvd ? <Badge label="Bypassed" variant="info" /> : (
                      <select value={row.status} onChange={e => handleCellChange(i, "status", e.target.value)}
                        className="px-2 py-1 rounded border border-border bg-surface text-xs text-foreground">
                        {STATUS_OPTIONS.map(o => <option key={o}>{o}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-1.5">{row.bypassQvd ? <Check className="h-3.5 w-3.5 text-sky-400" /> : null}</td>
                  <td className="px-3 py-1.5">
                    <input value={row.notes} onChange={e => handleCellChange(i, "notes", e.target.value)}
                      className="w-full min-w-[120px] px-2 py-1 rounded border border-border bg-surface text-xs text-foreground" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={onApply}
            disabled={applying}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Apply Mapping & Re-run Conversion
          </button>
          <span className="text-xs text-muted-foreground">Applying will re-run the full enterprise pipeline with updated source paths.</span>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 3 — All Tables / Inventory
// ────────────────────────────────────────────────────────────────

function TabAllTables({ analysis }: { analysis: EnterpriseAnalysis }) {
  const getMapped = (src: string) => {
    const map = analysis.sourceMappings.find(m => m.originalRef === src);
    return map ? map.mappedRef : src;
  };

  return (
    <div className="space-y-5">
      <div className="surface-card p-4">
        <SectionHeader title="Table Classification" />
        <DataTable rows={Object.values(analysis.profiles).map(p => ({
          Table: p.table, Classification: p.classification, Status: p.status,
          Confidence: p.confidence, Reason: p.reason,
          Fields: p.fields.length, Sources: p.sourceRefs.map(getMapped).join(", "), Dependencies: p.dependencies.join(", "),
        }))} />
      </div>
      <div className="surface-card p-4">
        <SectionHeader title="Parsed Operations" />
        <DataTable rows={analysis.operations.map(o => ({
          Operation: o.id, Table: o.table, Type: o.opType, Role: o.role,
          File: o.file, Lines: `${o.startLine}-${o.endLine}`,
          Sources: o.sourceRefs.map(getMapped).join(", "), Resident: o.resident.join(", "),
          "Join Target": o.joinTarget, "Concat Target": o.concatTarget,
        }))} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 4 — Final Table Review (per-table subtabs)
// ────────────────────────────────────────────────────────────────

function TabFinalTables({ analysis }: { analysis: EnterpriseAnalysis }) {
  const [activeTable, setActiveTable] = useState(0);
  const finals = analysis.finalTables;
  if (!finals.length) return <div className="surface-card p-8 text-center text-muted-foreground">No final tables detected.</div>;
  const p = finals[activeTable];
  const mQuery = analysis.mQueries[p.table] || "";
  const typeCols = analysis.columnTypes[p.table] || {};
  const measures = analysis.daxMeasures.filter(m => m.table === p.table);
  const valIssues = analysis.validation.issues.filter(i => i.objectName === p.table);

  return (
    <div className="space-y-4">
      {/* Table selector */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {finals.map((t, i) => (
          <button key={t.table} onClick={() => setActiveTable(i)}
            className={cn("px-4 py-2 text-xs font-medium rounded-lg whitespace-nowrap transition-all",
              activeTable === i ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-foreground hover:border-primary/50")}>
            {t.table}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left panel — details */}
        <div className="space-y-4 lg:col-span-1">
          <div className="surface-card p-4">
            <h4 className="font-display font-semibold text-base">{p.table}</h4>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge label={p.status} variant={p.status === "generated" ? "success" : "warning"} />
              <Badge label={p.classification} variant="default" />
              <Badge label={`Confidence: ${p.confidence}`} variant="info" />
            </div>
            <p className="text-xs text-muted-foreground mt-2">{p.reason}</p>
          </div>

          <div className="surface-card p-4">
            <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">ETL Story</h5>
            <p className="text-xs text-muted-foreground leading-relaxed">{p.etlStory || "No ETL story generated."}</p>
          </div>

          {p.sourceRefs.length > 0 && (
            <div className="surface-card p-4">
              <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Sources</h5>
              {p.sourceRefs.map(s => {
                const mapped = analysis.sourceMappings.find(m => m.originalRef === s)?.mappedRef || s;
                return <div key={s} className="text-xs font-mono text-muted-foreground">{mapped}</div>;
              })}
            </div>
          )}

          {p.flowSteps.length > 0 && (
            <div className="surface-card p-4">
              <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Transformation Flow</h5>
              <DataTable rows={p.flowSteps as Record<string, unknown>[]} />
            </div>
          )}

          {p.lineageScript && (
            <div className="surface-card p-4">
              <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Original Qlik Lineage</h5>
              <CodeBlock code={p.lineageScript} lang="sql" />
            </div>
          )}
        </div>

        {/* Right panel — types + DAX + validation */}
        <div className="space-y-4 lg:col-span-1">
          <div className="surface-card p-4">
            <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Column Types</h5>
            <DataTable rows={p.fields.map(f => ({ Column: f, "Power BI Type": typeCols[f] || "Text" }))} />
          </div>
          <div className="surface-card p-4">
            <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">DAX Measures</h5>
            {measures.length ? measures.map(m => (
              <div key={m.measureName} className="mb-2">
                <CodeBlock code={`${m.measureName} = ${m.dax}`} lang="dax" />
                <p className="text-[10px] text-muted-foreground mt-1">Confidence: {m.confidence} | Source: {m.qlikExpression}</p>
              </div>
            )) : <p className="text-xs text-muted-foreground">No DAX measures for this table.</p>}
          </div>
          <div className="surface-card p-4">
            <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Calculated Columns</h5>
            <p className="text-xs text-muted-foreground">{p.calculatedColumns.join(", ") || "None"}</p>
          </div>
          <div className="surface-card p-4">
            <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Filters</h5>
            <p className="text-xs text-muted-foreground">{p.filters.join(", ") || "None"}</p>
          </div>
          {valIssues.length > 0 && (
            <div className="surface-card p-4">
              <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Validation Issues</h5>
              {valIssues.map((iss, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-amber-400 mb-1">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />{iss.severity} | {iss.area}: {iss.message}
                </div>
              ))}
            </div>
          )}
          {p.reviewNotes.length > 0 && (
            <div className="surface-card p-4">
              <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Manual Review Notes</h5>
              {p.reviewNotes.map((n, i) => <p key={i} className="text-xs text-muted-foreground">{n}</p>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 5 — M Query & Data Types
// ────────────────────────────────────────────────────────────────

function TabMQueryDataTypes({
  analysis, columnTypeEdits, onTypeChange, onApplyTypes, applyingTypes, onAnalysisUpdate
}: {
  analysis: EnterpriseAnalysis;
  columnTypeEdits: Record<string, string>;
  onTypeChange: (key: string, val: string) => void;
  onApplyTypes: () => void;
  applyingTypes: boolean;
  onAnalysisUpdate: (newAnalysis: EnterpriseAnalysis) => void;
}) {
  const { businessMetadata, technicalMetadata, ruleBookMd, sourceQvsText, etlQvsText } = useMigration();
  const [generatingAi, setGeneratingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiQueries, setAiQueries] = useState<Record<string, string> | null>(null);

  const handleAiGenerate = async () => {
    if (!businessMetadata || !technicalMetadata || !ruleBookMd) {
      setAiError("AI Lineage Analysis (Step 5 below) must be completed first to use the AI Query Engine.");
      return;
    }
    setGeneratingAi(true);
    setAiError(null);
    try {
      const aiOutput = await generatePowerQueryViaAi(businessMetadata, technicalMetadata, ruleBookMd, sourceQvsText, etlQvsText, analysis.sourceMappings);
      const newMQueries: Record<string, string> = {};
      aiOutput.forEach(q => {
        if (q.table && q.code) {
          newMQueries[q.table] = q.code;
        }
      });
      setAiQueries(newMQueries);
      onAnalysisUpdate({ ...analysis, mQueries: { ...analysis.mQueries, ...newMQueries } });
    } catch (e) {
      setAiError("Failed to generate M Query: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setGeneratingAi(false);
    }
  };

  const mq = aiQueries || {};
  const [activeTable, setActiveTable] = useState(0);
  const tables = Object.keys(mq).sort();
  const [tableFilter, setTableFilter] = useState("All");
  const diag = analysis.mQueryDiagnostics || [];

  const downloadAll = () => {
    const txt = combinedMQueriesText(mq);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" }));
    a.download = "power-query.m";
    a.click();
  };

  return (
    <div className="space-y-5">
      <div className="surface-card p-6 border border-border">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
          <div>
            <h3 className="font-display text-xl font-semibold">Generated Power Query M</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Unroll mapped lineage structures into production-ready Power Query scripts. No templates are utilized.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!aiQueries && (
              <button onClick={handleAiGenerate} disabled={generatingAi} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium shadow-sm hover:opacity-90 disabled:opacity-50 transition-all">
                {generatingAi ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {generatingAi ? "Compiling..." : "Generate M Query"}
              </button>
            )}
            {aiQueries && (
              <>
                <button onClick={handleAiGenerate} disabled={generatingAi} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20 disabled:opacity-50">
                  {generatingAi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Regenerate
                </button>
                <button onClick={downloadAll} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-surface-elevated">
                  <Download className="h-3.5 w-3.5" /> Download All (.txt)
                </button>
              </>
            )}
          </div>
        </div>
        
        {aiError && (
          <div className="mb-4 p-3 rounded-lg border border-destructive/30 bg-destructive/5 text-xs flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
            <div className="text-destructive/90">{aiError}</div>
          </div>
        )}

        {aiQueries && (
          <>
            <div className="flex gap-1 overflow-x-auto pb-3 border-b border-border mb-3">
              {tables.map((t, i) => (
                <button key={t} onClick={() => setActiveTable(i)}
                  className={cn("px-4 py-2 text-sm font-medium rounded-lg whitespace-nowrap transition-all",
                    activeTable === i ? "bg-primary text-primary-foreground shadow-sm" : "border border-border text-muted-foreground hover:text-foreground hover:bg-surface-elevated")}>
                  {t}
                </button>
              ))}
            </div>
            {tables[activeTable] && <CodeBlock code={mq[tables[activeTable]] || ""} />}
          </>
        )}
      </div>

      <div className="surface-card p-4">
        <SectionHeader title="M Query Static Diagnostics" sub="Pre-flight checks before Power BI Desktop open" />
        <DataTable rows={diag} />
      </div>


    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 6 — DAX Measures
// ────────────────────────────────────────────────────────────────

function TabDaxMeasures({ analysis }: { analysis: EnterpriseAnalysis }) {
  const rows = analysis.daxMeasures.map(m => ({
    Measure: m.measureName, DAX: m.dax, "Source Qlik Expression": m.qlikExpression,
    Table: m.table, Confidence: m.confidence, Notes: m.notes, Warning: m.warning, Source: m.source,
  }));
  return (
    <div className="surface-card p-4 space-y-8">
      <div>
        <SectionHeader title="Consolidated DAX Measures" sub="Aggregations auto-translated from Qlik to DAX" />
        {rows.length ? <DataTable rows={rows} /> : <p className="text-xs text-muted-foreground">No aggregation expressions converted.</p>}
      </div>
      
      <div className="border-t border-border pt-6">
        <BulkMeasureTranslator />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 7 — Semantic Model & Relationships
// ────────────────────────────────────────────────────────────────

function TabSemanticModel({ analysis }: { analysis: EnterpriseAnalysis }) {
  const rels = analysis.relationships.map(r => ({
    Status: r.status, Active: r.active ? "Yes" : "No",
    From: `${r.fromTable}[${r.fromColumn}]`, To: `${r.toTable}[${r.toColumn}]`,
    Score: r.score, Confidence: r.confidence, Reason: r.reason,
  }));
  const tableRows = analysis.finalTables.map(p => ({
    Table: p.table, Role: tableRole(p), Classification: p.classification,
    Fields: p.fields.length, Confidence: p.confidence,
  }));
  return (
    <div className="space-y-5">
      <div className="surface-card p-4">
        <SectionHeader title="Model Tables" />
        <DataTable rows={tableRows} />
      </div>
      <div className="surface-card p-4">
        <SectionHeader title="Relationship Candidates" sub="Inferred from shared field names. Active = included in model.bim." />
        <DataTable rows={rels} />
      </div>
      <div className="surface-card p-4">
        <SectionHeader title="Semantic Model JSON" />
        <CodeBlock code={JSON.stringify(analysis.semanticModel, null, 2)} lang="json" />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 8 — Validation Report
// ────────────────────────────────────────────────────────────────

function TabValidation({ analysis }: { analysis: EnterpriseAnalysis }) {
  const v = analysis.validation;
  const issueRows = v.issues.map(i => ({
    Severity: i.severity, Area: i.area, Object: i.objectName, Message: i.message, Fix: i.recommendation,
  }));
  const diagRows = (v.desktopDiagnostics || []);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <MetricCard label="PBIP Readiness" value={v.isReadyForPbipExport ? "✓ Ready" : "✗ Blocked"} />
        <MetricCard label="Errors" value={v.errorCount} />
        <MetricCard label="Warnings" value={v.warningCount} />
      </div>

      {v.isReadyForPbipExport ? (
        <div className="surface-card p-4 border border-green-500/20 bg-green-500/5 flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-green-400" />
          <p className="text-sm text-green-400">PBIP export validation passed. The generated project uses safe M queries and all source mappings are confirmed.</p>
        </div>
      ) : (
        <div className="surface-card p-4 border border-red-500/20 bg-red-500/5 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">PBIP export is blocked. Fix validation errors, especially unresolved source mappings.</p>
        </div>
      )}

      <div className="surface-card p-4">
        <SectionHeader title="Validation Issues" />
        {issueRows.length ? <DataTable rows={issueRows} /> : <p className="text-xs text-green-400">No validation issues found.</p>}
      </div>

      <div className="surface-card p-4">
        <SectionHeader title="Power BI Desktop Openability Diagnostics" sub="Pre-flight checks simulating what Power BI Desktop verifies on open" />
        {diagRows.length ? <DataTable rows={diagRows as Record<string, unknown>[]} /> : <p className="text-xs text-muted-foreground">No diagnostics generated.</p>}
      </div>

      <div className="surface-card p-4">
        <div className="flex items-center justify-between mb-3">
          <SectionHeader title="Migration Report" />
          <button
            onClick={() => {
              const blob = new Blob([analysis.migrationReport], { type: "text/markdown" });
              const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
              a.download = "QLIK2PBI_migration_report.md"; a.click();
            }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-surface-elevated">
            <Download className="h-3.5 w-3.5" /> Download (.md)
          </button>
        </div>
        <pre className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap max-h-72 overflow-auto">{analysis.migrationReport.slice(0, 6000)}</pre>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 9 — PBIP Export (client-side JSON download)
// ────────────────────────────────────────────────────────────────

function TabPbipExport({ analysis }: { analysis: EnterpriseAnalysis }) {
  const ready = analysis.validation.isReadyForPbipExport;
  const [name, setName] = useState("QLIK2PBI_Migration_Project");

  const handleDownloadJson = () => {
    const payload = {
      model: analysis.semanticModel,
      mQueries: analysis.mQueries,
      daxMeasures: analysis.daxMeasures,
      relationships: analysis.relationships,
      validation: analysis.validation,
      migrationReport: analysis.migrationReport,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `${name}_full_analysis.json`; a.click();
  };

  const handleDownloadMQueries = () => {
    const txt = combinedMQueriesText(analysis.mQueries);
    const blob = new Blob([txt], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `${name}_M_QUERIES.txt`; a.click();
  };

  return (
    <div className="space-y-5">
      {ready ? (
        <div className="surface-card p-4 border border-green-500/20 bg-green-500/5 flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-green-400" />
          <p className="text-sm text-green-400">PBIP export validation passed. Download the migration package below.</p>
        </div>
      ) : (
        <div className="surface-card p-4 border border-amber-500/20 bg-amber-500/5 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-400">PBIP export is blocked. Complete source mapping and fix all validation errors first.</p>
        </div>
      )}

      <div className="surface-card p-4">
        <SectionHeader title="Export Settings" />
        <label className="text-xs text-muted-foreground">Project Name</label>
        <input type="text" value={name} onChange={e => setName(e.target.value)}
          className="mt-1 w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-foreground" />
      </div>

      <div className="surface-card p-4 space-y-3">
        <SectionHeader title="Downloads" sub="Export your migration artifacts" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button onClick={handleDownloadMQueries}
            className="flex items-center gap-2 px-4 py-3 rounded-xl border border-border text-sm font-medium hover:bg-surface-elevated">
            <FileText className="h-4 w-4 text-primary" />
            <div className="text-left"><div>Power Query M Scripts</div><div className="text-xs text-muted-foreground">All tables as .txt</div></div>
          </button>
          <button onClick={handleDownloadJson}
            className="flex items-center gap-2 px-4 py-3 rounded-xl border border-border text-sm font-medium hover:bg-surface-elevated">
            <Braces className="h-4 w-4 text-primary" />
            <div className="text-left"><div>Full Analysis JSON</div><div className="text-xs text-muted-foreground">Model + DAX + relationships</div></div>
          </button>
        </div>
        <p className="text-xs text-muted-foreground bg-surface-elevated/50 p-3 rounded-lg">
          💡 <strong>To use in Power BI Desktop:</strong> Create a blank query, open Advanced Editor, paste the M query for each table, and click Done. 
          Use the semantic model JSON to manually recreate relationships and measures if needed.
          Full PBIP file generation requires the Python backend (run locally via <code>streamlit run app.py</code>).
        </p>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// TAB 10 — Logs / JSON
// ────────────────────────────────────────────────────────────────

function TabLogs({ analysis }: { analysis: EnterpriseAnalysis }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const sections = [
    { key: "variables", label: "Variables", data: analysis.variables },
    { key: "connections", label: "Connections", data: analysis.connections },
    { key: "sourceCatalog", label: "Source Catalog", data: analysis.sourceCatalog },
    { key: "columnTypes", label: "Column Types", data: analysis.columnTypes },
    { key: "columnTypeMeta", label: "Column Type Inference Metadata", data: analysis.columnTypeMeta },
    { key: "semanticModel", label: "Semantic Model JSON", data: analysis.semanticModel },
  ];
  return (
    <div className="space-y-3">
      <div className="surface-card p-4">
        <h5 className="text-xs font-semibold text-foreground/70 uppercase tracking-wide mb-2">Pipeline Logs</h5>
        {analysis.logs.map((l, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground py-1 border-b border-border/30">
            <Check className="h-3.5 w-3.5 text-green-400 mt-0.5 shrink-0" />{l}
          </div>
        ))}
      </div>
      {sections.map(({ key, label, data }) => (
        <div key={key} className="surface-card overflow-hidden">
          <button onClick={() => setExpanded(expanded === key ? null : key)}
            className="w-full flex items-center justify-between p-4 text-sm font-medium text-foreground hover:bg-surface-elevated/50">
            {label}
            {expanded === key ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {expanded === key && (
            <div className="border-t border-border p-4">
              <CodeBlock code={JSON.stringify(data, null, 2)} lang="json" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Main Component
// ────────────────────────────────────────────────────────────────

const TABS = [
  { id: "summary",     label: "Summary",        icon: BarChart3 },
  { id: "mapping",     label: "Source Mapping", icon: Database },
  { id: "all-tables",  label: "All Tables",     icon: Table2 },
  { id: "final",       label: "Final Tables",   icon: Layers },
  { id: "mquery",      label: "M Query & Types",icon: FileText },
  { id: "dax",         label: "DAX Measures",   icon: GitBranch },
  { id: "model",       label: "Semantic Model", icon: Network },
  { id: "validation",  label: "Validation",     icon: ShieldCheck },
  { id: "export",      label: "PBIP Export",    icon: Download },
  { id: "logs",        label: "Logs / JSON",    icon: Braces },
];

export function EnterpriseAnalysisPanel({ files, onAnalysisComplete }: { files: ExtractedFile[], onAnalysisComplete: () => void }) {
  const [analysis, setAnalysis] = useState<EnterpriseAnalysis | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("summary");
  const [completedStages, setCompletedStages] = useState<Set<string>>(new Set());

  // Mapping state
  const [mappingRows, setMappingRows] = useState<MappingRow[]>([]);
  const [mappingUpdates, setMappingUpdates] = useState<Record<string, { mappedRef?: string; connectorType?: string; status?: string; notes?: string }>>({});
  const [applying, setApplying] = useState(false);

  // Type edits
  const [columnTypeEdits, setColumnTypeEdits] = useState<Record<string, string>>({});
  const [applyingTypes, setApplyingTypes] = useState(false);

  const runAnalysis = useCallback(async (mupdates = mappingUpdates, typeEdits = columnTypeEdits) => {
    const projectFiles = toProjectFiles(files);
    if (!projectFiles.length) { setError("No text files could be extracted from the uploaded files."); return; }
    setRunning(true); setError(null);
    try {
      // Run in a microtask to allow UI to update
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const result = runEnterpriseAnalysis(projectFiles, mupdates, typeEdits);
      setAnalysis(result);
      setMappingRows(result.sourceMappings.map(m => ({
        originalRef: m.originalRef, mappedRef: m.mappedRef, connectorType: m.connectorType,
        status: m.status, notes: m.notes, table: m.table, sourceRole: m.sourceRole,
        bypassQvd: m.bypassQvd, effectiveRef: m.effectiveRef, qvdProducerTable: m.qvdProducerTable,
      })));
      onAnalysisComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enterprise analysis failed.");
    } finally { setRunning(false); }
  }, [files, mappingUpdates, columnTypeEdits]);

  const handleApplyMapping = useCallback(async () => {
    setApplying(true);
    const newUpdates = rowsToUpdates(mappingRows.map(r => ({
      original_ref: r.originalRef, mapped_ref: r.mappedRef, connector_type: r.connectorType,
      status: r.status, notes: r.notes, bypass_qvd: r.bypassQvd ? "true" : "false",
    })));
    setMappingUpdates(newUpdates);
    await runAnalysis(newUpdates, columnTypeEdits);
    setApplying(false);
  }, [mappingRows, columnTypeEdits, runAnalysis]);

  const handleApplyTypes = useCallback(async () => {
    setApplyingTypes(true);
    await runAnalysis(mappingUpdates, columnTypeEdits);
    setApplyingTypes(false);
  }, [mappingUpdates, columnTypeEdits, runAnalysis]);

  if (!analysis && !running && !error) {
    return (
      <div className="surface-card p-8 flex flex-col items-center text-center gap-4">
        <div className="grid h-16 w-16 place-items-center rounded-2xl bg-accent">
          <Database className="h-7 w-7 text-primary" />
        </div>
        <div>
          <h3 className="font-display text-xl font-semibold">Enterprise Migration Workbench</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Run the full 10-stage Qlik → Power BI enterprise analysis engine. Parses your QVS scripts, 
            detects final tables, maps sources, generates Power Query M, infers relationships, and validates for PBIP export.
          </p>
        </div>
        <button
          onClick={() => runAnalysis()}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-medium text-sm shadow-lg hover:opacity-90 transition-opacity"
        >
          <Database className="h-4 w-4" /> Run Enterprise Analysis
        </button>
      </div>
    );
  }

  if (running) {
    return (
      <div className="surface-card p-12 flex flex-col items-center gap-4">
        <Loader2 className="h-10 w-10 text-primary animate-spin" />
        <div className="text-center">
          <h3 className="font-display text-lg font-semibold">Running Enterprise Pipeline…</h3>
          <p className="text-sm text-muted-foreground mt-1">Parsing QVS, classifying tables, generating M queries, inferring relationships…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="surface-card p-6 border border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-sm">Analysis Failed</div>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </div>
        </div>
        <button onClick={() => runAnalysis()} className="mt-4 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium">
          Retry
        </button>
      </div>
    );
  }

  if (!analysis) return null;

  const val = analysis.validation;

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="surface-card p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent">
            <Database className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-base">Enterprise Migration Workbench</h3>
            <p className="text-xs text-muted-foreground">
              {analysis.finalTables.length} final tables · {analysis.sourceMappings.length} sources · {val.isReadyForPbipExport ? "✓ PBIP Ready" : "✗ Blocked"}
            </p>
          </div>
        </div>
        <button onClick={() => runAnalysis()} className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-surface-elevated">
          <RefreshCw className="h-3.5 w-3.5" /> Re-run
        </button>
      </div>

      {/* Vertical Stepper / Accordion Wizard */}
      <div className="flex flex-col gap-3">
        {TABS.map(({ id, label, icon: Icon }, index) => {
          const isExpanded = activeTab === id;
          const isCompleted = completedStages.has(id);
          
          return (
            <div key={id} className={cn("surface-card rounded-xl border transition-all", isExpanded ? "border-primary/50 shadow-md ring-1 ring-primary/20" : "border-border hover:border-border/80")}>
              {/* Accordion Header */}
              <button 
                onClick={() => setActiveTab(isExpanded ? "" : id)}
                className="w-full flex items-center justify-between p-4 focus:outline-none"
              >
                <div className="flex items-center gap-4">
                  <div className={cn("grid h-10 w-10 place-items-center rounded-full transition-colors", 
                    isCompleted ? "bg-success/15 text-success" : (isExpanded ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground")
                  )}>
                    {isCompleted ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                  </div>
                  <div className="text-left">
                    <div className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-0.5">Stage {index + 1}</div>
                    <div className={cn("font-semibold text-sm transition-colors", isExpanded ? "text-foreground" : "text-foreground/80")}>{label}</div>
                  </div>
                </div>
                <div>
                  {isExpanded ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
                </div>
              </button>

              {/* Accordion Content */}
              {isExpanded && (
                <div className="border-t border-border bg-surface-elevated/20 p-4 rounded-b-xl animate-in slide-in-from-top-2 duration-200">
                  <div className="mb-6">
                    {id === "summary"    && <TabSummary analysis={analysis} />}
                    {id === "mapping"    && <TabSourceMapping analysis={analysis} mappingRows={mappingRows} onMappingChange={setMappingRows} onApply={handleApplyMapping} applying={applying} />}
                    {id === "all-tables" && <TabAllTables analysis={analysis} />}
                    {id === "final"      && <TabFinalTables analysis={analysis} />}
                    {id === "mquery"     && <TabMQueryDataTypes analysis={analysis} columnTypeEdits={columnTypeEdits} onTypeChange={(k, v) => setColumnTypeEdits(p => ({ ...p, [k]: v }))} onApplyTypes={handleApplyTypes} applyingTypes={applyingTypes} onAnalysisUpdate={setAnalysis} />}
                    {id === "dax"        && <TabDaxMeasures analysis={analysis} />}
                    {id === "model"      && <TabSemanticModel analysis={analysis} />}
                    {id === "validation" && <TabValidation analysis={analysis} />}
                    {id === "export"     && <TabPbipExport analysis={analysis} />}
                    {id === "logs"       && <TabLogs analysis={analysis} />}
                  </div>
                  
                  {/* Footer Action */}
                  <div className="flex justify-end pt-4 border-t border-border mt-4">
                    <button 
                      onClick={() => {
                        const newCompleted = new Set(completedStages);
                        newCompleted.add(id);
                        setCompletedStages(newCompleted);
                        // Move to next tab if available
                        if (index < TABS.length - 1) {
                          setActiveTab(TABS[index + 1].id);
                        } else {
                          setActiveTab("");
                        }
                      }}
                      className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 shadow-sm transition-opacity"
                    >
                      <Check className="h-4 w-4" />
                      {index < TABS.length - 1 ? "Mark Complete & Continue" : "Finish Review"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
