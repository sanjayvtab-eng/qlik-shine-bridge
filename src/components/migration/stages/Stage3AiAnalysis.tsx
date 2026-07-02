import { useState } from "react";
import { useMigration } from "@/lib/migration/store";
import { analyzeQvsScriptsViaAi } from "@/lib/migration/gemini";
import { parseSourceQvs, parseEtlQvs } from "@/lib/migration/qvs-parser";
import { validateMigrationMetadata } from "@/lib/migration/generators";
import { FileDropzone } from "../FileDropzone";
import { Loader2, ShieldCheck, Database, AlertCircle, Check } from "lucide-react";

export function Stage3AiAnalysis({ onNext }: { onNext: () => void }) {
  const { requirement, ruleBookMd, setSourceAnalysis, setEtlAnalysis, setMergedMetadata, setStageStatus } = useMigration();
  
  const [sourceRaw, setSourceRaw] = useState<{ name: string; text: string } | null>(null);
  const [etlRaw, setEtlRaw] = useState<{ name: string; text: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const bothUploaded = !!sourceRaw && !!etlRaw;

  const onSourceFile = (file: File, text: string) => {
    setSourceRaw({ name: file.name, text });
    setComplete(false); setError(null);
  };

  const onEtlFile = (file: File, text: string) => {
    setEtlRaw({ name: file.name, text });
    setComplete(false); setError(null);
  };

  const handleRunScriptAnalysis = async () => {
    if (!requirement || !ruleBookMd || !sourceRaw || !etlRaw) return;
    setLoading(true);
    setError(null);
    setStageStatus(3, "in-progress");

    try {
      // 1. Run local parser structural mapping pass (always succeeds, used as fallback)
      const srcTables = parseSourceQvs(sourceRaw.text) || [];
      const etlRes = parseEtlQvs(etlRaw.text, srcTables);

      // 2. Invoke structured semantic AI extraction
      const aiResponse = await analyzeQvsScriptsViaAi(requirement, ruleBookMd, sourceRaw.text, etlRaw.text);

      // 3. Smart fallback: if AI returned empty tables, use local parser results
      const technicalMetadata = aiResponse.technicalMetadata;
      
      if (!technicalMetadata.sourceTables?.length && srcTables.length) {
        console.warn("[Stage3] AI returned no source tables — falling back to local QVS parser results.");
        technicalMetadata.sourceTables = srcTables;
      }
      
      if (!technicalMetadata.finalTables?.length && etlRes.finalTables?.length) {
        console.warn("[Stage3] AI returned no final tables — falling back to local ETL parser results.");
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
        console.warn("[Stage3] AI returned no execution graph — falling back to local ETL parser results.");
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
      setSourceAnalysis({ sourceTables: srcTables, sourceFileName: sourceRaw.name });
      setEtlAnalysis({ ...etlRes, etlFileName: etlRaw.name });
      
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
      <div className="grid lg:grid-cols-2 gap-6">
        <div>
          <FileDropzone
            accept=".qvs,.txt"
            onFile={onSourceFile}
            label="Upload Source QVS"
            description="Required. Select source connection and staging LOAD layers."
          />
          {sourceRaw && (
            <div className="mt-3 text-xs text-muted-foreground flex items-center gap-1.5 bg-surface-elevated p-2 rounded-lg border border-border">
              <Check className="h-3.5 w-3.5 text-success" /> <span className="font-mono font-medium">{sourceRaw.name}</span> Ingested
            </div>
          )}
        </div>
        <div>
          <FileDropzone
            accept=".qvs,.txt"
            onFile={onEtlFile}
            label="Upload ETL QVS"
            description="Required. Select calculations, Joins, Resident loads, and Drop logic."
          />
          {etlRaw && (
            <div className="mt-3 text-xs text-muted-foreground flex items-center gap-1.5 bg-surface-elevated p-2 rounded-lg border border-border">
              <Check className="h-3.5 w-3.5 text-success" /> <span className="font-mono font-medium">{etlRaw.name}</span> Ingested
            </div>
          )}
        </div>
      </div>

      <div className="surface-card p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h3 className="font-display text-xl font-semibold">AI Lineage Analysis Engine</h3>
          <p className="text-sm text-muted-foreground">Extract deep semantic technical schemas and verify operational constraints via Gemini Pro.</p>
        </div>
        <button
          onClick={handleRunScriptAnalysis}
          disabled={loading || !bothUploaded}
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