import { expect, test, describe } from '@jest/globals'
import { getPatchCoverage, globToRegExp } from '../src/patch-coverage'
import { parsePatchAddedLines } from '../src/changed-files'
import { Options } from '../src/types'

const lcovFixture = `${__dirname}/../data/patch/lcov.info`

function baseOptions(overrides: Partial<Options> = {}): Options {
  return {
    token: 'token_123',
    repository: 'postman-eng/example',
    serverUrl: 'https://github.com',
    commit: 'deadbeef',
    watermark: '',
    prefix: '',
    coveragePathPrefix: '',
    badgeTitle: 'Net Coverage',
    summaryFile: '',
    netCoverageMain: '0',
    coverageLcovFile: lcovFixture,
    ...overrides,
  }
}

describe('parsePatchAddedLines', () => {
  test('captures only added/modified head-side lines', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' context',
      '+added1',
      '+added2',
      ' tail',
    ].join('\n')
    // header newStart=1: line1 context, line2 +, line3 +, line4 context
    expect(parsePatchAddedLines(patch)).toEqual([2, 3])
  })

  test('deletions do not advance the head cursor', () => {
    const patch = ['@@ -1,3 +1,2 @@', ' keep', '-removed', '+replacement'].join(
      '\n'
    )
    // line1 keep, removed does not advance, line2 +replacement
    expect(parsePatchAddedLines(patch)).toEqual([2])
  })

  test('handles multiple hunks', () => {
    const patch = [
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
      '@@ -10,1 +11,2 @@',
      ' c',
      '+d',
    ].join('\n')
    expect(parsePatchAddedLines(patch)).toEqual([2, 12])
  })

  test('ignores the no-newline-at-eof marker', () => {
    const patch = [
      '@@ -1,1 +1,1 @@',
      '+only',
      '\\ No newline at end of file',
    ].join('\n')
    expect(parsePatchAddedLines(patch)).toEqual([1])
  })
})

