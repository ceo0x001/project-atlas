import type {
  ParseTemplate,
  TemplateDefect,
  TemplateFieldKind,
  TemplateFixture,
  TemplateValidationResult,
} from '../parse-template';
import { REQUIRED_FIELD_KINDS } from '../parse-template';
import { parseMessage, type SourceMessage } from './template-engine';
import type { ParseContext } from './transforms';

/**
 * The publication gate for parse templates (ADR-004).
 *
 * Templates are data authored by an LLM and executed on user devices, which makes
 * this the security boundary of the ingestion pipeline. Two distinct risks:
 *
 *   1. **Catastrophic backtracking.** A pattern such as `(\d+)+$` is a denial of
 *      service delivered as configuration — it will pin a CPU and drain a battery
 *      on a mid-range Android with no way for the user to stop it.
 *   2. **Silent misreading.** A template that extracts the balance where the amount
 *      should be produces a plausible, wrong ledger. Fixtures are the defence.
 *
 * Nothing reaches a device without passing this.
 */

/** Patterns beyond this are unreviewable by a human and almost certainly wrong. */
export const MAX_PATTERN_LENGTH = 2000;

interface ScanState {
  index: number;
}

/** Skips a character class `[...]`, returning the index just past the closing `]`. */
function skipCharacterClass(pattern: string, start: number): number {
  let index = start + 1;
  if (pattern[index] === '^') index += 1;
  if (pattern[index] === ']') index += 1; // a literal ']' may lead the class

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === ']') return index + 1;
    index += 1;
  }

  return index;
}

/** True if the fragment contains a quantifier outside any character class. */
function containsQuantifier(fragment: string): boolean {
  const state: ScanState = { index: 0 };

  while (state.index < fragment.length) {
    const char = fragment[state.index];

    if (char === '\\') {
      state.index += 2;
      continue;
    }
    if (char === '[') {
      state.index = skipCharacterClass(fragment, state.index);
      continue;
    }
    if (char === '*' || char === '+') return true;
    if (char === '{' && /^\{\d+,\d*\}/.test(fragment.slice(state.index))) return true;

    state.index += 1;
  }

  return false;
}

/**
 * Finds quantified groups whose body is itself quantified — the `(a+)+` shape that
 * drives exponential backtracking.
 *
 * This is a heuristic, not a proof: it catches the overwhelmingly common
 * constructions without attempting full automaton analysis. Templates that trip it
 * are rejected rather than reviewed, because the cost of rewriting a pattern is
 * trivial next to the cost of shipping one that hangs a user's phone.
 */
export function findNestedQuantifiers(pattern: string): string[] {
  const findings: string[] = [];
  const openGroups: number[] = [];
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index];

    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '[') {
      index = skipCharacterClass(pattern, index);
      continue;
    }
    if (char === '(') {
      openGroups.push(index);
      index += 1;
      continue;
    }
    if (char === ')') {
      const start = openGroups.pop();
      index += 1;

      if (start === undefined) continue;

      const next = pattern[index];
      const isQuantified =
        next === '*' || next === '+' || (next === '{' && /^\{\d+,\d*\}/.test(pattern.slice(index)));

      if (isQuantified && containsQuantifier(pattern.slice(start + 1, index - 1))) {
        findings.push(pattern.slice(start, index + 1));
      }
      continue;
    }

    index += 1;
  }

  return findings;
}

/** Backreferences amplify backtracking and no bank alert format needs them. */
function hasBackreference(pattern: string): boolean {
  let index = 0;

  while (index < pattern.length) {
    if (pattern[index] === '\\') {
      const next = pattern[index + 1] ?? '';
      if (/[1-9]/.test(next) || next === 'k') return true;
      index += 2;
      continue;
    }
    if (pattern[index] === '[') {
      index = skipCharacterClass(pattern, index);
      continue;
    }
    index += 1;
  }

  return false;
}

