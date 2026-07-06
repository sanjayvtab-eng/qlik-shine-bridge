import { useState } from "react";
import { useMigration } from "@/lib/migration/store";
import { analyzeQvsScriptsViaAi } from "@/lib/migration/gemini";
import { parseSourceQvs, parseEtlQvs } from "@/lib/migration/qvs-parser";
import { validateMigrationMetadata } from "@/lib/migration/generators";
import { MultiFileDropzone, FileAnalysisPanel } from "../MultiFileDropzone";
import type { ExtractedFile } from "../MultiFileDropzone";
import { Loader2, ShieldCheck, Database, AlertCircle, Check, PackageOpen } from "lucide-react";

export function Stage3AiAnalysis({ onNext }: { onNext: () => void }) {
  const { requirement, ruleBookMd, setSourceAnalysis, setEtlAnalysis, setMergedMetadata, setStageStatus } = useMigration();

  const [allFiles, setAllFiles] = useState<ExtractedFile[]>([]);
  const [selectedSources, setSelectedSources] = useState<ExtractedFile[]>([]);
  const [selectedEtls, setSelectedEtls] = useState<ExtractedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const bothSelected = selectedSources.length > 0 && selectedEtls.length > 0;

  const handleFiles = (files: ExtractedFile[]) => {
    setAllFiles(files);
    setComplete(false);
    setError(null);
    setSelectedSources([]);
    setSelectedEtls([]);

    // Proactive auto-assignment: prefer .qvs files, fall back to any text file
    const textFiles = files.filter((f) => f.parsedAsText);
    const qvsFiles  = textFiles.filter((f) => f.extension === ".qvs");
    const pool      = qvsFiles.length >= 2 ? qvsFiles : textFiles;

    if (pool.length >= 2) {
      const src = pool.find((f) => !/(etl|main|fact|transform)/i.test(f.name)) ?? pool[0];
      const etl = pool.find((f) => f.path !== src.path) ?? pool[1];
      setSelectedSources([src]);
      setSelectedEtls([etl]);
    } else if (pool.length === 1) {
      setSelectedSources([pool[0]]);
    }
  };

  const handleRunScriptAnalysis = async () => {
    if (!requirement || !ruleBookMd || !bothSelected) return;
    setLoading(true);
    setError(null);
    setStageStatus(3, "in-progress");

    try {
      const sourceText = selectedSources.map(f => f.text).join('\n\n');
      const etlText = selectedEtls.map(f => f.text).join('\n\n');

      // 1. Run local parser structural mapping pass (always succeeds, used as fallback)
      const srcTables = parseSourceQvs(sourceText) || [];
      const etlRes = parseEtlQvs(etlText, srcTables);

      // 2. Invoke structured semantic AI extraction with total failover protection
      let aiResponse: any;
      try {
        aiResponse = await analyzeQvsScriptsViaAi(requirement, ruleBookMd, sourceText, etlText);
      } catch (aiErr) {
        console.info("[Stage3] AI engine unavailable (quota exceeded). Proceeding with offline local parsing...");
        aiResponse = {
          businessMetadata: {
            reportName: requirement.reportName || "Offline Fallback",
            businessRequirement: requirement.businessRequirement || "Offline Fallback",
            expectedOutput: requirement.expectedOutput || "Offline Fallback",
            sourceTables: requirement.sourceTableNames ? requirement.sourceTableNames.split(',').map(s => s.trim()) : [],
            finalTables: [], businessRules: []
          },
          technicalMetadata: {
            sourceTables: [], finalTables: [], relationships: [],
            executionGraph: [], allTables: [],
            statementMetrics: { totalLoadStatements: 0, totalJoinStatements: 0, totalResidentLoads: 0, totalApplyMapCalls: 0 }
          }
        };
      }

      // 3. Smart fallback: if AI returned empty tables, use local parser results
      const technicalMetadata = aiResponse.technicalMetadata;

      if (!technicalMetadata.sourceTables?.length && srcTables.length) {
        console.info("[Stage3] AI returned no source tables — falling back to local QVS parser results.");
        technicalMetadata.sourceTables = srcTables;
      }

      if (!technicalMetadata.finalTables?.length && etlRes.finalTables?.length) {
        console.info("[Stage3] AI returned no final tables — falling back to local ETL parser results.");
        technicalMetadata.finalTables = etlRes.finalTables.map(t => ({
          ...t,
          isFinal: true,
          steps: t.steps || [],
          columns: t.columns || [],
          sourceTables: t.sourceTables || [],
        }));
      }

      if (!technicalMetadata.relationships?.length && etlRes.relationships?.length) {
        technicalMetadata.relationships = etlRes.relationships;
      }

      if (!technicalMetadata.executionGraph?.length && etlRes.executionGraph?.length) {
        console.info("[Stage3] AI returned no execution graph — falling back to local ETL parser results.");
        technicalMetadata.executionGraph = etlRes.executionGraph;
      }

      if (!technicalMetadata.allTables?.length && etlRes.allTables?.length) {
        technicalMetadata.allTables = etlRes.allTables;
      }

      // 4. Validate the merged metadata
      const finalValidationReport = validateMigrationMetadata(
        aiResponse.businessMetadata,
        technicalMetadata
      );

      // 5. Update store
      setSourceAnalysis({ sourceTables: srcTables, sourceFileName: selectedSources.map(f => f.name).join(', '), text: sourceText });
      setEtlAnalysis({ ...etlRes, etlFileName: selectedEtls.map(f => f.name).join(', '), text: etlText });

      setMergedMetadata({
        businessMetadata: aiResponse.businessMetadata,
        technicalMetadata,
        finalTables: technicalMetadata.finalTables,
        relationships: technicalMetadata.relationships,
        validationReport: finalValidationReport
      });

      if (finalValidationReport.blockingErrors) {
        setError("AI generated an incomplete or invalid lineage schema. Please click on 'Power Query' (Stage 4) in the top pipeline navigation to view the detailed validation report, or try analyzing again.");
        setStageStatus(3, "pending");
        setComplete(false);
      } else {
        setStageStatus(3, "complete", 100);
        setComplete(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "QVS structural code lineage analysis failed.";
      setError(msg);
      setStageStatus(3, "pending");
    } finally {
      setLoading(false);
    }
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
            <h3 className="font-display text-xl font-semibold">Upload & Extraction Engine</h3>
            <p className="text-sm text-muted-foreground">
              Upload individual QVS/CSV files, a ZIP package, or an entire folder. The engine will extract and analyse all contents automatically.
            </p>
          </div>
        </div>
        <MultiFileDropzone onFiles={handleFiles} />
      </div>

      {/* File Analysis Panel — shown after upload */}
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

      {/* Assigned confirmation chips */}
      {(selectedSources.length > 0 || selectedEtls.length > 0) && (
        <div className="flex flex-col gap-2">
          {selectedSources.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-primary/10 border border-primary/30 text-xs font-mono">
              <Check className="h-3.5 w-3.5 text-primary" />
              <span className="text-primary font-semibold">SOURCE:</span>
              <span className="truncate">{selectedSources.map(s => s.name).join(", ")}</span>
            </div>
          )}
          {selectedEtls.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl bg-warning/10 border border-warning/30 text-xs font-mono">
              <Check className="h-3.5 w-3.5 text-warning" />
              <span className="text-warning font-semibold">ETL:</span>
              <span className="truncate">{selectedEtls.map(e => e.name).join(", ")}</span>
            </div>
          )}
        </div>
      )}

      {/* Analyse button */}
      <div className="surface-card p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h3 className="font-display text-xl font-semibold">AI Lineage Analysis Engine</h3>
          <p className="text-sm text-muted-foreground">
            {bothSelected
              ? `Ready to analyse ${selectedSources.length} source script(s) and ${selectedEtls.length} ETL script(s) via Gemini.`
              : "Assign at least one Source QVS and one ETL QVS from the file panel above to enable analysis."}
          </p>
        </div>
        <button
          onClick={handleRunScriptAnalysis}
          disabled={loading || !bothSelected}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 shadow-sm transition-all hover:opacity-90"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
          {loading ? "Extracting Code Models..." : "Analyze QVS Scripts"}
        </button>
      </div>

      {error && (
        <div className="p-4 rounded-xl border border-destructive/30 bg-destructive/5 text-sm flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div><span className="font-semibold">Analysis Failure:</span> {error}</div>
        </div>
      )}

      {complete && (
        <div className="surface-card p-6 bg-success/5 border-success/20 flex flex-col items-center text-center space-y-3 rounded-2xl">
          <ShieldCheck className="h-10 w-10 text-success" />
          <div className="font-semibold text-lg text-foreground">Code Metadata Generation Complete</div>
          <p className="text-sm text-muted-foreground max-w-md">
            Surviving data schemas, table relationships, and operations are mapped. Stage 4 Power Query generation is unlocked.
          </p>
          <button onClick={onNext} className="mt-2 px-5 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium shadow-sm">
            Proceed to Generate Power Query M
          </button>
        </div>
      )}
    </div>
  );
}