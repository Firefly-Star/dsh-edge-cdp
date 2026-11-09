/**
 * Self-contained replacement for `defineTool` from `@deepseek-ai/dsh-tools`.
 *
 * WHY THIS EXISTS
 * Real log from a DSH boot:
 *
 *   edge-cdp (dsh-edge-cdp): failed to import:
 *     ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'
 *     imported from ...\dsh-edge-cdp\lib\index.js
 *
 * A plugin living outside the profile's node_modules (a linked root) is
 * resolved by plain Node rules, so installation-scope packages are not on its
 * import path. Importing the SDK at module top level therefore kills the
 * plugin before `apply()` ever runs.
 *
 * This module reproduces the two behaviours the plugin actually depends on:
 *   1. compile the author-facing schema DSL into the supported raw JSON Schema
 *      subset (description/title/default/examples, type, properties,
 *      additionalProperties, items, enum, const, oneOf, and the `json` node);
 *   2. validate model-supplied arguments against the compiled parameter schema
 *      before the tool body runs.
 *
 * It is deliberately not a general port. `test/schema-parity.mjs` compiles the
 * same specs through the real SDK and asserts the output is byte-identical, so
 * drift shows up as a test failure instead of a runtime surprise.
 *
 * @module dsh-edge-cdp/tool-schema
 */

/** Annotation keywords copied verbatim onto the compiled node. */
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];

/** Scalar types the subset enforces. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** Every key an author node may carry, by position. */
const AUTHOR_KEYS = new Set([...ANNOTATION_KEYS, 'type', 'oneOf', 'properties', 'additionalProperties', 'items', 'enum', 'const', 'required']);

/**
 * Copy annotation-only keywords from an author node onto a compiled node.
 * @param {Record<string, unknown>} input
 * @param {Record<string, unknown>} node
 */
function copyAnnotations(input, node) {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(input, key)) node[key] = input[key];
  }
}

/**
 * Fail an author mistake with the path that caused it.
 * @param {string} message
 * @returns {never}
 */
function authorError(message) {
  throw new Error(`tool schema: ${message}`);
}

/**
 * Reject keys the subset does not support, so a typo cannot be silently
 * ignored (a silently dropped `requird: true` would make an argument optional).
 * @param {Record<string, unknown>} input
 * @param {string} path
 * @param {Iterable<string>} allowed
 */
function assertAuthorKeys(input, path, allowed) {
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) authorError(`unsupported keyword "${key}" at ${path}`);
  }
}

/**
 * Whether a value is a plain JSON-ish record (not an array, not null).
 * @param {unknown} value
 * @returns {boolean}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a scalar value matches one schema type.
 * @param {string} type
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/**
 * Compile one author value-schema node.
 * @param {unknown} input
 * @param {string} path
 * @param {boolean} allowRequired - true only in property position, where the
 *   SDK lets a spec carry `required: true` as an annotation.
 * @returns {Record<string, unknown>}
 */
