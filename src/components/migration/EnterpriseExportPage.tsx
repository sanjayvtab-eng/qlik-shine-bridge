// EnterpriseExportPage - used in /app/semantic-model dedicated route
import type { EnterpriseAnalysis } from "@/lib/migration/enterprise-parser";
import { TabSemanticModel, TabValidation, TabPbipExport } from "./EnterpriseAnalysisPanel";

interface Props {
  analysis: EnterpriseAnalysis;
}

export function EnterpriseExportPage({ analysis }: Props) {
  return (
    <div className="space-y-6">
      <div className="surface-card p-4">
        <h3 className="font-display font-semibold text-lg text-foreground mb-1">Semantic Model &amp; Relationships</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Star-schema model inferred from your Qlik scripts. Review relationships before export.
        </p>
        <TabSemanticModel analysis={analysis} />
      </div>
      <div className="surface-card p-4">
        <h3 className="font-display font-semibold text-lg text-foreground mb-1">Validation Report</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Pre-flight checks validating the generated solution before Power BI export.
        </p>
        <TabValidation analysis={analysis} />
      </div>
      <div className="surface-card p-4">
        <h3 className="font-display font-semibold text-lg text-foreground mb-1">PBIP Export</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Export the migration-ready Power BI PBIP project as a ZIP file.
        </p>
        <TabPbipExport analysis={analysis} />
      </div>
    </div>
  );
}
