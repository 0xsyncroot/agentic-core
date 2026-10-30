export type CapabilityId = `${string}@${number}`;
export type CapabilityCardinality = "single" | "multi";

export interface CapabilityToken<T> {
  readonly id: CapabilityId;
  readonly version: string;
  readonly cardinality: CapabilityCardinality;
  readonly protected: boolean;
  readonly __type?: T;
}

export function capabilityToken<T>(definition: Omit<CapabilityToken<T>, "__type">): CapabilityToken<T> {
  return Object.freeze(definition);
}
