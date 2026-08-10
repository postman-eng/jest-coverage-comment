export interface Options {
  netCoverageMain: string
  token: string
  repository: string
  serverUrl: string
  summaryFile: string
  summaryTitle?: string
  badgeTitle: string
  prefix: string
  watermark: string
  commit: string
  head?: string
  base?: string
  title?: string
  junitFile?: string
  junitTitle?: string
  coverageFile?: string
  coverageTitle?: string
  coveragePathPrefix?: string
  hideSummary?: boolean
  removeLinksToFiles?: boolean
  removeLinksToLines?: boolean
  createNewComment?: boolean
  hideComment?: boolean
  reportOnlyChangedFiles?: boolean
  changedFiles?: ChangedFiles | null
  multipleFiles?: string[]
  multipleJunitFiles?: string[]
  coverageFinalFile?: string
  coverageLcovFile?: string
  // Incremental (patch) coverage gate threshold as a percentage string, '' when unset.
  patchThreshold?: string
  // Glob patterns for files excluded from coverage instrumentation (mirrors the
  // project's NYC `exclude` / the inverse of Jest `collectCoverageFrom`). Applied
  // in addition to the built-in defaults; changed files matching these are not
  // scored as uncovered for incremental (patch) coverage.
  coverageExclude?: string[]
}

export interface ChangedFiles {
  all: string[]
  added?: string[]
  modified?: string[]
  removed?: string[]
  renamed?: string[]
  addedOrModified?: string[]
  // Map of repo-relative file path -> set of line numbers added/modified on the head side.
  changedLines?: Record<string, number[]>
}

export interface PatchCoverage {
  // Percentage (0-100) of changed executable lines that are covered.
  coverage: number
  color: CoverageColor
  coveredLines: number
  totalLines: number
  files: PatchCoverageFile[]
  // Gate threshold (percentage) when configured, otherwise null (advisory).
  threshold: number | null
  // Whether coverage meets the threshold; null when advisory.
  meetsThreshold: boolean | null
}

export interface PatchCoverageFile {
  file: string
  coveredLines: number
  totalLines: number
  coverage: number
  uncoveredLines: number[]
  // False when the file has no coverage data (e.g. a new, untested source file).
  instrumented: boolean
  // True when the file was git-added in this PR (per changedFiles.added). Only
  // meaningful for uninstrumented files, to distinguish a genuinely new file
  // from a modified one that simply has no line-level coverage data.
  isNew: boolean
}

export interface LineSummary {
  total: number
  covered: number
  skipped: number
  pct: number
}

export interface Summary {
  lines: LineSummary
  statements: LineSummary
  functions: LineSummary
  branches: LineSummary
  branchesTrue: LineSummary
}

export type CoverageColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'brightgreen'

export interface SummaryReport {
  summaryHtml: string
  coverage: number
  color: CoverageColor
}

export interface Junit {
  skipped: number // calculated field
  tests: number
  failures: number
  errors: number
  time: number
}

export interface JunitReport extends Junit {
  junitHtml: string
}

export interface CoverageLine {
  file: string
  stmts: number
  branch: number
  funcs: number
  lines: number
  uncoveredLines: string[] | null
}

export interface CoverageReport {
  coverageHtml: string
  coverage: number
  color: CoverageColor
  branches: number
  functions: number
  lines: number
  statements: number
}

export interface MultipleFilesLine {
  title: string
  file: string
}
