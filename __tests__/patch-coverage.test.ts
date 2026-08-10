import { expect, test, describe, jest, beforeEach } from '@jest/globals'
import {
  getPatchCoverage,
  globToRegExp,
  patchCoverageToMarkdown,
} from '../src/patch-coverage'
import { parsePatchAddedLines } from '../src/changed-files'
import { isNonInstrumentableSource } from '../src/non-instrumentable'
import { Options } from '../src/types'

// Detection fetches source over the network; mock it so patch-coverage tests
// stay offline. Default is the fail-safe (false => keep flagging); individual
// tests opt specific files into "non-instrumentable" as needed. ts-jest hoists
// this above the imports so the mock is in place when patch-coverage loads.
jest.mock('../src/non-instrumentable', () => ({
  isNonInstrumentableSource: jest.fn(async () => false),
}))

const mockedIsNonInstrumentable =
  isNonInstrumentableSource as jest.MockedFunction<
    typeof isNonInstrumentableSource
  >

beforeEach(() => {
  mockedIsNonInstrumentable.mockReset()
  mockedIsNonInstrumentable.mockResolvedValue(false)
})

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
  test('computes coverage over changed executable lines only', async () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/covered.js'],
        // line 4 is not executable (absent from lcov) and must be ignored
        changedLines: { 'src/covered.js': [1, 2, 3, 4] },
      },
    })

    const patch = await getPatchCoverage(options)
    expect(patch).not.toBeNull()
    expect(patch?.totalLines).toBe(3)
    expect(patch?.coveredLines).toBe(2)
    expect(patch?.coverage).toBe(66.67)
    expect(patch?.files[0].uncoveredLines).toEqual([3])
    expect(patch?.files[0].instrumented).toBe(true)
  })

  test('counts a new untested source file as fully uncovered (strict)', async () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/new-feature.ts'],
        changedLines: { 'src/new-feature.ts': [1, 2, 3] },
      },
    })

    const patch = await getPatchCoverage(options)
    expect(patch?.coverage).toBe(0)
    expect(patch?.totalLines).toBe(3)
    expect(patch?.files[0].instrumented).toBe(false)
  })

  test('ignores non-source changed files with no coverage data', async () => {
    const options = baseOptions({
      changedFiles: {
        all: ['README.md', 'docs/config.yml'],
        changedLines: { 'README.md': [1, 2], 'docs/config.yml': [3] },
      },
    })

    const patch = await getPatchCoverage(options)
    // Nothing coverable changed => 100% (gate passes), no files listed.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('ignores changed tooling/config files with no coverage data', async () => {
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

    const patch = await getPatchCoverage(options)
    // Config files are excluded from instrumentation by design => nothing
    // coverable changed => 100% (gate passes), no files listed.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('ignores changed test-runner / CI wrapper scripts with no coverage data', async () => {
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

    const patch = await getPatchCoverage(options)
    // Runner/harness wrappers are not instrumented source => nothing coverable
    // changed => 100% (gate passes), no files listed.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('still counts a genuine new source file whose name merely contains "test"', async () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/attestation.ts'],
        changedLines: { 'src/attestation.ts': [1, 2, 3] },
      },
    })

    const patch = await getPatchCoverage(options)
    // `attestation.ts` is real source (basename does not start with `test-`),
    // so it must still be gated as fully uncovered.
    expect(patch?.coverage).toBe(0)
    expect(patch?.totalLines).toBe(3)
    expect(patch?.files[0].instrumented).toBe(false)
  })

  test('resolves pass/fail against the configured threshold', async () => {
    const failing = await getPatchCoverage(
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

    const passing = await getPatchCoverage(
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

  test('is advisory (no threshold) when patchThreshold is unset', async () => {
    const patch = await getPatchCoverage(
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

  test('returns null when no line-level coverage source is provided', async () => {
    const options = baseOptions({ coverageLcovFile: '' })
    options.changedFiles = {
      all: ['src/covered.js'],
      changedLines: { 'src/covered.js': [1] },
    }
    expect(await getPatchCoverage(options)).toBeNull()
  })

  test('does not hardcode service-layout paths; they are gated without coverageExclude', async () => {
    const options = baseOptions({
      changedFiles: {
        all: ['api/controllers/HealthController.ts', 'config/http.ts'],
        changedLines: {
          'api/controllers/HealthController.ts': [1, 2, 3],
          'config/http.ts': [4, 5],
        },
      },
    })

    const patch = await getPatchCoverage(options)
    // This is a generic action: it applies only the universal defaults. Any
    // org/service layout (e.g. Photon's api/controllers, config) is supplied by
    // the caller via coverage-exclude, so absent source is gated by default.
    expect(patch?.totalLines).toBe(5)
    expect(patch?.coverage).toBe(0)
    expect(patch?.files).toHaveLength(2)
  })

  test('gates .mts/.cts source but excludes their declaration/config variants', async () => {
    const options = baseOptions({
      changedFiles: {
        all: ['src/feature.mts', 'src/types.d.mts', 'app.config.cts'],
        changedLines: {
          'src/feature.mts': [1, 2, 3],
          'src/types.d.mts': [1, 2],
          'app.config.cts': [4],
        },
      },
    })

    const patch = await getPatchCoverage(options)
    // .mts source is now gated; .d.mts declarations and *.config.* are excluded.
    expect(patch?.totalLines).toBe(3)
    expect(patch?.files).toHaveLength(1)
    expect(patch?.files[0].file).toBe('src/feature.mts')
    expect(patch?.coverage).toBe(0)
  })

  test('repo-provided coverageExclude skips project-excluded files with no coverage data', async () => {
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

    const patch = await getPatchCoverage(options)
    // Both are excluded from instrumentation by the project => not gated.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
  })

  test('repo-provided coverageExclude is additive, not a replacement of defaults', async () => {
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

    const patch = await getPatchCoverage(options)
    // Controller excluded by the repo pattern; the genuine new source file is
    // still gated as fully uncovered (defaults + repo excludes both apply).
    expect(patch?.totalLines).toBe(3)
    expect(patch?.coverage).toBe(0)
    expect(patch?.files).toHaveLength(1)
    expect(patch?.files[0].file).toBe('src/new-feature.ts')
  })
})

describe('getPatchCoverage isNew flag', () => {
  test('marks a git-added uninstrumented file as new', async () => {
    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/new-feature.ts'],
          added: ['src/new-feature.ts'],
          changedLines: { 'src/new-feature.ts': [1, 2, 3] },
        },
      })
    )
    expect(patch?.files[0].instrumented).toBe(false)
    expect(patch?.files[0].isNew).toBe(true)
  })

  test('does not mark a modified uninstrumented file as new', async () => {
    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/types.ts'],
          modified: ['src/types.ts'],
          changedLines: { 'src/types.ts': [1, 2, 3] },
        },
      })
    )
    expect(patch?.files[0].instrumented).toBe(false)
    expect(patch?.files[0].isNew).toBe(false)
  })
})

