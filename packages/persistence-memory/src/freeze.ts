/** Freezes a plain-data value and everything it holds, so a stored record cannot be changed through a returned reference. */
export function freezeDeep<T>(value: T): T {
  const pending: object[] = [];
  if (value && typeof value === "object") pending.push(value);
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) if (child && typeof child === "object") pending.push(child);
    Object.freeze(current);
  }
  return value;
}
