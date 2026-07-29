import * as core from '@actions/core'
import { existsSync } from 'fs'
import {
  Options,
  PatchCoverage,
  PatchCoverageFile,
  CoverageColor,
} from './types.d'
import { getContentFile, getCoverageColor, getPathToFile } from './utils'

interface IstanbulStatement {
  start: { line: number; column: number }
  end: { line: number; column: number }
}

interface IstanbulFileCoverage {
  path?: string
  statementMap: Record<string, IstanbulStatement>
  s: Record<string, number>
}

type IstanbulCoverage = Record<string, IstanbulFileCoverage>

// Map of repo-relative file path -> (line number -> hit count).
type LineHitsByFile = Map<string, Map<number, number>>

/**
 * Build line-hit data from an Istanbul coverage-final.json. A line is coverable
 * when a statement starts on it and covered when any such statement executed.
 */
function lineHitsFromIstanbul(
  coverage: IstanbulCoverage,
  prefix: string,
  pathPrefix: string
): LineHitsByFile {
  const byFile: LineHitsByFile = new Map()

  for (const [absPath, fileCoverage] of Object.entries(coverage)) {
    const relative = normalizePath(absPath, prefix, pathPrefix)
    const lineHits = new Map<number, number>()

    for (const [id, statement] of Object.entries(fileCoverage.statementMap)) {
      const line = statement.start?.line
      if (!line) {
        continue
      }
      const hits = fileCoverage.s[id] ?? 0
      lineHits.set(line, Math.max(lineHits.get(line) ?? 0, hits))
    }

    byFile.set(relative, lineHits)
  }

  return byFile
}

/**
 * Normalize a coverage file path to the same repo-relative form used for
 * changed files: strip the workspace prefix, then the coverage path prefix.
 */
function normalizePath(
  filePath: string,
  prefix: string,
  pathPrefix: string
): string {
  let relative = filePath.replace(prefix, '')
  if (pathPrefix) {
    relative = relative.replace(pathPrefix, '')
  }
  return relative
}

/** Build line-hit data from an lcov.info report (DA:<line>,<hits> records). */
function lineHitsFromLcov(
  content: string,
  prefix: string,
  pathPrefix: string
): LineHitsByFile {
  const byFile: LineHitsByFile = new Map()
  let currentFile: string | null = null
  let lineHits = new Map<number, number>()

  for (const raw of content.split('\n')) {
    const line = raw.trim()

    if (line.startsWith('SF:')) {
      currentFile = normalizePath(line.slice(3), prefix, pathPrefix)
      lineHits = new Map<number, number>()
    } else if (line.startsWith('DA:') && currentFile) {
      const [lineNo, hits] = line
        .slice(3)
        .split(',')
        .map((n) => parseInt(n, 10))
      if (!Number.isNaN(lineNo)) {
        lineHits.set(lineNo, Math.max(lineHits.get(lineNo) ?? 0, hits || 0))
      }
    } else if (line === 'end_of_record' && currentFile) {
      byFile.set(currentFile, lineHits)
      currentFile = null
    }
  }

  return byFile
}

/** Load line-hit data from whichever source is configured (Istanbul preferred). */
function loadLineHits(options: Options): LineHitsByFile | null {
  const { coverageFinalFile, coverageLcovFile, prefix } = options
  const pathPrefix = options.coveragePathPrefix || ''

  if (coverageFinalFile) {
    const resolved = getPathToFile(coverageFinalFile)
    if (existsSync(resolved)) {
      try {
        return lineHitsFromIstanbul(
          JSON.parse(getContentFile(coverageFinalFile)),
          prefix,
          pathPrefix
        )
      } catch (error) {
        if (error instanceof Error) {
          core.error(
            `Patch coverage: failed to parse coverage-final. ${error.message}`
          )
        }
      }
    }
  }

  if (coverageLcovFile) {
    const resolved = getPathToFile(coverageLcovFile)
    if (existsSync(resolved)) {
      return lineHitsFromLcov(
        getContentFile(coverageLcovFile),
        prefix,
        pathPrefix
      )
    }
  }

  core.warning(
    'Patch coverage: no line-level coverage source found (coverage-final.json or lcov.info); ' +
      'skipping incremental coverage (net coverage comment is still posted). ' +
      'To enable the incremental gate, upload lcov.info or coverage-final.json in your coverage artifact: ' +
      'https://postmanlabs.atlassian.net/wiki/spaces/QUAL/pages/8279130113'
  )
  return null
}