describe('patchCoverageToMarkdown file table labels', () => {
  test('labels a truly-added uninstrumented file as "new file"', async () => {
    const options = baseOptions({
      patchThreshold: '80',
      changedFiles: {
        all: ['src/new-feature.ts'],
        added: ['src/new-feature.ts'],
        changedLines: { 'src/new-feature.ts': [1, 2, 3] },
      },
    })

    const patch = await getPatchCoverage(options)
    expect(patch).not.toBeNull()
    const md = patchCoverageToMarkdown(
      patch as NonNullable<typeof patch>,
      options
    )
    expect(md).toContain('\u26a0\ufe0f new file (0/3)')
    expect(md).not.toContain('no coverage data')
    expect(md).toContain('_no test coverage_')
  })

  test('labels a modified uninstrumented file as "no coverage data"', async () => {
    const options = baseOptions({
      patchThreshold: '80',
      changedFiles: {
        all: ['src/types.ts'],
        modified: ['src/types.ts'],
        changedLines: { 'src/types.ts': [1, 2, 3] },
      },
    })

    const patch = await getPatchCoverage(options)
    expect(patch).not.toBeNull()
    const md = patchCoverageToMarkdown(
      patch as NonNullable<typeof patch>,
      options
    )
    expect(md).toContain('\u26a0\ufe0f no coverage data (0/3)')
    expect(md).not.toContain('new file')
    expect(md).toContain('_no test coverage_')
  })
})

