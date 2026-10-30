/**
 * The bounds the fixture's product composes today, which the current turn-end rules are replayed under: Sample App's numeric
 * step ceiling (the longest finished turn recorded, 40 steps, plus a fifth) and its one tool-call ceiling
 * (create-sample-app-runtime.ts). Core takes them from no product: a one-product archive may not carry Sample App. Sample App's
 * composition test (products/sample-app/backend/test/screen-only.test.ts) compares the numbers it composes with these, so the
 * two cannot drift apart.
 */
export const COMPOSED_BOUNDS = { maxSteps: 48, maxToolCalls: 256 } as const;