/** Named capture groups declared by a pattern, ignoring lookbehind syntax. */
export function namedGroupsOf(pattern: string): Set<string> {
  const names = new Set<string>();
  // `(?<name>` only — `(?<=` and `(?<!` cannot match, since `=`/`!` are excluded.
  const declaration = /\(\?<([A-Za-z_$][\w$]*)>/g;

  let match: RegExpExecArray | null;
  while ((match = declaration.exec(pattern)) !== null) {
    names.add(match[1] as string);
  }

  return names;
}

/** Canonical string form of a parsed field, for comparison against a fixture. */
function canonicalise(
  kind: TemplateFieldKind,
  parsed: ReturnType<typeof parseMessage>,
): string | null {
  if (!parsed.ok) return null;
  const transaction = parsed.value;

  switch (kind) {
    case 'amount':
      return transaction.amount.toDecimalString();
    case 'currency':
      return transaction.currency;
    case 'direction':
      return transaction.direction;
    case 'occurredAt':
      return transaction.occurredAt.toISOString();
    case 'balanceAfter':
      return transaction.balanceAfter?.toDecimalString() ?? null;
    case 'description':
      return transaction.description;
    case 'accountLast4':
      return transaction.accountLast4;
  }
}

export function validateTemplate(
  template: ParseTemplate,
  fixtures: readonly TemplateFixture[],
  context: ParseContext,
): TemplateValidationResult {
  const defects: TemplateDefect[] = [];

  // --- pattern: compiles, and is safe to run on a phone ---
  if (template.matchPattern.length > MAX_PATTERN_LENGTH) {
    defects.push({
      code: 'PATTERN_UNSAFE',
      detail: `pattern is ${template.matchPattern.length} characters, limit is ${MAX_PATTERN_LENGTH}`,
    });
  }

  let compiles = true;
  try {
    new RegExp(template.matchPattern, 'is');
  } catch (error) {
    compiles = false;
    defects.push({
      code: 'PATTERN_INVALID',
      detail: error instanceof Error ? error.message : 'pattern does not compile',
    });
  }

  const nested = findNestedQuantifiers(template.matchPattern);
  if (nested.length > 0) {
    defects.push({
      code: 'PATTERN_UNSAFE',
      detail: `nested quantifiers risk catastrophic backtracking: ${nested.join(', ')}`,
    });
  }

  if (hasBackreference(template.matchPattern)) {
    defects.push({
      code: 'PATTERN_UNSAFE',
      detail: 'backreferences are not permitted in templates',
    });
  }

  // --- fields: wired to groups that exist, and complete ---
  const declaredGroups = compiles ? namedGroupsOf(template.matchPattern) : new Set<string>();
  const presentKinds = new Set<TemplateFieldKind>();

  for (const field of template.fields) {
    presentKinds.add(field.kind);

    const hasGroup = field.group !== undefined;
    const hasLiteral = field.literal !== undefined;

    if (hasGroup === hasLiteral) {
      defects.push({
        code: 'FIELD_SOURCE_AMBIGUOUS',
        detail: `field '${field.kind}' must declare exactly one of group or literal`,
      });
    }

    if (hasGroup && compiles && !declaredGroups.has(field.group as string)) {
      defects.push({
        code: 'UNKNOWN_GROUP',
        detail: `field '${field.kind}' references group '${field.group}', which the pattern does not declare`,
      });
    }

    if (field.kind === 'occurredAt' && !field.format) {
      defects.push({
        code: 'MISSING_DATE_FORMAT',
        detail: "field 'occurredAt' must declare an explicit date format",
      });
    }
  }

  for (const required of REQUIRED_FIELD_KINDS) {
    if (!presentKinds.has(required)) {
      defects.push({
        code: 'MISSING_REQUIRED_FIELD',
        detail: `template declares no '${required}' field`,
      });
    }
  }

  // --- fixtures: the template actually reads the messages it claims to ---
  let fixturesPassed = 0;

  if (defects.length === 0) {
    for (const [position, fixture] of fixtures.entries()) {
      const message: SourceMessage = {
        senderId: template.name,
        body: fixture.input,
        receivedAt: new Date(0),
      };

      const parsed = parseMessage(message, [template], context);

      if (!parsed.ok) {
        defects.push({
          code: 'FIXTURE_FAILED',
          detail: `fixture ${position}: ${parsed.error.code} — ${parsed.error.detail}`,
        });
        continue;
      }

      const mismatches: string[] = [];
      for (const [kind, expected] of Object.entries(fixture.expected)) {
        const actual = canonicalise(kind as TemplateFieldKind, parsed);
        if (actual !== expected) {
          mismatches.push(`${kind}: expected '${expected}', got '${actual ?? 'null'}'`);
        }
      }

      if (mismatches.length > 0) {
        defects.push({
          code: 'FIXTURE_FAILED',
          detail: `fixture ${position}: ${mismatches.join('; ')}`,
        });
        continue;
      }

      fixturesPassed += 1;
    }

    if (fixtures.length === 0) {
      defects.push({
        code: 'FIXTURE_FAILED',
        detail: 'a template with no fixtures cannot be published',
      });
    }
  }

  return {
    valid: defects.length === 0,
    defects,
    fixturesPassed,
    fixturesTotal: fixtures.length,
  };
}
