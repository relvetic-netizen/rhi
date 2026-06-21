// Minimal JSON Schema validator — a tiny subset sufficient for structured
// task outputs. Avoids pulling in ajv as a dependency. Supports:
//   - type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'
//   - required: string[]
//   - properties: { [name]: schema }       (recursive)
//   - items: schema                         (for arrays, recursive)
//   - enum: any[]
//
// Returns { valid: boolean, errors: string[] }.

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return t
}

function typeMatches(expected, value) {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

export function validate(schema, value, path = '$') {
  const errors = []
  if (!schema || typeof schema !== 'object') return { valid: true, errors }

  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`)
    return { valid: false, errors }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some(v => deepEqual(v, value))) {
    errors.push(`${path}: value not in enum`)
  }

  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) errors.push(`${path}.${key}: required`)
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          const r = validate(subSchema, value[key], `${path}.${key}`)
          errors.push(...r.errors)
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      const r = validate(schema.items, item, `${path}[${i}]`)
      errors.push(...r.errors)
    })
  }

  return { valid: errors.length === 0, errors }
}

function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every(k => deepEqual(a[k], b[k]))
  }
  return false
}