describe('getPatchCoverage non-instrumentable detection', () => {
  test('skips a type-only file that is absent from the report', async () => {
    mockedIsNonInstrumentable.mockImplementation(
      async (_options, file) => file === 'src/types.ts'
    )

    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/types.ts'],
          added: ['src/types.ts'],
          changedLines: { 'src/types.ts': [1, 2, 3] },
        },
      })
    )

    // Emits no runtime JS => not counted toward the patch total and not shown.
    expect(patch?.totalLines).toBe(0)
    expect(patch?.coverage).toBe(100)
    expect(patch?.files).toHaveLength(0)
    expect(mockedIsNonInstrumentable).toHaveBeenCalledWith(
      expect.anything(),
      'src/types.ts'
    )
  })

  test('skips a pure re-export barrel that is absent from the report', async () => {
    mockedIsNonInstrumentable.mockImplementation(
      async (_options, file) => file === 'src/index.ts'
    )

    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/index.ts'],
          added: ['src/index.ts'],
          changedLines: { 'src/index.ts': [1, 2] },
        },
      })
    )

    expect(patch?.totalLines).toBe(0)
    expect(patch?.files).toHaveLength(0)
  })

  test('still flags a real-logic file that emits runtime JS', async () => {
    mockedIsNonInstrumentable.mockResolvedValue(false)

    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/service.ts'],
          added: ['src/service.ts'],
          changedLines: { 'src/service.ts': [1, 2, 3] },
        },
      })
    )

    expect(patch?.totalLines).toBe(3)
    expect(patch?.coverage).toBe(0)
    expect(patch?.files).toHaveLength(1)
    expect(patch?.files[0].instrumented).toBe(false)
  })

  test('fails safe: still flags the file when detection cannot decide', async () => {
    // fetch/parse failure is surfaced by the detector returning false.
    mockedIsNonInstrumentable.mockResolvedValue(false)

    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/maybe-types.ts'],
          changedLines: { 'src/maybe-types.ts': [1, 2] },
        },
      })
    )

    expect(patch?.totalLines).toBe(2)
    expect(patch?.files).toHaveLength(1)
    expect(patch?.files[0].instrumented).toBe(false)
  })

  test('does not run detection for instrumented files present in the report', async () => {
    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/covered.js'],
          changedLines: { 'src/covered.js': [1, 2, 3] },
        },
      })
    )

    expect(patch?.files[0].instrumented).toBe(true)
    expect(mockedIsNonInstrumentable).not.toHaveBeenCalled()
  })

  test('skips only the non-instrumentable file in a mixed changeset', async () => {
    mockedIsNonInstrumentable.mockImplementation(
      async (_options, file) => file === 'src/types.ts'
    )

    const patch = await getPatchCoverage(
      baseOptions({
        changedFiles: {
          all: ['src/types.ts', 'src/service.ts'],
          added: ['src/types.ts', 'src/service.ts'],
          changedLines: {
            'src/types.ts': [1, 2, 3],
            'src/service.ts': [1, 2],
          },
        },
      })
    )

    expect(patch?.files).toHaveLength(1)
    expect(patch?.files[0].file).toBe('src/service.ts')
    expect(patch?.totalLines).toBe(2)
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