const DEFAULT_SOURCE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]

// Files never instrumented in any ecosystem (mirrors istanbul's
// `defaultExclude`). This action reads the coverage report, not the project's
// NYC config, so it re-derives the classification here. Org/service paths are
// supplied via `coverage-exclude`.
export const DEFAULT_COVERAGE_EXCLUDE = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/*.config.*',
  '**/.*rc.*',
  '**/test-*.*',
]

const GLOB_REGEX_SPECIALS = '\\^$+?.()|[]{}'

/**
 * Convert a minimal glob into an anchored RegExp. Supports `*` (matches within a
 * single path segment) and `**` (matches across segments). A leading globstar
 * segment also matches zero directories, so a `<globstar>/x` pattern matches a
 * top-level `x`. Brace expansion is unsupported; use a trailing `*` (e.g.
 * `*.config.*`) to match across file extensions.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = ''

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]

    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          pattern += '(?:.*/)?'
        } else {
          pattern += '.*'
        }
      } else {
        pattern += '[^/]*'
      }
    } else if (GLOB_REGEX_SPECIALS.includes(char)) {
      pattern += `\\${char}`
    } else {
      pattern += char
    }
  }

  return new RegExp(`^${pattern}$`)
}

const DEFAULT_EXCLUDE_MATCHERS = DEFAULT_COVERAGE_EXCLUDE.map(globToRegExp)

/**
 * A changed file absent from the report still counts as fully uncovered when it
 * is source and matches no exclude glob -- so a new, untested file can't pass
 * the gate at a misleading 100%, while excluded files are never penalised.
 */
function isCoverableSource(file: string, excludeMatchers: RegExp[]): boolean {
  if (!DEFAULT_SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) {
    return false
  }
  return !excludeMatchers.some((matcher) => matcher.test(file))
}

