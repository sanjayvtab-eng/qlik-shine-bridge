export type SourcePlatform =
  | "SQL Server" | "Oracle" | "MySQL" | "PostgreSQL" | "Snowflake"
  | "Databricks" | "Excel" | "CSV" | "Parquet" | "JSON" | "XML"
  | "SAP" | "REST API" | "QVD" | "Unknown";

export interface SourceColumn {
  name: string;
  dataType: string;
}

export interface SourceTable {
  id: string;
  name: string;
  platform: SourcePlatform;
  database?: string;
  schema?: string;
  connectionPath?: string;
  connectionName?: string;
  sourceQuery?: string;
  connectorExpression?: string;
  qvdName?: string;
  filePath?: string;
  columns: SourceColumn[];
}

export interface EtlOperation {
  kind: "LOAD" | "RESIDENT" | "JOIN" | "KEEP" | "CONCATENATE" | "APPLYMAP" | "MAPPING" | "STORE" | "DROP" | "RENAME_TABLE" | "RENAME_FIELD";
  table?: string;
  target?: string;
  detail?: string;
  raw: string;
}

export type TableStep =
  | { kind: "LOAD"; from: string; fields: { name: string; expr?: string }[]; where?: string; platform?: string; connectionName?: string; sourceQuery?: string; connectorExpression?: string }
  | { kind: "RESIDENT"; from: string; fields: { name: string; expr?: string }[]; where?: string }
  | { kind: "JOIN"; joinType: "Left" | "Right" | "Inner" | "Outer"; withTable: string; withFields: string[]; keyFields?: string[]; resident?: string; fromClause?: string; connectionName?: string; sourceQuery?: string; platform?: string }
  | { kind: "KEEP"; joinType: "Left" | "Right" | "Inner"; withTable: string }
  | { kind: "CONCATENATE"; withTable: string; withFields: string[]; resident?: string; fromClause?: string; connectionName?: string; sourceQuery?: string; platform?: string }
  | { kind: "APPLYMAP"; mapName: string; sourceField: string; asField: string; defaultValue?: string }
  | { kind: "DERIVED"; name: string; expression: string }
  | { kind: "RENAME_FIELD"; from: string; to: string }
  | { kind: "DROP_FIELD"; field: string };

export interface FinalTable {
  id: string;
  name: string;
  type: "Fact" | "Dimension" | "Calendar" | "Bridge" | "Mapping";
  columns: { name: string; dataType: string; derived?: boolean; expression?: string }[];
  sourceTables: string[];
  isFinal: boolean;
  steps?: TableStep[];
  sourcePlatform?: string;
  sourceConnection?: string;
  keys?: string[];
  lineage?: string[];
}


export interface Relationship {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: "1:1" | "1:N" | "N:1" | "N:N";
}

export interface Requirement {
  reportName: string;
  businessRequirement: string;
  businessObjective: string;
  sourceTableNames: string;   // comma/newline separated
  sourceColumnNames: string;  // comma/newline separated
  sampleData: string;
  expectedOutput: string;
}

export interface SetAnalysisRow {
  name: string;
  expression: string;
}

export interface BusinessMetadata {
  reportName: string;
  businessObjective: string;
  businessRequirement: string;
  expectedOutput: string;
  businessRules: string[];
  expectedTables: string[];
  expectedFinalTables: string[];
  expectedColumns: string[];
  expectedRelationships: Relationship[];
}

export interface EtlDependencyNode {
  table: string;
  dependsOn: string[];
  operations: string[];
  isFinal: boolean;
  type: FinalTable["type"];
}

export interface TechnicalMetadata {
  sourceSystems: SourcePlatform[];
  sourceTables: SourceTable[];
  sourceColumns: SourceColumn[];
  allTables: FinalTable[];
  finalTables: FinalTable[];
  finalColumns: SourceColumn[];
  relationships: Relationship[];
  keys: { table: string; columns: string[] }[];
  transformations: EtlOperation[];
  variables: Record<string, string>;
  droppedTables: string[];
  intermediateTables: string[];
  dependencyGraph: EtlDependencyNode[];
}

export interface MigrationValidationIssue {
  id: string;
  severity: "error" | "warning";
  area: "Business Metadata" | "Technical Metadata" | "Power Query";
  message: string;
  detail?: string;
}

export interface MigrationValidationReport {
  checkedAt: string;
  blockingErrors: boolean;
  issues: MigrationValidationIssue[];
}

export interface MigrationMetadata {
  requirement?: Requirement;
  ruleBookMd?: string;
  sourceTables: SourceTable[];
  etlOperations: EtlOperation[];
  allTables: FinalTable[];
  finalTables: FinalTable[];
  relationships: Relationship[];
  variables: Record<string, string>;
  droppedTables: string[];
  intermediateTables: string[];
  setAnalysisRows: SetAnalysisRow[];
  businessMetadata?: BusinessMetadata;
  technicalMetadata?: TechnicalMetadata;
  validationReport?: MigrationValidationReport;
  sourceFileName?: string;
  etlFileName?: string;
  setAnalysisFileName?: string;
  variableLogicFileName?: string;
  stageStatus: Record<number, "pending" | "in-progress" | "complete">;
  stageAccuracy: Record<number, number | null>;
}
