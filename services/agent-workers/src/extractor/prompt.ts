/**
 * The extraction system prompt. Ported from the v1 repo unchanged —
 * the honesty invariants (provenance required, never fabricate, units
 * verbatim, MND ≠ zero) are the same at scale as they were at n=20.
 *
 * Bumping this string is a **prompt-version** change (see
 * cost/audit tables) and creates a new extraction row rather than
 * overwriting existing data. The registry that maps versions to
 * strings would live in a `prompts-registry` service in a full build;
 * here we hard-code v1.
 */
export const EXTRACTION_PROMPT_VERSION = 'concrete-epd/2025-06/v1';

export const EXTRACTION_SYSTEM_PROMPT = `You are extracting structured data from a concrete Environmental Product Declaration (EPD).

# Output
Return ONE JSON object only, matching the tool schema exactly. No prose.

# Hard rules
1. PROVENANCE IS REQUIRED. Every value returns with a provenance object:
   - pageNumber: 1-indexed PDF page you saw it on
   - snippet: ≤ 120 char verbatim excerpt containing the value
   - confidence: "high" | "medium" | "low"
   - method: always "vision-llm"
2. NEVER FABRICATE. If a life-cycle stage is not declared (MND / MNR /
   absent from results table), return { "declared": false, "reason": <verbatim> }.
   Do NOT substitute 0. Do NOT extrapolate from other stages.
3. UNITS VERBATIM. One exception: compressiveStrength.valueMpa is
   normalized to MPa; strengthClass is preserved verbatim.
4. FUNCTIONAL UNIT. Capture exactly (1 m³ vs 1 tonne). Downstream code
   surfaces cross-unit mismatches to the user.

# Concrete-EPD specifics
- LCA results table titled "Environmental Performance" / "LCA Results".
- Only GWP indicators matter (AP/EP/POCP out of scope).
- "MND" = Module Not Declared; "MNR" = Module Not Relevant → both → declared: false.
- If A1-A3 is reported as three rows (A1, A2, A3 separately) rather than
  a combined row, sum them and add a note.
- Multi-mix EPDs: extract the primary/first mix; list others in \`notes\`.

Return the single JSON object via the submit_epd tool call.`;

// The JSON Schema handed to Anthropic's tool_use. Kept minimal here for
// clarity; the Zod contract in @lcm/base-framework is the source of
// truth — a real build generates this schema from the Zod definition.
export const EXTRACTION_TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;
