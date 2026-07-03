import { create } from "zustand";
import type {
  MigrationMetadata, SourceTable, FinalTable, Relationship, EtlOperation,
  Requirement, SetAnalysisRow, BusinessMetadata, TechnicalMetadata, MigrationValidationReport,
} from "./types";

interface MigrationStore extends MigrationMetadata {
  sourceQvsText?: string;
  etlQvsText?: string;
  reset: () => void;
  setRequirement: (r: Requirement) => void;
  setRuleBook: (md: string) => void;
  setAiMetadata: (data: {
    finalTables: FinalTable[];
    relationships: Relationship[];
    sourceTables?: SourceTable[];
  }) => void;
  setSourceAnalysis: (data: { sourceTables: SourceTable[]; sourceFileName: string; text?: string }) => void;
  updateSourceTable: (id: string, patch: Partial<SourceTable>) => void;
  setEtlAnalysis: (data: {
    etlOperations: EtlOperation[];
    allTables?: FinalTable[];
    finalTables: FinalTable[];
    relationships: Relationship[];
    droppedTables: string[];
    intermediateTables: string[];
    variables: Record<string, string>;
    etlFileName: string;
    text?: string;
  }) => void;
  setMergedMetadata: (data: {
    businessMetadata: BusinessMetadata;
    technicalMetadata: TechnicalMetadata;
    finalTables: FinalTable[];
    relationships: Relationship[];
    validationReport: MigrationValidationReport;
  }) => void;
  setSetAnalysis: (data: { rows: SetAnalysisRow[]; fileName: string }) => void;
  setVariableLogic: (data: { variables: Record<string, string>; fileName: string }) => void;
  setStageStatus: (stage: number, status: "pending" | "in-progress" | "complete", accuracy?: number) => void;
  setVariables: (vars: Record<string, string>) => void;
}

const initial: MigrationMetadata & { sourceQvsText?: string; etlQvsText?: string } = {
  sourceTables: [],
  etlOperations: [],
  allTables: [],
  finalTables: [],
  relationships: [],
  variables: {},
  droppedTables: [],
  intermediateTables: [],
  setAnalysisRows: [],
  businessMetadata: undefined,
  technicalMetadata: undefined,
  validationReport: undefined,
  sourceQvsText: undefined,
  etlQvsText: undefined,
  stageStatus: { 1: "pending", 2: "pending", 3: "pending", 4: "pending", 5: "pending", 6: "pending" },
  stageAccuracy: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
};

export const useMigration = create<MigrationStore>((set) => ({
  ...initial,
  reset: () => set({ ...initial }),
  setRequirement: (requirement) =>
    set((s) => ({ requirement, stageStatus: { ...s.stageStatus, 1: "complete" } })),
  setRuleBook: (ruleBookMd) =>
    set((s) => ({ ruleBookMd, stageStatus: { ...s.stageStatus, 2: "complete" } })),
  setAiMetadata: ({ finalTables, relationships, sourceTables }) =>
    set((s) => ({
      finalTables,
      relationships,
      sourceTables: sourceTables ?? s.sourceTables,
      stageStatus: { ...s.stageStatus, 3: "complete" },
    })),
  setSourceAnalysis: ({ sourceTables, sourceFileName }) =>
    set(() => ({ sourceTables, sourceFileName })),
  updateSourceTable: (id, patch) =>
    set((s) => ({ sourceTables: s.sourceTables.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  setEtlAnalysis: (data) => set(() => ({ ...data })),
  setMergedMetadata: (data) => set(() => ({ ...data })),
  setSetAnalysis: ({ rows, fileName }) =>
    set(() => ({ setAnalysisRows: rows, setAnalysisFileName: fileName })),
  setVariableLogic: ({ variables, fileName }) =>
    set((s) => ({ variables: { ...s.variables, ...variables }, variableLogicFileName: fileName })),
  setStageStatus: (stage, status, accuracy) =>
    set((s) => ({
      stageStatus: { ...s.stageStatus, [stage]: status },
      stageAccuracy: accuracy !== undefined ? { ...s.stageAccuracy, [stage]: accuracy } : s.stageAccuracy,
    })),
  setVariables: (variables) => set({ variables }),
}));
