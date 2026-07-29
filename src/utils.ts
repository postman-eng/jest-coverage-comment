import * as core from '@actions/core'
import { existsSync, readFileSync } from 'fs'
import { CoverageColor, MultipleFilesLine } from './types'

export function getPathToFile(pathToFile: string): string {
  if (!pathToFile) {
    return ''
  }

  // Supports absolute path like '/tmp/coverage-summary.json'
  return pathToFile.startsWith('/')
    ? pathToFile
    : `${process.env.GITHUB_WORKSPACE}/${pathToFile}`
}

export function getContentFile(pathToFile: string): string {
  if (!pathToFile) {
    core.warning('Path to file was not provided')
    return ''
  }

  const fixedFilePath = getPathToFile(pathToFile)
  const fileExists = existsSync(fixedFilePath)

  if (!fileExists) {
    core.warning(`File "${pathToFile}" doesn't exist`)
    return ''
  }

  const content = readFileSync(fixedFilePath, 'utf8')

  if (!content) {
    core.warning(`No content found in file "${pathToFile}"`)
    return ''
  }

  core.info(`File read successfully "${pathToFile}"`)
  return content
}

/** Get coverage color from percentage. */
export function getCoverageColor(percentage: number): CoverageColor {
  // https://shields.io/category/coverage
  const rangeColors: { color: CoverageColor; range: [number, number] }[] = [
    {
      color: 'red',
      range: [0, 40],
    },
    {
      color: 'orange',
      range: [40, 60],
    },
    {
      color: 'yellow',
      range: [60, 80],
    },
    {
      color: 'green',
      range: [80, 90],
    },
    {
      color: 'brightgreen',
      range: [90, 101],
    },
  ]

  const { color } =
    rangeColors.find(
      ({ range: [min, max] }) => percentage >= min && percentage < max
    ) || rangeColors[0]

  return color
}

/** Parse one-line from multiple files to object. */
export const parseLine = (line: string): MultipleFilesLine | null => {
  if (!line.includes(',')) {
    return null
  }

  const lineArr = line.split(',')
  return { title: lineArr[0].trim(), file: lineArr[1].trim() }
}

/** Helper function to filter null entries out of an array. */
export function notNull<T>(value: T | null | undefined): value is T {
  return value !== null
}

/**
 * Normalize NYC-style excludes to the glob dialect understood by globToRegExp.
 * A bare path with no wildcard (e.g. `api/controllers`, a common NYC entry) is a
 * directory exclude, so also emit `<path>/**` to match its contents.
 */
export function normalizeExcludeGlobs(patterns: string[]): string[] {
  const normalized = new Set<string>()

  for (const pattern of patterns) {
    const trimmed = pattern.trim()
    if (!trimmed) {
      continue
    }
    normalized.add(trimmed)
    if (!trimmed.includes('*')) {
      normalized.add(`${trimmed.replace(/\/+$/, '')}/**`)
    }
  }

  return [...normalized]
}

/**
 * Best-effort auto-inference of coverage excludes from a repo's *declarative*
 * config, so services need not pass `coverage-exclude` manually. Reads
 * `.nycrc`, `.nycrc.json` and `package.json#nyc.exclude` (JSON only). Config
 * expressed in JS (`.nycrc.js`, inline `new NYC({ exclude })`) or Jest's
 * `collectCoverageFrom` is intentionally not evaluated here — rely on the
 * explicit input or the built-in defaults for those.
 */
export function inferCoverageExclude(
  baseDir: string = process.env.GITHUB_WORKSPACE || '.'
): string[] {
  const readJson = (relativePath: string): Record<string, unknown> | null => {
    const fullPath = `${baseDir}/${relativePath}`
    if (!existsSync(fullPath)) {
      return null
    }
    try {
      return JSON.parse(readFileSync(fullPath, 'utf8'))
    } catch {
      core.warning(`Could not parse ${relativePath} for coverage excludes`)
      return null
    }
  }

  const inferred: string[] = []

  for (const file of ['.nycrc', '.nycrc.json']) {
    const exclude = readJson(file)?.exclude
    if (Array.isArray(exclude)) {
      inferred.push(...(exclude as string[]))
    }
  }

  const nyc = readJson('package.json')?.nyc as { exclude?: unknown } | undefined
  const nycExclude = nyc?.exclude
  if (Array.isArray(nycExclude)) {
    inferred.push(...(nycExclude as string[]))
  }

  return normalizeExcludeGlobs(inferred)
}
