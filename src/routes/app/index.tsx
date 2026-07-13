import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMigration } from "@/lib/migration/store";
import { MultiFileDropzone, FileAnalysisPanel, autoAssignSourceAndEtl } from "@/components/migration/MultiFileDropzone";
import type { ExtractedFile } from "@/components/migration/MultiFileDropzone";
import { analyzeQvsScriptsViaAi, validateQvsScriptsViaAi } from "@/lib/migration/gemini";
import { parseSourceQvs, parseEtlQvs } from "@/lib/migration/qvs-parser";
import { validateMigrationMetadata } from "@/lib/migration/generators";
import { PackageOpen, Check, ArrowRight, Loader2, Database, AlertCircle, ShieldCheck } from "lucide-react";
import type { MigrationValidationReport } from "@/lib/migration/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/")({
  component: UploadPage,
});

function UploadPage() {
  const navigate = useNavigate();
  const {
    setEnterpriseFiles, enterpriseFiles,
    requirement, ruleBookMd, setSourceAnalysis, setEtlAnalysis, setMergedMetadata, setStageStatus,
    businessMetadata, technicalMetadata
  } = useMigration();

  const [allFiles, setAllFiles] = useState<ExtractedFile[]>(enterpriseFiles);
  const [selectedSources, setSelectedSources] = useState<ExtractedFile[]>([]);
  const [selectedEtls, setSelectedEtls] = useState<ExtractedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scriptErrors, setScriptErrors] = useState<{ file: string; message: string }[]>([]);
  const [complete, setComplete] = useState(!!businessMetadata && !!technicalMetadata);
  const [validationReport, setValidationReport] = useState<MigrationValidationReport | null>(null);

  const bothSelected = selectedSources.length > 0 && selectedEtls.length > 0;
  const canAnalyze = bothSelected;

  const handleFiles = (files: ExtractedFile[]) => {
    setAllFiles(files);
    setComplete(false);
    setError(null);
    setScriptErrors([]);
    setSelectedSources([]);
    setSelectedEtls([]);

    const autoAssigned = autoAssignSourceAndEtl(files);
    setSelectedSources(autoAssigned.sources);
    setSelectedEtls(autoAssigned.etls);
  };

  const handleRunScriptAnalysis = async () => {
    if (!bothSelected) return;
    setLoading(true);
    setError(null);
    setScriptErrors([]);
    setValidationReport(null);
    setStageStatus(3, "in-progress");

    const syntaxErrors = await validateQvsScriptsViaAi([...selectedSources, ...selectedEtls]);
    if (syntaxErrors && syntaxErrors.length > 0) {
      setScriptErrors(syntaxErrors);
      setStageStatus(3, "pending");
      setLoading(false);
      return;
    }

    try {
      const sourceText = selectedSources.map(f => f.text).join('\n\n');
      const etlText = selectedEtls.map(f => f.text).join('\n\n');

      // 1. Run local parser structural mapping pass (always succeeds, used as fallback)
      const srcTables = parseSourceQvs(sourceText) || [];
      const etlRes = parseEtlQvs(etlText, srcTables);

      // 2. Invoke structured semantic AI extraction with fallback strings for missing manual inputs
      const safeReq = requirement || { reportName: "Migration", businessObjective: "Migrate Qlik to PBI", businessRequirement: "Auto migration" } as any;
      const safeRb = ruleBookMd || "# Rule Book\n- Extract metadata\n- Convert scripts\n";
      const aiResponse = await analyzeQvsScriptsViaAi(safeReq, safeRb, sourceText, etlText, { srcTables, etlRes });
      const technicalMeta = aiResponse.technicalMetadata;

      // 4. Validate the merged metadata
      const finalValidationReport = validateMigrationMetadata(
        aiResponse.businessMetadata,
        technicalMeta
      );

      // 5. Update store
      setSourceAnalysis({ sourceTables: srcTables, sourceFileName: selectedSources.map(f => f.name).join(', '), text: sourceText });
      setEtlAnalysis({ ...etlRes, etlFileName: selectedEtls.map(f => f.name).join(', '), text: etlText });

      setMergedMetadata({
        businessMetadata: aiResponse.businessMetadata,
        technicalMetadata: technicalMeta,
        finalTables: technicalMeta.finalTables,
        relationships: technicalMeta.relationships,
        validationReport: finalValidationReport
      });

      setValidationReport(finalValidationReport);
      setEnterpriseFiles(allFiles); // Save files to global store here

      setStageStatus(3, "complete", 100);
      setComplete(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "QVS structural code lineage analysis failed.";
      setError(msg);
      setStageStatus(3, "pending");
    } finally {
      setLoading(false);
    }
  };

  const handleNext = () => {
    setEnterpriseFiles(allFiles);
    navigate({ to: "/app/analysis" });
  };

  return (
    <div className="space-y-6">
      {/* Upload Section */}
      <div className="surface-card p-6 space-y-4">
        <div className="flex items-start gap-4 mb-2">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-accent text-primary shrink-0">
            <PackageOpen className="h-5 w-5" />
          </div>
          <div>
            <h3 className="font-display text-xl font-semibold">Upload &amp; Extraction Engine</h3>
            <p className="text-sm text-muted-foreground">
              Upload individual QVS/CSV files, a ZIP package, or an entire folder. The engine will extract and analyse all contents automatically.
            </p>
          </div>
        </div>
        <MultiFileDropzone onFiles={handleFiles} />
      </div>

      {/* File Analysis Panel */}
      {allFiles.length > 0 && (
        <FileAnalysisPanel
          files={allFiles}
          selectedSources={selectedSources}
          selectedEtls={selectedEtls}
          onToggleSource={(f) => {
            setSelectedSources(prev => prev.some(p => p.path === f.path) ? prev.filter(p => p.path !== f.path) : [...prev, f]);
            setComplete(false);
          }}
          onToggleEtl={(f) => {
            setSelectedEtls(prev => prev.some(p => p.path === f.path) ? prev.filter(p => p.path !== f.path) : [...prev, f]);
            setComplete(false);
          }}
        />
      )}

      {/* Analyse button */}
      {allFiles.length > 0 && (
        <div className="surface-card p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h3 className="font-display text-xl font-semibold">AI Lineage Analysis Engine</h3>
            <p className="text-sm text-muted-foreground">
              {canAnalyze
                ? `Ready to analyse ${selectedSources.length} source and ${selectedEtls.length} ETL script(s) via Gemini Flash.`
                : "Select at least 1 Source and 1 ETL script to enable analysis."}
            </p>
          </div>
          <button
            onClick={handleRunScriptAnalysis}
            disabled={!canAnalyze || loading || complete}
            className={cn(
              "flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold text-sm shadow-lg transition-all min-w-[220px]",
              complete
                ? "bg-success text-success-foreground"
                : canAnalyze
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "bg-surface-elevated text-muted-foreground cursor-not-allowed"
            )}
          >
            {loading ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Analysing Lineage…</>
            ) : complete ? (
              <><Check className="h-4 w-4" /> Analysis Complete</>
            ) : (
              <><Database className="h-4 w-4" /> Analyse QVS Scripts</>
            )}
          </button>
        </div>
      )}

      {error && (
        <div className="surface-card p-6 border border-destructive/30 bg-destructive/5 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold text-sm text-destructive">Lineage Engine Error</div>
            <p className="text-xs text-destructive/80 mt-1">{error}</p>
          </div>
        </div>
      )}

      {scriptErrors.length > 0 && (
        <div className="surface-card p-6 border border-amber-500/30 bg-amber-500/5">
          <div className="flex items-start gap-3 mb-4">
            <AlertCircle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display text-base font-semibold text-amber-500">Syntax or Query Validation Failed</h3>
              <p className="text-sm text-amber-500/80 mt-0.5">
                The engine detected invalid or negative queries in your scripts. Please fix them before proceeding.
              </p>
            </div>
          </div>
          <div className="space-y-2 mt-4">
            {scriptErrors.map((err, idx) => (
              <div key={idx} className="p-3 rounded-lg bg-surface/50 border border-border text-xs flex flex-col">
                <span className="font-semibold text-foreground mb-1">{err.file}</span>
                <span className="text-muted-foreground font-mono">{err.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {validationReport && (
        <div className="surface-card p-6 border border-primary/20 bg-primary/5">
          <div className="flex items-start gap-3 mb-4">
            <ShieldCheck className="h-5 w-5 text-primary shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display text-base font-semibold">AI Metadata Extraction Complete</h3>
              <p className="text-sm text-muted-foreground mt-0.5">
                The AI successfully correlated the QVS structural AST with the business requirements.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
            <div className="p-4 rounded-xl bg-surface/50 border border-border">
              <div className="text-2xl font-black mb-1 gradient-text">{technicalMetadata?.finalTables.length || 0}</div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Final Tables</div>
            </div>
            <div className="p-4 rounded-xl bg-surface/50 border border-border">
              <div className="text-2xl font-black mb-1 gradient-text">{technicalMetadata?.relationships.length || 0}</div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Relationships</div>
            </div>
            <div className="p-4 rounded-xl bg-surface/50 border border-border">
              <div className="text-2xl font-black mb-1 gradient-text">{technicalMetadata?.relationships.length || 0}</div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">DAX Requirements</div>
            </div>
            <div className="p-4 rounded-xl bg-surface/50 border border-border">
              <div className="text-2xl font-black mb-1 gradient-text">{Math.max(0, 100 - (validationReport.issues?.length || 0) * 5)}/100</div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Confidence</div>
            </div>
          </div>
        </div>
      )}

      {/* Next Button */}
      <div className="flex justify-end pt-4">
        <button
          onClick={handleNext}
          disabled={!complete}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm shadow-lg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          Proceed to Enterprise Analysis <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
