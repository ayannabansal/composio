import { isClosedObjectBranch, parseAllOf } from './parse-all-of';
import { parseAnyOf } from './parse-any-of';
import { parseOneOf } from './parse-one-of';
import { parseSchema } from './parse-schema';
import { applyPropertyPresence } from './property-presence';
import type { ParseContext } from '../context';
import type { JsonSchema, JsonSchemaObject } from '../types';
import { compilePattern } from '../utils/compile-pattern';
import { its } from '../utils/its';

/**
 * Build the static part of an object parser, or `undefined` when the schema
 * declares no named properties.
 *
 * A property-less object (`properties` absent or `{}`) deliberately returns
 * `undefined` so the caller can apply the open-object policy. This supersedes
 * an earlier `z.object({})` fallback that was kept "or else this will break
 * openai responses": collapsing `{ type: "object" }` to a strict empty object
 * is the defect it was masking, and the OpenAI provider suite is part of this
 * package's verification precisely so the claim stays checked.
 */
function parseObjectProperties<S>(
  objectSchema: JsonSchemaObject & { type?: 'object' },
  ctx: ParseContext<S>
): Record<string, S> | undefined {
  if (!objectSchema.properties) {
    return undefined;
  }

  const propertyKeys = Object.keys(objectSchema.properties);
  if (propertyKeys.length === 0) {
    return undefined;
  }

  const { backend } = ctx;
  const properties: Record<string, S> = {};

  for (const key of propertyKeys) {
    const propJsonSchema = objectSchema.properties[key];

    const propZodSchema = parseSchema(propJsonSchema, {
      ...ctx,
      path: [...ctx.path, 'properties', key],
    });

    const required = Array.isArray(objectSchema.required)
      ? objectSchema.required.includes(key)
      : false;

    properties[key] = applyPropertyPresence(backend, propJsonSchema, propZodSchema, required);
  }

  return properties;
}

/**
 * Object parser for schemas carrying `patternProperties`.
 *
 * Every key is routed to exactly the schemas that apply to it — each matching
 * pattern, and `additionalProperties` only when no pattern and no named
 * property claims the key. A catch-all union would instead let a key sneak past
 * its own pattern by satisfying an unrelated one.
 */
function parseDynamicKeyObject<S>(
  normalizedSchema: JsonSchemaObject & { type?: 'object' },
  shape: Record<string, S> | undefined,
  additionalProperties: S | undefined,
  ctx: ParseContext<S>
): S {
  const { backend } = ctx;
  const patterns = Object.entries(normalizedSchema.patternProperties ?? {}).map(
    ([pattern, schema]) => ({
      regex: compilePattern('patternProperties', pattern, ctx),
      parser: parseSchema(schema, {
        ...ctx,
        path: [...ctx.path, 'patternProperties', pattern],
      }),
    })
  );

  const declaredKeys = new Set(Object.keys(normalizedSchema.properties ?? {}));
  const rejectsUnmatched =
    (additionalProperties !== undefined && backend.isNever(additionalProperties)) ||
    (additionalProperties === undefined && declaredKeys.size > 0);
  const validatesUnmatched =
    additionalProperties !== undefined &&
    !backend.isNever(additionalProperties) &&
    normalizedSchema.additionalProperties !== true;

  const base = backend.object(shape ?? {}, { kind: 'loose' });

  return backend.rewrite<Record<string, unknown>>(base, (value, issues) => {
    const result: Record<string, unknown> = { ...value };
    const unrecognizedKeys: string[] = [];

    for (const key of Object.keys(value)) {
      const matching = patterns.filter(({ regex }) => regex.test(key));

      for (const { parser } of matching) {
        const parsed = backend.run(parser, value[key]);
        if (!parsed.success) {
          issues.custom(`Invalid input: key "${key}" must match its patternProperties schema`, {
            path: [key],
            params: { issues: parsed.failure.issues },
          });
        } else if (!declaredKeys.has(key)) {
          result[key] = parsed.data;
        }
      }

      if (matching.length > 0 || declaredKeys.has(key)) {
        continue;
      }

      if (rejectsUnmatched) {
        unrecognizedKeys.push(key);
      } else if (validatesUnmatched) {
        const parsed = backend.run(additionalProperties!, value[key]);
        if (!parsed.success) {
          issues.custom(`Invalid input: key "${key}" must match the additionalProperties schema`, {
            path: [key],
            params: { issues: parsed.failure.issues },
          });
        } else {
          result[key] = parsed.data;
        }
      }
    }

    if (unrecognizedKeys.length > 0) {
      issues.unrecognizedKeys(
        unrecognizedKeys,
        `Unrecognized key(s) in object: ${unrecognizedKeys.map(key => `'${key}'`).join(', ')}`
      );
    }

    return result;
  });
}

