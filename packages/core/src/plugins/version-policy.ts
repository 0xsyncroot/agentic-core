interface SemanticVersion { readonly major: number; readonly minor: number; readonly patch: number }

function parseVersion(value: string): SemanticVersion | undefined {
  const matched = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  return matched ? { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]) } : undefined;
}

function compare(left: SemanticVersion, right: SemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function isSemanticVersion(value: string): boolean {
  return parseVersion(value) !== undefined;
}

export function majorVersion(value: string): number | undefined {
  return parseVersion(value)?.major;
}

export function isMajorCompatible(version: string, range: string): boolean {
  const actual = parseVersion(version);
  const exact = parseVersion(range);
  if (actual && exact) return compare(actual, exact) === 0;
  const minimum = range.startsWith("^") ? parseVersion(range.slice(1)) : undefined;
  if (!actual || !minimum || compare(actual, minimum) < 0) return false;
  if (minimum.major > 0) return actual.major === minimum.major;
  if (minimum.minor > 0) return actual.major === 0 && actual.minor === minimum.minor;
  return actual.major === 0 && actual.minor === 0 && actual.patch === minimum.patch;
}
