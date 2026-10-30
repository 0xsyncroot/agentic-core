/** One step of a result path: a key, any key (`*`), any depth (`**`), or each item of an array (`[]`). */
export type PathStep = { readonly key: string } | { readonly any: "key" | "depth" } | { readonly each: true };

/** Parses `a.b[].c`, `**.people[].label`, `rows[]`; an empty segment or a stray bracket is refused. */
export function parsePath(path: string): readonly PathStep[] {
  const steps: PathStep[] = [];
  for (const segment of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\])*)$/u.exec(segment);
    if (!match || (match[1] === "" && match[2] === "")) throw new Error(`invalid path ${JSON.stringify(path)}`);
    const name = match[1] ?? "";
    if (name === "*") steps.push({ any: "key" });
    else if (name === "**") steps.push({ any: "depth" });
    else if (name !== "") steps.push({ key: name });
    for (let index = 0; index < (match[2] ?? "").length / 2; index += 1) steps.push({ each: true });
  }
  return steps;
}

function children(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return value !== null && typeof value === "object" ? Object.values(value) : [];
}

function walk(value: unknown, steps: readonly PathStep[], at: number, out: unknown[]): void {
  const step = steps[at];
  if (step === undefined) { out.push(value); return; }
  if ("each" in step) {
    if (Array.isArray(value)) for (const item of value) walk(item, steps, at + 1, out);
    return;
  }
  if ("key" in step) {
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, step.key)) {
      walk((value as Record<string, unknown>)[step.key], steps, at + 1, out);
    }
    return;
  }
  if (step.any === "key") {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const item of Object.values(value)) walk(item, steps, at + 1, out);
    return;
  }
  walk(value, steps, at + 1, out);
  for (const item of children(value)) walk(item, steps, at, out);
}

/** Every value the path reaches, in document order. */
export function selectPath(value: unknown, steps: readonly PathStep[]): unknown[] {
  const out: unknown[] = [];
  walk(value, steps, 0, out);
  return out;
}
