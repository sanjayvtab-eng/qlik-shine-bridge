import { useEffect, useMemo } from "react";
import { useMigration } from "@/lib/migration/store";
import { AlertCircle, Maximize2, Calendar, Layers, ArrowRight } from "lucide-react";
import type { FinalTable } from "@/lib/migration/types";

function tableColor(t: FinalTable) {
  if (t.type === "Fact") return "from-primary/90 to-[oklch(0.6_0.2_260)]";
  if (t.type === "Calendar") return "from-[oklch(0.66_0.16_155)] to-[oklch(0.6_0.14_165)]";
  return "from-[oklch(0.65_0.14_220)] to-[oklch(0.55_0.16_240)]";
}

export function Stage6Model({ onNext }: { onNext?: () => void }) {
  const { finalTables, relationships, setStageStatus } = useMigration();

  const allTables: FinalTable[] = useMemo(() => {
    const hasCalendar = finalTables.some((t) => t.type === "Calendar");
    const needsCalendar = !hasCalendar && finalTables.some((t) => t.columns.some((c) => c.dataType === "Date"));
    if (!needsCalendar) return finalTables;
    return [
      ...finalTables,
      {
        id: "calendar_auto",
        name: "Calendar",
        type: "Calendar",
        columns: [
          { name: "Date", dataType: "Date" }, { name: "Year", dataType: "Integer" },
          { name: "Quarter", dataType: "Integer" }, { name: "Month", dataType: "Integer" },
          { name: "MonthName", dataType: "String" }, { name: "Day", dataType: "Integer" },
        ],
        sourceTables: [], isFinal: true,
      },
    ];
  }, [finalTables]);

  useEffect(() => {
    if (!allTables.length) return;
    const facts = allTables.filter((t) => t.type === "Fact").length;
    const dims = allTables.filter((t) => t.type === "Dimension").length;
    const score = facts && dims
      ? Math.round(((relationships.length || 1) / (facts * Math.max(1, dims)) * 50) + 50)
      : 40;
    setStageStatus(5, "complete", Math.min(100, score));
  }, [allTables, relationships, setStageStatus]);



  const facts = allTables.filter((t) => t.type === "Fact");
  const others = allTables.filter((t) => t.type !== "Fact");

  return (
    <div className="space-y-6">
      <div className="surface-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-display text-xl font-semibold">Power BI semantic model</h3>
            <p className="text-sm text-muted-foreground">
              {allTables.length} tables • {relationships.length} relationships • star schema layout
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-surface text-sm font-medium">
              <Maximize2 className="h-4 w-4" /> Full screen
            </button>
            {onNext && (
              <button onClick={onNext} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium">
                DAX Measures <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <ModelPanel title="Qlik Data Model" tables={finalTables} relationships={relationships} variant="qlik" />
        <ModelPanel title="Power BI Data Model" tables={allTables} relationships={relationships} variant="pbi" facts={facts} others={others} />
      </div>
    </div>
  );
}

function ModelPanel({
  title, tables, relationships, variant, facts, others,
}: {
  title: string; tables: FinalTable[]; relationships: any[]; variant: "qlik" | "pbi";
  facts?: FinalTable[]; others?: FinalTable[];
}) {
  return (
    <div className="surface-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface-elevated">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">{title}</span>
        </div>
        <span className="chip text-[10px]">{tables.length} tables</span>
      </div>
      <div className="p-6 min-h-[28rem] bg-[radial-gradient(circle_at_1px_1px,oklch(0.85_0.02_265)_1px,transparent_0)] [background-size:16px_16px]">
        {variant === "pbi" && facts && others ? (
          <div className="relative grid grid-cols-3 gap-4 items-start">
            <div className="space-y-3">
              {others.slice(0, Math.ceil(others.length / 2)).map((t) => <TableNode key={t.id} t={t} />)}
            </div>
            <div className="space-y-3">
              {facts.map((t) => <TableNode key={t.id} t={t} highlight />)}
              {!facts.length && <div className="text-xs text-muted-foreground text-center p-4">No fact tables</div>}
            </div>
            <div className="space-y-3">
              {others.slice(Math.ceil(others.length / 2)).map((t) => <TableNode key={t.id} t={t} />)}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {tables.map((t) => <TableNode key={t.id} t={t} />)}
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-dashed border-border text-xs text-muted-foreground">
          <div className="font-semibold mb-1">Relationships ({relationships.length})</div>
          {relationships.length ? (
            <ul className="space-y-1 font-mono">
              {relationships.slice(0, 6).map((r) => (
                <li key={r.id}>{r.fromTable}[{r.fromColumn}] {r.cardinality} {r.toTable}[{r.toColumn}]</li>
              ))}
            </ul>
          ) : <div className="italic">No relationships auto-detected from shared keys.</div>}
        </div>
      </div>
    </div>
  );
}

function TableNode({ t, highlight }: { t: FinalTable; highlight?: boolean }) {
  return (
    <div className={`rounded-xl overflow-hidden border ${highlight ? "border-primary shadow-elevated" : "border-border"} bg-surface`}>
      <div className={`px-3 py-2 bg-gradient-to-r ${tableColor(t)} text-white flex items-center justify-between`}>
        <div className="flex items-center gap-1.5 font-semibold text-xs">
          {t.type === "Calendar" && <Calendar className="h-3 w-3" />}
          {t.name}
        </div>
        <span className="text-[10px] uppercase tracking-wider opacity-80">{t.type}</span>
      </div>
      <div className="text-[11px] font-mono divide-y divide-border">
        {t.columns.slice(0, 6).map((c) => (
          <div key={c.name} className="flex justify-between px-3 py-1">
            <span className="truncate">{c.name}</span>
            <span className="text-muted-foreground ml-2">{c.dataType}</span>
          </div>
        ))}
        {t.columns.length > 6 && (
          <div className="px-3 py-1 text-muted-foreground italic">+{t.columns.length - 6} more</div>
        )}
      </div>
    </div>
  );
}