function compileValue(input, path, allowRequired) {
  if (!isRecord(input)) authorError(`${path} must be a value schema object`);
  const node = {};
  // Property specs may carry `required: true`; every other position may not.
  const baseKeys = allowRequired ? [...ANNOTATION_KEYS, 'required'] : [...ANNOTATION_KEYS];

  if (Object.hasOwn(input, 'oneOf')) {
    assertAuthorKeys(input, path, [...baseKeys, 'oneOf', 'type']);
    if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`);
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      authorError(`${path}.oneOf must be an array of at least two value schemas`);
    }
    copyAnnotations(input, node);
    node.oneOf = input.oneOf.map((branch, index) => compileValue(branch, `${path}.oneOf[${index}]`, false));
    return node;
  }

  const type = Object.hasOwn(input, 'type') ? input.type : undefined;

  if (type === 'json') {
    assertAuthorKeys(input, path, [...ANNOTATION_KEYS, 'type']);
    copyAnnotations(input, node);
    return node;
  }

  if (type === 'object') {
    assertAuthorKeys(input, path, [...baseKeys, 'type', 'properties', 'additionalProperties']);
    if (typeof input.additionalProperties !== 'boolean') {
      authorError(`${path}.additionalProperties must be explicitly true or false`);
    }
    node.type = 'object';
    copyAnnotations(input, node);
    node.additionalProperties = input.additionalProperties;
    if (Object.hasOwn(input, 'properties')) {
      // The SDK splices properties onto the object node itself; a nested
      // `{properties: {...}}` wrapper is not the same schema.
      const compiled = compilePropertyMap(input.properties, `${path}.properties`);
      node.properties = compiled.properties;
      if (compiled.required !== undefined) node.required = compiled.required;
    }
    return node;
  }

  if (type === 'array') {
    assertAuthorKeys(input, path, [...baseKeys, 'type', 'items']);
    node.type = 'array';
    copyAnnotations(input, node);
    if (Object.hasOwn(input, 'items')) node.items = compileValue(input.items, `${path}.items`, false);
    return node;
  }

  if (typeof type === 'string' && SCALAR_TYPES.has(type)) {
    assertAuthorKeys(input, path, [...baseKeys, 'type', 'enum', 'const']);
    node.type = type;
    copyAnnotations(input, node);
    if (Object.hasOwn(input, 'enum')) {
      if (!Array.isArray(input.enum) || input.enum.length === 0 || !input.enum.every((entry) => matchesType(type, entry))) {
        authorError(`${path}.enum must be a non-empty array of ${type} values`);
      }
      node.enum = input.enum;
    }
    if (Object.hasOwn(input, 'const')) {
      if (!matchesType(type, input.const)) authorError(`${path}.const must be a ${type} value`);
      if (node.enum && !node.enum.includes(input.const)) authorError(`${path}.const must be one of ${path}.enum when both are declared`);
      node.const = input.const;
    }
    return node;
  }

  if (type === undefined) authorError(`${path} must declare a type or oneOf`);
  return authorError(`${path} has unsupported type "${String(type)}"`);
}

/**
 * Compile a property map, collecting the names marked `required: true`.
 * @param {unknown} input
 * @param {string} path
 * @returns {{properties: Record<string, unknown>, required?: string[]}}
 */
function compilePropertyMap(input, path) {
  if (!isRecord(input)) authorError(`${path} must be an object of value schemas`);
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(input)) {
    if (!isRecord(spec)) authorError(`${path}.${key} must be a value schema object`);
    if (Object.hasOwn(spec, 'required') && spec.required !== true) {
      authorError(`${path}.${key}.required must be true when present`);
    }
    if (!allowRequiredKey(spec, path, key)) continue;
    if (spec.required === true) required.push(key);
    properties[key] = compileValue(spec, `${path}.${key}`, true);
  }
  return required.length > 0 ? { properties, required } : { properties };
}

/**
 * A property spec may carry `required`, matching the SDK's `allowRequired`.
 * @param {Record<string, unknown>} spec
 * @param {string} path
 * @param {string} key
 * @returns {boolean}
 */
function allowRequiredKey(spec, path, key) {
  if (!Object.hasOwn(spec, 'required')) return true;
  if (spec.required !== true) authorError(`${path}.${key}.required must be true when present`);
  return true;
}

/**
 * Compile the implicit open parameter object into raw JSON Schema.
 * @param {Record<string, unknown>} spec
 * @returns {Record<string, unknown>}
 */
export function parametersToJsonSchema(spec) {
  const compiled = compilePropertyMap(spec, 'parameters');
  return {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  };
}

/**
 * Compile an output value schema into raw JSON Schema.
 * @param {unknown} spec
 * @returns {Record<string, unknown>}
 */
export function valueToJsonSchema(spec) {
  return compileValue(spec, 'schema', false);
}

/**
 * Validate one value against a compiled schema, collecting path-qualified
 * violations. Mirrors the SDK's depth-first walk order closely enough that the
 * first reported violation matches.
 * @param {Record<string, unknown>} schema
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} violations
 */
function validateValue(schema, value, path, violations) {
  const at = path || 'arguments';

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => {
      const local = [];
      validateValue(branch, value, path, local);
      return local.length === 0;
    });
    if (matches.length !== 1) violations.push(`${at} must match exactly one schema in oneOf`);
    return;
  }

  const type = schema.type;
  if (type === undefined) return; // annotation-only node: any JSON value

  switch (type) {
    case 'object': {
      if (!isRecord(value)) { violations.push(`${at} must be an object`); return; }
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const key of required) {
        if (!Object.hasOwn(value, key)) violations.push(`${at}.${key} is required`);
      }
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(value, key)) validateValue(sub, value[key], `${at}.${key}`, violations);
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`${at}.${key} is not allowed`);
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) { violations.push(`${at} must be an array`); return; }
      const items = schema.items;
      if (isRecord(items)) value.forEach((entry, index) => validateValue(items, entry, `${at}[${index}]`, violations));
      return;
    }
    default: {
      if (!matchesType(type, value)) { violations.push(`${at} must be a ${type}`); return; }
      if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
        violations.push(`${at} must be one of the declared enum values`);
      }
      if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) {
        violations.push(`${at} must equal the declared const`);
      }
    }
  }
}

/**
 * Validate arguments, returning violation strings (empty means valid).
 * @param {Record<string, unknown>} schema
 * @param {unknown} args
 * @returns {string[]}
 */
export function validate(schema, args) {
  const violations = [];
  validateValue(schema, args, '', violations);
  return violations;
}

/** Thrown when model-supplied arguments fail the parameter schema. */
export class ToolArgsError extends Error {
  /**
   * @param {string[]} violations
   */
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

/**
 * Define a tool and enforce its parameter schema on every call.
 *
 * Behaviourally equivalent to the SDK's `defineTool` for the options this
 * plugin uses.
 * @param {Record<string, any>} options
 * @returns {Record<string, any>} a registry-ready ToolDefinition
 */
export function defineTool(options) {
  const userExecute = options.execute;
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
  }
  const parameters = parametersToJsonSchema(options.parameters ?? {});
  const outputSchema = valueToJsonSchema(options.output.schema);

  /** @type {Record<string, any>} */
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
      ...(options.output.presentationMeta !== undefined
        ? { presentationMeta: (args, value) => options.output.presentationMeta(args, value) }
        : {}),
    },
    ...(options.deferLoading === true ? { deferLoading: options.deferLoading } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validate(parameters, args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return userExecute(args, exec);
    },
  };
  if (options.projectContent) tool.projectContent = (exec, result) => options.projectContent(exec, result);
  if (options.finalizeContent) tool.finalizeContent = (exec, result) => options.finalizeContent(exec, result);
  if (options.presentCall) {
    tool.presentCall = (args) => (validate(parameters, args).length > 0 ? undefined : options.presentCall(args));
  }
  if (options.presentResult) {
    tool.presentResult = (args, result) => (validate(parameters, args).length > 0 ? undefined : options.presentResult(args, result));
  }
  if (options.isConcurrencySafe) {
    tool.isConcurrencySafe = (args) => (validate(parameters, args).length > 0 ? false : options.isConcurrencySafe(args));
  }
  return tool;
}
