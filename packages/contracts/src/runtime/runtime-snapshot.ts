export interface RuntimeSnapshot {
  readonly id: string;
  readonly coreVersion: string;
  readonly pluginSetId: string;
  readonly policyRevision: string;
  readonly memoryPolicyRevision: string;
  readonly createdAt: string;
}
