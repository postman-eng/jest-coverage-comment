import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { Options } from './types.d'

/**
 * Strip line and block comments while preserving string/template literals, so
 * comment content can never be mistaken for a runtime statement (and a `//`
 * inside a string is not treated as a comment).
 */
function stripComments(source: string): string {
  let out = ''
  let str: string | null = null
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    const next = source[i + 1]

    if (str) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === str) {
        str = null
      }
      continue
    }

    if (c === "'" || c === '"' || c === '`') {
      str = c
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/'))
        i++
      i++
      continue
    }
    out += c
  }
  return out
}

// Module-linking statements that never emit instrumentable runtime code:
// value/type/side-effect imports and re-export ("barrel") forms. Ordered so
// `export ... from '...'` is consumed before a bare `export { ... }` binding.
const IMPORT_RE = /^[ \t]*import\b[^'";]*?['"][^'"]*['"][ \t]*;?/gm
const EXPORT_FROM_RE =
  /^[ \t]*export\b[^'";]*?\bfrom[ \t]*['"][^'"]*['"][ \t]*;?/gm
const EXPORT_BINDING_RE =
  /^[ \t]*export[ \t]+(?:type[ \t]+)?\{[^}]*\}[ \t]*;?/gm

// A top-level line that starts a TypeScript construct erased to nothing: a type
// alias, interface, or ambient `declare`, optionally exported. (`import` should
// already be stripped, but is accepted defensively.)
const ERASABLE_LINE_RE =
  /^(?:export[ \t]+)?(?:declare[ \t]+)?(?:interface\b|type[ \t]|type$)|^declare\b|^import\b/

// The source is written without semicolons (Prettier `semi: false`), so a
// declaration can wrap across several lines. A line continues the previous one
// when it *starts* with a type-expression operator, or the previous line *ends*
// expecting more (an operator, `<`, `extends`, ...). Continuation lines belong
// to the construct already classified, so they never start a new statement.
const CONTINUATION_START_RE =
  /^(?:[|&?:.,)\]>}=]|extends\b|implements\b|infer\b)/
const CONTINUATION_END_RE =
  /(?:[=|&,<([:.+\-*/?]|=>|\b(?:extends|implements|keyof|typeof|infer|as|in))[ \t]*$/

/**
 * Advance bracket depth and string state across one line, ignoring brackets
 * inside string/template literals. Returns the state at the end of the line.
 */
function scanLine(
  line: string,
  startDepth: number,
  startString: string | null
): { depth: number; str: string | null } {
  let depth = startDepth
  let str = startString

  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (str) {
      if (c === '\\') {
        i++
      } else if (c === str) {
        str = null
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      str = c
    } else if (c === '{' || c === '(' || c === '[') {
      depth++
    } else if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1)
    }
  }

  return { depth, str }
}

/**
 * Heuristic: does this TS/JS source emit any runtime JavaScript?
 *
 * Returns false only when every top-level construct is type-only or a pure
 * re-export -- imports, `import`/`export type`, `interface`, `type` aliases,
 * `declare`, and `export { ... }` / `export * from` barrels -- i.e. the file
 * compiles to empty JS and can never appear in a coverage report. Any construct
 * it does not positively recognise as erasable (a `const`/`function`/`class`,
 * an expression, an `enum`, a `namespace` with a body, ...) yields true, so the
 * classification fails toward "has runtime" and never hides untested code.
 */
export function emitsRuntimeJavaScript(source: string): boolean {
  const code = stripComments(source)
    .replace(IMPORT_RE, '')
    .replace(EXPORT_FROM_RE, '')
    .replace(EXPORT_BINDING_RE, '')

  let depth = 0
  let str: string | null = null
  let carry = false

  for (const rawLine of code.split('\n')) {
    const startDepth = depth
    const startString = str
    const scanned = scanLine(rawLine, depth, str)
    depth = scanned.depth
    str = scanned.str

    // Lines inside a brackets block or a multi-line string belong to a
    // construct already classified on the line that opened it.
    if (startDepth > 0 || startString !== null) {
      continue
    }

    const trimmed = rawLine.trim()
    if (trimmed === '') {
      continue
    }

    // A continuation of the previous (erasable) construct -- we only reach here
    // when the previous top-level line was erasable, since a runtime line
    // returns immediately below.
    if (carry || CONTINUATION_START_RE.test(trimmed)) {
      carry = CONTINUATION_END_RE.test(trimmed)
      continue
    }

    if (ERASABLE_LINE_RE.test(trimmed)) {
      carry = CONTINUATION_END_RE.test(trimmed)
      continue
    }

    // Anything else starts a statement that emits runtime JavaScript.
    return true
  }

  return false
}

/**
 * Fetch a changed file's text at the PR/push head commit via the GitHub
 * contents API. Returns null on any missing input or failure so callers can
 * fail safe (keep the file flagged rather than hide it).
 */
export async function fetchFileAtHead(
  options: Options,
  file: string
): Promise<string | null> {
  if (!options.token || !options.commit) {
    return null
  }

  try {
    const { owner, repo } = context.repo
    const octokit = getOctokit(options.token)
    const path = `${options.coveragePathPrefix || ''}${file}`
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: options.commit,
    })

    const data = response.data as {
      type?: string
      content?: string
      encoding?: string
    }
    // Only trust an actual base64 body. Files over the API's ~1MB inline limit
    // come back with an empty content and encoding "none"; decoding that as an
    // empty (hence non-instrumentable) file would wrongly hide a large source
    // file, so fail safe instead.
    if (
      data.type !== 'file' ||
      typeof data.content !== 'string' ||
      data.encoding !== 'base64'
    ) {
      return null
    }
    return Buffer.from(data.content, 'base64').toString('utf8')
  } catch (error) {
    if (error instanceof Error) {
      core.info(
        `Patch coverage: could not fetch "${file}" to check if it is instrumentable ` +
          `(${error.message}); treating it as uncovered.`
      )
    }
    return null
  }
}

/**
 * Decide whether a changed source file that is absent from the coverage report
 * is non-instrumentable (type-only or a pure re-export barrel) and can be
 * skipped. Fail-safe: any fetch/parse failure returns false, so a file is only
 * hidden when we positively confirm it emits no runtime JavaScript.
 */
export async function isNonInstrumentableSource(
  options: Options,
  file: string
): Promise<boolean> {
  const source = await fetchFileAtHead(options, file)
  if (source === null) {
    return false
  }
  try {
    return !emitsRuntimeJavaScript(source)
  } catch {
    return false
  }
}
