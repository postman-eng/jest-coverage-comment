import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, describe, beforeAll, afterAll } from '@jest/globals'
import {
  getContentFile,
  getCoverageColor,
  getPathToFile,
  inferCoverageExclude,
  normalizeExcludeGlobs,
  parseLine,
} from '../src/utils'
import { spyCore } from './setup'

describe('should check all utils functions', () => {
  const GITHUB_WORKSPACE = process.cwd()
  const ORIGINAL_GITHUB_WORKSPACE = process.env.GITHUB_WORKSPACE

  beforeAll(() => {
    process.env.GITHUB_WORKSPACE = GITHUB_WORKSPACE
  })

  afterAll(() => {
    process.env.GITHUB_WORKSPACE = ORIGINAL_GITHUB_WORKSPACE
  })

  describe('should check getPathToFile', () => {
    test('should return empty string on empty path', () => {
      const pathToFile = getPathToFile('')
      expect(pathToFile).toBe('')
    })

    test('should return absolute path', () => {
      const pathToFile = getPathToFile('/tmp/file.js')
      expect(pathToFile).toBe('/tmp/file.js')
    })

    test('should return path with GITHUB_WORKSPACE', () => {
      const pathToFile = getPathToFile('myfolder/file.js')
      expect(pathToFile).toBe(`${GITHUB_WORKSPACE}/myfolder/file.js`)
    })
  })

  describe('should check getContentFile', () => {
    test('should return empty string', () => {
      const content = getContentFile('')

      expect(content).toEqual('')
      expect(spyCore.warning).toHaveBeenCalledTimes(1)
      expect(spyCore.warning).toHaveBeenCalledWith(
        'Path to file was not provided'
      )
    })

    test('should return empty string on non exist file', () => {
      const content = getContentFile('non-exist-file.json')

      expect(content).toEqual('')
      expect(spyCore.warning).toHaveBeenCalledTimes(1)
      expect(spyCore.warning).toHaveBeenCalledWith(
        `File "non-exist-file.json" doesn't exist`
      )
    })

    test('should return empty content on empty file', () => {
      const pathToFile = '__mocks__/empty.json'
      const content = getContentFile(pathToFile)

      expect(spyCore.warning).toHaveBeenCalledTimes(1)
      expect(content).toEqual('')
      expect(spyCore.warning).toHaveBeenCalledWith(
        `No content found in file "${pathToFile}"`
      )
    })

    test('should return empty content on empty file', () => {
      const pathToFile = '__mocks__/empty.json'
      const content = getContentFile(pathToFile)

      expect(spyCore.warning).toHaveBeenCalledTimes(1)
      expect(content).toEqual('')
      expect(spyCore.warning).toHaveBeenCalledWith(
        `No content found in file "${pathToFile}"`
      )
    })

    test('should return full content on file', () => {
      const pathToFile = '__mocks__/coverage.txt'
      const originalContent = readFileSync(
        `${GITHUB_WORKSPACE}/${pathToFile}`,
        'utf8'
      )
      const content = getContentFile(pathToFile)

      expect(spyCore.info).toHaveBeenCalledTimes(1)
      expect(content).toEqual(originalContent)
      expect(spyCore.info).toHaveBeenCalledWith(
        `File read successfully "${pathToFile}"`
      )
    })
  })

  describe('should check colors', () => {
    test('should return right colors', () => {
      expect(getCoverageColor(35)).toBe('red')
      expect(getCoverageColor(50)).toBe('orange')
      expect(getCoverageColor(70)).toBe('yellow')
      expect(getCoverageColor(85)).toBe('green')
      expect(getCoverageColor(95)).toBe('brightgreen')
    })

    test('should return default color', () => {
      expect(getCoverageColor(-1)).toBe('red')
    })
  })

  describe('parsing one-line', () => {
    test('should not parse bad line', () => {
      const parsedLine1 = parseLine('')
      const parsedLine2 = parseLine('some bad line')
      const parsedLine3 = parseLine('title only')
      const parsedLine4 = parseLine('./path/to/file.json')

      expect(parsedLine1).toBeNull()
      expect(parsedLine2).toBeNull()
      expect(parsedLine3).toBeNull()
      expect(parsedLine4).toBeNull()
    })

    test('should parse correctly one-line', async () => {
      const parsedLine1 = parseLine('title1, ./path/to/file.json')
      const parsedLine2 = parseLine('title1,./path/to/file.json')
      const expectedResult = { title: 'title1', file: './path/to/file.json' }

      expect(parsedLine1).toMatchObject(expectedResult)
      expect(parsedLine2).toMatchObject(expectedResult)
    })
  })
})

describe('normalizeExcludeGlobs', () => {
  test('expands bare directory paths to also match their contents', () => {
    expect(normalizeExcludeGlobs(['api/controllers'])).toEqual([
      'api/controllers',
      'api/controllers/**',
    ])
  })

  test('leaves glob patterns untouched and drops blanks', () => {
    expect(normalizeExcludeGlobs(['**/*.d.ts', '  ', 'src/*.ts'])).toEqual([
      '**/*.d.ts',
      'src/*.ts',
    ])
  })
})

describe('inferCoverageExclude', () => {
  let repoDir: string

  afterAll(() => {
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  test('reads NYC exclude from .nycrc.json', () => {
    repoDir = mkdtempSync(join(tmpdir(), 'jcc-nycrc-'))
    writeFileSync(
      join(repoDir, '.nycrc.json'),
      JSON.stringify({ exclude: ['api/controllers', '**/*.mock.ts'] })
    )

    expect(inferCoverageExclude(repoDir)).toEqual([
      'api/controllers',
      'api/controllers/**',
      '**/*.mock.ts',
    ])
  })

  test('reads NYC exclude from package.json and returns [] when absent', () => {
    const pkgDir = mkdtempSync(join(tmpdir(), 'jcc-pkg-'))
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ nyc: { exclude: ['config'] } })
    )
    expect(inferCoverageExclude(pkgDir)).toEqual(['config', 'config/**'])
    rmSync(pkgDir, { recursive: true, force: true })

    const emptyDir = mkdtempSync(join(tmpdir(), 'jcc-empty-'))
    expect(inferCoverageExclude(emptyDir)).toEqual([])
    rmSync(emptyDir, { recursive: true, force: true })
  })
})
