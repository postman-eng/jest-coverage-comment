import { expect, test, describe, jest, beforeEach } from '@jest/globals'
import { getOctokit } from '@actions/github'
import {
  emitsRuntimeJavaScript,
  fetchFileAtHead,
  isNonInstrumentableSource,
} from '../src/non-instrumentable'
import { Options } from '../src/types'

// Hoisted above the imports by ts-jest so the mock is in place when the module
// under test is loaded.
jest.mock('@actions/github', () => ({
  context: { repo: { owner: 'postman-eng', repo: 'example' } },
  getOctokit: jest.fn(),
}))

const mockedGetOctokit = getOctokit as jest.MockedFunction<typeof getOctokit>

function baseOptions(overrides: Partial<Options> = {}): Options {
  return {
    token: 'token_123',
    repository: 'postman-eng/example',
    serverUrl: 'https://github.com',
    commit: 'headsha',
    watermark: '',
    prefix: '',
    coveragePathPrefix: '',
    badgeTitle: 'Net Coverage',
    summaryFile: '',
    netCoverageMain: '0',
    ...overrides,
  }
}

function mockContent(source: string): void {
  const getContent = jest.fn(async () => ({
    data: {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(source, 'utf8').toString('base64'),
    },
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetOctokit.mockReturnValue({ rest: { repos: { getContent } } } as any)
}

beforeEach(() => {
  mockedGetOctokit.mockReset()
})

describe('emitsRuntimeJavaScript', () => {
  test('type-only files emit nothing', () => {
    expect(
      emitsRuntimeJavaScript(`import type { A } from './a'
export interface Widget {
  id: string
  nested: { count: number }
}
export type WidgetId = Widget['id']
type Handler = (w: Widget) => void
`)
    ).toBe(false)
  })

  test('multi-line union type aliases emit nothing', () => {
    expect(
      emitsRuntimeJavaScript(`export type Shape =
  | { kind: 'circle'; r: number }
  | { kind: 'square'; side: number }
`)
    ).toBe(false)
  })

  test('pure re-export barrels emit nothing', () => {
    expect(
      emitsRuntimeJavaScript(`export { Button } from './button'
export * from './inputs'
export * as icons from './icons'
export { type Theme, tokens } from './theme'
`)
    ).toBe(false)
  })

  test('multi-line and type-only barrels emit nothing', () => {
    expect(
      emitsRuntimeJavaScript(`export {
  Alpha,
  Beta,
} from './letters'
export type { Gamma } from './greek'
export {}
`)
    ).toBe(false)
  })

  test('side-effect-only imports emit nothing of their own', () => {
    expect(emitsRuntimeJavaScript(`import './polyfills'\n`)).toBe(false)
  })

  test('declare-only ambient modules emit nothing', () => {
    expect(
      emitsRuntimeJavaScript(`declare const __DEV__: boolean
declare function gtag(...args: unknown[]): void
`)
    ).toBe(false)
  })

  test('a const declaration emits runtime code', () => {
    expect(emitsRuntimeJavaScript(`export const answer = 42\n`)).toBe(true)
  })

  test('a function declaration emits runtime code', () => {
    expect(
      emitsRuntimeJavaScript(`export function add(a: number, b: number) {
  return a + b
}
`)
    ).toBe(true)
  })

  test('a class declaration emits runtime code', () => {
    expect(
      emitsRuntimeJavaScript(`export class Service {
  run() {
    return 1
  }
}
`)
    ).toBe(true)
  })

  test('an enum emits runtime code (conservative)', () => {
    expect(emitsRuntimeJavaScript(`export enum Color { Red, Green }\n`)).toBe(
      true
    )
  })

  test('types mixed with runtime code emit runtime code', () => {
    expect(
      emitsRuntimeJavaScript(`import type { A } from './a'
export type Id = string
export const registry = new Map<Id, A>()
`)
    ).toBe(true)
  })

  test('is not fooled by keywords inside strings or comments', () => {
    expect(
      emitsRuntimeJavaScript(`// export const shouldNotCount = 1
/* function alsoNot() {} */
export type Doc = { note: 'const x = 1; function y() {}' }
export { Doc as default } from './doc'
`)
    ).toBe(false)
  })

  test('empty or comment-only files emit nothing', () => {
    expect(emitsRuntimeJavaScript(`// just a comment\n\n`)).toBe(false)
    expect(emitsRuntimeJavaScript('')).toBe(false)
  })
})

describe('fetchFileAtHead', () => {
  test('returns decoded file content on success', async () => {
    mockContent('export type A = string\n')
    const content = await fetchFileAtHead(baseOptions(), 'src/types.ts')
    expect(content).toBe('export type A = string\n')
  })

  test('prefixes the coverage path prefix when fetching', async () => {
    const getContent = jest.fn(async () => ({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('x', 'utf8').toString('base64'),
      },
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetOctokit.mockReturnValue({ rest: { repos: { getContent } } } as any)

    await fetchFileAtHead(
      baseOptions({ coveragePathPrefix: 'packages/app/' }),
      'src/types.ts'
    )
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'postman-eng',
        repo: 'example',
        path: 'packages/app/src/types.ts',
        ref: 'headsha',
      })
    )
  })

  test('returns null when the token is missing', async () => {
    const content = await fetchFileAtHead(
      baseOptions({ token: '' }),
      'src/types.ts'
    )
    expect(content).toBeNull()
    expect(mockedGetOctokit).not.toHaveBeenCalled()
  })

  test('returns null when the head commit is missing', async () => {
    const content = await fetchFileAtHead(
      baseOptions({ commit: '' }),
      'src/types.ts'
    )
    expect(content).toBeNull()
  })

  test('returns null (fail safe) when the API call throws', async () => {
    const getContent = jest.fn(async () => {
      throw new Error('network down')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetOctokit.mockReturnValue({ rest: { repos: { getContent } } } as any)

    const content = await fetchFileAtHead(baseOptions(), 'src/types.ts')
    expect(content).toBeNull()
  })

  test('returns null when the path resolves to a directory', async () => {
    const getContent = jest.fn(async () => ({ data: [{ type: 'file' }] }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetOctokit.mockReturnValue({ rest: { repos: { getContent } } } as any)

    const content = await fetchFileAtHead(baseOptions(), 'src/dir')
    expect(content).toBeNull()
  })
})

describe('isNonInstrumentableSource', () => {
  test('true for a fetched type-only file', async () => {
    mockContent('export type A = string\nexport interface B { a: A }\n')
    expect(await isNonInstrumentableSource(baseOptions(), 'src/types.ts')).toBe(
      true
    )
  })

  test('false for a fetched runtime file', async () => {
    mockContent('export const x = 1\n')
    expect(
      await isNonInstrumentableSource(baseOptions(), 'src/service.ts')
    ).toBe(false)
  })

  test('false (fail safe) when the source cannot be fetched', async () => {
    const getContent = jest.fn(async () => {
      throw new Error('boom')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetOctokit.mockReturnValue({ rest: { repos: { getContent } } } as any)

    expect(await isNonInstrumentableSource(baseOptions(), 'src/x.ts')).toBe(
      false
    )
  })
})