/** Parse the configured threshold; returns null when unset/invalid (advisory). */
function parseThreshold(raw?: string): number | null {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return null
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Compute incremental (patch) coverage: the percentage of changed executable
 * lines that are covered by tests. Returns null when the required data is
 * unavailable, so callers can keep the check advisory.
 */
export function getPatchCoverage(options: Options): PatchCoverage | null {
  const { changedFiles } = options

  if (!options.coverageFinalFile && !options.coverageLcovFile) {
    return null
  }

  if (!changedFiles?.changedLines) {
    core.warning(
      'Patch coverage: no changed-line information available (needs a pull_request or push event).'
    )
    return null
  }

  const lineHitsByFile = loadLineHits(options)
  if (!lineHitsByFile) {
    return null
  }

  const excludeMatchers = [
    ...DEFAULT_EXCLUDE_MATCHERS,
    ...(options.coverageExclude ?? []).map(globToRegExp),
  ]

  const files: PatchCoverageFile[] = []
  let totalChanged = 0
  let coveredChanged = 0

  for (const [file, lines] of Object.entries(changedFiles.changedLines)) {
    if (!lines.length) {
      continue
    }

    const lineHits = lineHitsByFile.get(file)

    if (!lineHits) {
      // Absent from the report: skip non-source/excluded files; count remaining
      // source as fully uncovered so a new, untested file can't slip past.
      if (!isCoverableSource(file, excludeMatchers)) {
        continue
      }
      totalChanged += lines.length
      files.push({
        file,
        coveredLines: 0,
        totalLines: lines.length,
        coverage: 0,
        uncoveredLines: [...lines],
        instrumented: false,
      })
      continue
    }

    let fileTotal = 0
    let fileCovered = 0
    const uncoveredLines: number[] = []

    for (const line of lines) {
      const hits = lineHits.get(line)
      // Not an executable line (blank, comment, type-only) -> ignore.
      if (hits === undefined) {
        continue
      }
      fileTotal++
      if (hits > 0) {
        fileCovered++
      } else {
        uncoveredLines.push(line)
      }
    }

    if (fileTotal === 0) {
      continue
    }

    totalChanged += fileTotal
    coveredChanged += fileCovered
    files.push({
      file,
      coveredLines: fileCovered,
      totalLines: fileTotal,
      coverage: Math.round((fileCovered / fileTotal) * 10000) / 100,
      uncoveredLines,
      instrumented: true,
    })
  }

  // No changed executable lines => nothing to gate on; treat as fully covered.
  const pct = totalChanged === 0 ? 100 : (coveredChanged / totalChanged) * 100
  const rounded = Math.round(pct * 100) / 100
  const color: CoverageColor = getCoverageColor(rounded)
  const threshold = parseThreshold(options.patchThreshold)
  const meetsThreshold = threshold === null ? null : rounded >= threshold

  return {
    coverage: rounded,
    color,
    coveredLines: coveredChanged,
    totalLines: totalChanged,
    files,
    threshold,
    meetsThreshold,
  }
}

// Cap how many uncovered lines we render per file to keep the comment readable.
const MAX_UNCOVERED_LINKS = 25

/** Render the patch coverage section as markdown for the PR comment. */
export function patchCoverageToMarkdown(
  patch: PatchCoverage,
  options: Options
): string {
  // Nothing testable changed => explicitly say so; the gate treats this as a pass.
  if (patch.totalLines === 0) {
    return '### \u2705 Incremental line coverage\nNo changed executable lines in this PR \u2014 nothing to cover.'
  }

  const pct = `**${patch.coverage}%**`
  const ratio = `**${patch.coveredLines}/${patch.totalLines}** changed lines covered`
  const required =
    patch.threshold !== null ? ` (required \u2265 ${patch.threshold}%)` : ''

  let heading: string
  let lead: string

  if (patch.meetsThreshold === false) {
    heading = `### \u274c Incremental line coverage: ${pct}${required}`
    lead = `This PR is **blocked**: ${ratio}. Cover the lines below to reach \u2265 ${patch.threshold}%.`
  } else if (patch.meetsThreshold === true) {
    heading = `### \u2705 Incremental line coverage: ${pct}${required}`
    lead = `${ratio}.`
  } else {
    heading = `### Incremental line coverage: ${pct}`
    lead = `${ratio}.`
  }

  const sections = [heading, lead]

  if (patch.files.length) {
    const table = renderFileTable(patch, options)
    // Show the actionable table up-front when blocked; collapse it otherwise.
    sections.push(
      patch.meetsThreshold === false
        ? table
        : `<details><summary>Coverage of changed files</summary>\n\n${table}\n\n</details>`
    )
  }

  return sections.join('\n\n')
}

function renderFileTable(patch: PatchCoverage, options: Options): string {
  const {
    serverUrl = 'https://github.com',
    repository,
    commit,
    coveragePathPrefix = '',
  } = options

  const rows = patch.files
    .map((f) => {
      const ratio = `${f.coveredLines}/${f.totalLines}`

      let coverageCell: string
      let uncovered: string

      if (!f.instrumented) {
        coverageCell = `\u26a0\ufe0f new file (${ratio})`
        uncovered = '_no test coverage_'
      } else if (f.uncoveredLines.length) {
        coverageCell = `${f.coverage}% (${ratio})`
        const shown = f.uncoveredLines.slice(0, MAX_UNCOVERED_LINKS)
        const links = shown
          .map((line) => {
            const href = `${serverUrl}/${repository}/blob/${commit}/${coveragePathPrefix}${f.file}#L${line}`
            return `[${line}](${href})`
          })
          .join(', ')
        const extra = f.uncoveredLines.length - shown.length
        uncovered = extra > 0 ? `${links}, \u2026 (+${extra} more)` : links
      } else {
        coverageCell = `\u2705 100% (${ratio})`
        uncovered = '\u2014'
      }

      return `| \`${f.file}\` | ${coverageCell} | ${uncovered} |`
    })
    .join('\n')

  return [
    '| Changed file | Coverage | Uncovered lines |',
    '| :--- | :--- | :--- |',
    rows,
  ].join('\n')
}