describe('getPatchCoverage', () => {
  test('computes coverage over changed executable lines only', () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/covered.js'],
        // line 4 is not executable (absent from lcov) and must be ignored
        changedLines: { 'src/covered.js': [1, 2, 3, 4] },
      },
    })

    const patch = getPatchCoverage(options)
    expect(patch).not.toBeNull()
    expect(patch?.totalLines).toBe(3)
    expect(patch?.coveredLines).toBe(2)
    expect(patch?.coverage).toBe(66.67)
    expect(patch?.files[0].uncoveredLines).toEqual([3])
    expect(patch?.files[0].instrumented).toBe(true)
  })

  test('counts a new untested source file as fully uncovered (strict)', () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/new-feature.ts'],
        changedLines: { 'src/new-feature.ts': [1, 2, 3] },
      },
    })

    const patch = getPatchCoverage(options)
    expect(patch?.coverage).toBe(0)
    expect(patch?.totalLines).toBe(3)
    expect(patch?.files[0].instrumented).toBe(false)
  })

  test('ignores non-source changed files with no coverage data', () => {
    const options = baseOptions({
      changedFiles: {
        all: ['README.md', 'docs/config.yml'],
        changedLines: { 'README.md': [1, 2], 'docs/config.yml': [3] },
      },
    })

    const patch = getPatchCoverage(options)
    // Nothing coverable changed => 100% (gate passes), no files listed.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('ignores changed tooling/config files with no coverage data', () => {
    const options = baseOptions({
      changedFiles: {
        all: [
          'jest.config.js',
          'webpack.config.ts',
          'packages/app/vite.config.mjs',
          '.eslintrc.js',
        ],
        changedLines: {
          'jest.config.js': [1, 2, 3],
          'webpack.config.ts': [10],
          'packages/app/vite.config.mjs': [5, 6],
          '.eslintrc.js': [1],
        },
      },
    })

    const patch = getPatchCoverage(options)
    // Config files are excluded from instrumentation by design => nothing
    // coverable changed => 100% (gate passes), no files listed.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('ignores changed test-runner / CI wrapper scripts with no coverage data', () => {
    const options = baseOptions({
      changedFiles: {
        all: [
          'scripts/test-unit.js',
          'scripts/test-integration.js',
          'npm/test-integration.js',
          'packages/common/npm/test/test-unit.js',
        ],
        changedLines: {
          'scripts/test-unit.js': [1, 2, 3],
          'scripts/test-integration.js': [1],
          'npm/test-integration.js': [4, 5],
          'packages/common/npm/test/test-unit.js': [1, 2],
        },
      },
    })

    const patch = getPatchCoverage(options)
    // Runner/harness wrappers are not instrumented source => nothing coverable
    // changed => 100% (gate passes), no files listed.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('still counts a genuine new source file whose name merely contains "test"', () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/attestation.ts'],
        changedLines: { 'src/attestation.ts': [1, 2, 3] },
      },
    })

    const patch = getPatchCoverage(options)
    // `attestation.ts` is real source (basename does not start with `test-`),
    // so it must still be gated as fully uncovered.
    expect(patch?.coverage).toBe(0)
    expect(patch?.totalLines).toBe(3)
    expect(patch?.files[0].instrumented).toBe(false)
  })

  test('resolves pass/fail against the configured threshold', () => {
    const failing = getPatchCoverage(
      baseOptions({
        patchThreshold: '80',
        changedFiles: {
          all: ['src/covered.js'],
          changedLines: { 'src/covered.js': [1, 2, 3] },
        },
      })
    )
    expect(failing?.threshold).toBe(80)
    expect(failing?.meetsThreshold).toBe(false)

    const passing = getPatchCoverage(
      baseOptions({
        patchThreshold: '50',
        changedFiles: {
          all: ['src/covered.js'],
          changedLines: { 'src/covered.js': [1, 2, 3] },
        },
      })
    )
    expect(passing?.meetsThreshold).toBe(true)
  })

  test('is advisory (no threshold) when patchThreshold is unset', () => {
    const patch = getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/covered.js'],
          changedLines: { 'src/covered.js': [1, 2, 3] },
        },
      })
    )
    expect(patch?.threshold).toBeNull()
    expect(patch?.meetsThreshold).toBeNull()
  })

  test('returns null when no line-level coverage source is provided', () => {
    const options = baseOptions({ coverageLcovFile: '' })
    options.changedFiles = {
      all: ['src/covered.js'],
      changedLines: { 'src/covered.js': [1] },
    }
    expect(getPatchCoverage(options)).toBeNull()
  })

  test('does not hardcode service-layout paths; they are gated without coverageExclude', () => {
    const options = baseOptions({
      changedFiles: {
        all: ['api/controllers/HealthController.ts', 'config/http.ts'],
        changedLines: {
          'api/controllers/HealthController.ts': [1, 2, 3],
          'config/http.ts': [4, 5],
        },
      },
    })

    const patch = getPatchCoverage(options)
    // This is a generic action: it applies only the universal defaults. Any
    // org/service layout (e.g. Photon's api/controllers, config) is supplied by
    // the caller via coverage-exclude, so absent source is gated by default.
    expect(patch?.totalLines).toBe(5)
    expect(patch?.coverage).toBe(0)
    expect(patch?.files).toHaveLength(2)
  })

  test('repo-provided coverageExclude skips project-excluded files with no coverage data', () => {
    const options = baseOptions({
      coverageExclude: ['api/controllers/**', 'config/**'],
      changedFiles: {
        all: ['api/controllers/HealthController.ts', 'config/http.ts'],
        changedLines: {
          'api/controllers/HealthController.ts': [1, 2, 3],
          'config/http.ts': [4, 5],
        },
      },
    })

    const patch = getPatchCoverage(options)
    // Both are excluded from instrumentation by the project => not gated.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('repo-provided coverageExclude is additive, not a replacement of defaults', () => {
    const options = baseOptions({
      coverageExclude: ['api/controllers/**'],
      changedFiles: {
        all: ['api/controllers/HealthController.ts', 'src/new-feature.ts'],
        changedLines: {
          'api/controllers/HealthController.ts': [1, 2],
          'src/new-feature.ts': [1, 2, 3],
        },
      },
    })

    const patch = getPatchCoverage(options)
    // Controller excluded by the repo pattern; the genuine new source file is
    // still gated as fully uncovered (defaults + repo excludes both apply).
    expect(patch?.totalLines).toBe(3)
    expect(patch?.coverage).toBe(0)
    expect(patch?.files).toHaveLength(1)
    expect(patch?.files[0].file).toBe('src/new-feature.ts')
  })
})

describe('globToRegExp', () => {
  test('matches ** across path segments', () => {
    expect(
      globToRegExp('api/controllers/**').test('api/controllers/A.ts')
    ).toBe(true)
    expect(
      globToRegExp('api/controllers/**').test('api/controllers/deep/B.ts')
    ).toBe(true)
    expect(globToRegExp('api/controllers/**').test('api/models/A.ts')).toBe(
      false
    )
  })

  test('**/ matches zero or more leading directories', () => {
    const re = globToRegExp('**/*.config.js')
    expect(re.test('jest.config.js')).toBe(true)
    expect(re.test('packages/app/webpack.config.js')).toBe(true)
    expect(re.test('src/app.js')).toBe(false)
  })

  test('* stays within a single segment', () => {
    const re = globToRegExp('config/*.ts')
    expect(re.test('config/http.ts')).toBe(true)
    expect(re.test('config/env/test.ts')).toBe(false)
  })

  test('test-runner default pattern does not match unrelated source', () => {
    const re = globToRegExp('**/test-*.js')
    expect(re.test('npm/test-unit.js')).toBe(true)
    expect(re.test('src/attestation.js')).toBe(false)
  })
})