/** A typeless composition branch that carries object keywords is an object. */
const asObjectBranch = (branch: JsonSchema): JsonSchema =>
  typeof branch === 'object' &&
  !branch.type &&
  (branch.properties ?? branch.additionalProperties ?? branch.patternProperties)
    ? { ...branch, type: 'object' }
    : branch;

export function parseObject<S>(
  objectSchema: JsonSchemaObject & { type?: 'object' },
  ctx: ParseContext<S>
): S {
  const { backend } = ctx;
  const hasPatternProperties = Object.keys(objectSchema.patternProperties ?? {}).length > 0;

  // Ensure type is set to 'object' if not already
  const normalizedSchema =
    objectSchema.type === 'object' ? objectSchema : { ...objectSchema, type: 'object' as const };

  const shape = parseObjectProperties(normalizedSchema, ctx);

  const additionalProperties =
    normalizedSchema.additionalProperties !== undefined
      ? parseSchema(normalizedSchema.additionalProperties, {
          ...ctx,
          path: [...ctx.path, 'additionalProperties'],
        })
      : undefined;

  // Track if additionalProperties was explicitly set to true
  const isAdditionalPropertiesTrue = normalizedSchema.additionalProperties === true;

  const anyOf = its.an.anyOf(objectSchema) ? objectSchema.anyOf.map(asObjectBranch) : undefined;
  const oneOf = its.a.oneOf(objectSchema) ? objectSchema.oneOf.map(asObjectBranch) : undefined;
  const allOf = its.an.allOf(objectSchema) ? objectSchema.allOf.map(asObjectBranch) : undefined;

  // A strict parent and a strict composition branch reject each other's keys,
  // which leaves the intersection unsatisfiable. When both sides are closed
  // only by the named-property default, each is materialized open and the
  // strictness is re-applied once over the union of the keys they declare.
  const closedBranches = [...(anyOf ?? []), ...(oneOf ?? []), ...(allOf ?? [])].filter(
    isClosedObjectBranch
  );
  const sharesKeysWithBranches =
    shape !== undefined &&
    !hasPatternProperties &&
    additionalProperties === undefined &&
    closedBranches.length > 0;
  const open = (branch: JsonSchema): JsonSchema =>
    sharesKeysWithBranches && isClosedObjectBranch(branch)
      ? { ...branch, additionalProperties: true }
      : branch;

  let output: S;
  if (hasPatternProperties) {
    output = parseDynamicKeyObject(normalizedSchema, shape, additionalProperties, ctx);
  } else if (shape) {
    if (additionalProperties) {
      if (backend.isNever(additionalProperties)) {
        output = backend.object(shape, { kind: 'strict' });
      } else if (isAdditionalPropertiesTrue) {
        // When additionalProperties was explicitly true, use passthrough
        output = backend.object(shape, { kind: 'loose' });
      } else {
        output = backend.object(shape, { kind: 'catchall', schema: additionalProperties });
      }
    } else {
      // Named properties with an omitted `additionalProperties` stay strict for
      // tool inputs, even though JSON Schema itself would allow unknown keys.
      output = backend.object(shape, { kind: sharesKeysWithBranches ? 'loose' : 'strict' });
    }
  } else {
    if (additionalProperties) {
      if (backend.isNever(additionalProperties)) {
        // When additionalProperties is false, create strict empty object
        output = backend.object({}, { kind: 'strict' });
      } else if (isAdditionalPropertiesTrue) {
        // When additionalProperties was explicitly true, use empty object with passthrough
        output = backend.object({}, { kind: 'loose' });
      } else {
        output = backend.record(additionalProperties);
      }
    } else {
      // A property-less object with no `additionalProperties` keyword is open:
      // arbitrary content is accepted and preserved verbatim.
      output = backend.object({}, { kind: 'loose' });
    }
  }

  if (anyOf) {
    output = backend.intersection(
      output,
      parseAnyOf({ ...objectSchema, anyOf: anyOf.map(open) }, ctx)
    );
  }

  if (oneOf) {
    output = backend.intersection(
      output,
      parseOneOf({ ...objectSchema, oneOf: oneOf.map(open) }, ctx)
    );
  }

  if (allOf) {
    output = backend.intersection(
      output,
      parseAllOf({ ...objectSchema, allOf: allOf.map(open) }, ctx)
    );
  }

  if (sharesKeysWithBranches) {
    const declaredKeys = new Set([
      ...Object.keys(normalizedSchema.properties ?? {}),
      ...closedBranches.flatMap(branch => Object.keys(branch.properties)),
    ]);

    output = backend.superRefine<unknown>(output, (value, issues) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      const unrecognizedKeys = Object.keys(value).filter(key => !declaredKeys.has(key));
      if (unrecognizedKeys.length > 0) {
        issues.unrecognizedKeys(
          unrecognizedKeys,
          `Unrecognized key(s) in object: ${unrecognizedKeys.map(key => `'${key}'`).join(', ')}`
        );
      }
    });
  }

  return output;
}
