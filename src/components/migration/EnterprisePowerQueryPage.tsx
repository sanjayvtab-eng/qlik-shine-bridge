// EnterprisePowerQueryPage - used in /app/power-query dedicated route
import type { EnterpriseAnalysis } from "@/lib/migration/enterprise-parser";
import { TabMQueryDataTypes, TabFinalTables } from "./EnterpriseAnalysisPanel";

interface Props {
  analysis: EnterpriseAnalysis;
  columnTypeEdits: Record<string, string>;
  onTypeChange: (key: string, val: string) => void;
  onAnalysisUpdate: (analysis: EnterpriseAnalysis) => void;
}

export function EnterprisePowerQueryPage({ analysis, columnTypeEdits, onTypeChange, onAnalysisUpdate }: Props) {
  return (
    <div className="space-y-6">
      <div className="surface-card p-4">
        <h3 className="font-display font-semibold text-lg text-foreground mb-1">Final Tables Overview</h3>
        <p className="text-sm text-muted-foreground mb-4">Review each final table's columns, lineage, and data types before generating M Query code.</p>
        <TabFinalTables analysis={analysis} />
      </div>
      <div className="surface-card p-4">
        <h3 className="font-display font-semibold text-lg text-foreground mb-1">M Query Generation &amp; Data Types</h3>
        <p className="text-sm text-muted-foreground mb-4">Edit Power BI data types, save, then generate optimized M Query (Power Query) code for each table.</p>
        <TabMQueryDataTypes
          analysis={analysis}
          columnTypeEdits={columnTypeEdits}
          onTypeChange={onTypeChange}
          onAnalysisUpdate={onAnalysisUpdate}
        />
      </div>
    </div>
  );
}
