/// <reference lib="deno.ns" />

import { AsyncLocalStorage } from "node:async_hooks"
import { basename, dirname, join } from "node:path"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe as bddDescribe,
  it as bddIt,
  test as bddTest,
} from "jsr:@std/testing/bdd"
import { expect, fn } from "jsr:@std/expect"
import { fromFileUrl } from "jsr:@std/path/from-file-url"

type AnyFunction = (...args: any[]) => any

type MockFunction<T extends AnyFunction = AnyFunction> = T & {
  mockClear: () => void
  mockImplementation: (nextImpl: T) => MockFunction<T>
  mockRestore: () => void
}

type CurrentTestState = {
  context: Deno.TestContext
  fullName: string
  snapshotCallCounts: Map<string, number>
}

const testStateStore = new AsyncLocalStorage<CurrentTestState>()
const describeStack: string[] = []
const snapshotCache = new Map<string, Map<string, string>>()

function normalizeNamePart(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function getFullTestName(name: string): string {
  return [...describeStack, normalizeNamePart(name)].join(" ").trim()
}

function withDescribeScope(name: string, fn: () => void): void {
  describeStack.push(normalizeNamePart(name))
  try {
    fn()
  } finally {
    describeStack.pop()
  }
}

function wrapDescribe(base: (...args: any[]) => void): (...args: any[]) => void {
  return (...args: any[]): void => {
    if (typeof args[0] === "string" && typeof args[1] === "function") {
      const [name, callback] = args as [string, () => void]
      base(name, () => withDescribeScope(name, callback))
      return
    }

    base(...args)
  }
}

function wrapTest(base: (...args: any[]) => void): (...args: any[]) => void {
  return (...args: any[]): void => {
    if (typeof args[0] === "string" && typeof args[args.length - 1] === "function") {
      const testName = normalizeNamePart(args[0])
      const callbackIndex = args.length - 1
      const callback = args[callbackIndex] as (t: Deno.TestContext) => unknown
      const fullName = getFullTestName(testName)

      args[callbackIndex] = (t: Deno.TestContext) => {
        return testStateStore.run(
          {
            context: t,
            fullName,
            snapshotCallCounts: new Map(),
          },
          () => callback(t),
        )
      }
    }

    base(...args)
  }
}

function formatEachName(template: string, values: unknown[], index: number): string {
  let valueIndex = 0
  const replaced = template.replace(/%[sdifjo]/g, () => {
    const value = values[valueIndex++]
    return formatValue(value)
  })

  if (replaced !== template) {
    return replaced
  }

  return `${template} (${values.map(formatValue).join(", ")}) [${index + 1}]`
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value)
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

type TestApi = ((...args: any[]) => void) & {
  only: (...args: any[]) => void
  skip: (...args: any[]) => void
  each: (cases: readonly unknown[]) => (name: string, callback: (...args: any[]) => unknown) => void
}

function createTestApi(
  base: (...args: any[]) => void,
  only: (...args: any[]) => void,
  skip: (...args: any[]) => void,
): TestApi {
  const wrapped = wrapTest(base) as TestApi
  wrapped.only = wrapTest(only)
  wrapped.skip = wrapTest(skip)
  wrapped.each = (cases: readonly unknown[]) => {
    return (name: string, callback: (...args: any[]) => unknown): void => {
      cases.forEach((entry, index) => {
        const args = Array.isArray(entry) ? entry : [entry]
        wrapped(formatEachName(name, args, index), () => callback(...args))
      })
    }
  }
  return wrapped
}

export const describe = wrapDescribe(bddDescribe) as ((...args: any[]) => void) & {
  only: (...args: any[]) => void
  skip: (...args: any[]) => void
}
describe.only = wrapDescribe((bddDescribe as any).only)
describe.skip = wrapDescribe((bddDescribe as any).skip)

export const test = createTestApi(bddTest as any, (bddTest as any).only, (bddTest as any).skip)
export const it = createTestApi(bddIt as any, (bddIt as any).only, (bddIt as any).skip)

function resolveCurrentTestFilePath(origin: string): string {
  try {
    return fromFileUrl(origin)
  } catch {
    return origin
  }
}

function normalizeTemplateLiteralContent(value: string): string {
  let out = value.replace(/\r\n/g, "\n")
  if (out.startsWith("\n")) {
    out = out.slice(1)
  }
  if (out.endsWith("\n")) {
    out = out.slice(0, -1)
  }
  return out
}

function normalizeInlineSnapshot(value: string): string {
  const lines = normalizeTemplateLiteralContent(value).split("\n")
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
  const indent =
    nonEmptyLines.length === 0 ? 0 : Math.min(...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0))

  return lines.map((line) => line.slice(Math.min(indent, line.length))).join("\n")
}

function serializeSnapshotValue(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`
  }

  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function getSnapshotEntriesForFile(testFilePath: string): Map<string, string> {
  const snapshotPath = join(dirname(testFilePath), "__snapshots__", `${basename(testFilePath)}.snap`)

  const cached = snapshotCache.get(snapshotPath)
  if (cached) {
    return cached
  }

  let fileContent = ""
  try {
    fileContent = Deno.readTextFileSync(snapshotPath)
  } catch {
    const empty = new Map<string, string>()
    snapshotCache.set(snapshotPath, empty)
    return empty
  }

  const snapshots = new Map<string, string>()
  const pattern = /exports\[`([\s\S]*?)`\]\s*=\s*`([\s\S]*?)`;/g

  let match: RegExpExecArray | null
  while ((match = pattern.exec(fileContent)) !== null) {
    const key = match[1]?.replace(/\\`/g, "`")
    const rawValue = match[2]
    if (key !== undefined && rawValue !== undefined) {
      snapshots.set(key, normalizeTemplateLiteralContent(rawValue))
    }
  }

  snapshotCache.set(snapshotPath, snapshots)
  return snapshots
}

function getCurrentSnapshotKey(hint?: string): { key: string; testFilePath: string } {
  const state = testStateStore.getStore()
  if (!state) {
    throw new Error("toMatchSnapshot can only be used inside a test callback.")
  }

  let keyBase = state.fullName
  if (hint && hint.length > 0) {
    keyBase = `${keyBase}: ${hint}`
  }

  const nextCount = (state.snapshotCallCounts.get(keyBase) ?? 0) + 1
  state.snapshotCallCounts.set(keyBase, nextCount)

  return {
    key: `${keyBase} ${nextCount}`,
    testFilePath: resolveCurrentTestFilePath(state.context.origin),
  }
}

function buildMismatchMessage(kind: string, expected: string, received: string): string {
  return `${kind} mismatch\nExpected:\n${expected}\n\nReceived:\n${received}`
}

expect.extend({
  toMatchInlineSnapshot(context: any, inlineSnapshot: unknown) {
    if (typeof inlineSnapshot !== "string") {
      return {
        pass: false,
        message: () => "toMatchInlineSnapshot expects a snapshot string argument.",
      }
    }

    const received = serializeSnapshotValue(context.value)
    const expected = normalizeInlineSnapshot(inlineSnapshot)
    const pass = received === expected

    return {
      pass,
      message: () => buildMismatchMessage("Inline snapshot", expected, received),
    }
  },

  toMatchSnapshot(context: any, hint?: unknown) {
    const snapshotHint = typeof hint === "string" ? hint : undefined
    const received = serializeSnapshotValue(context.value)

    let key: string
    let testFilePath: string
    try {
      const current = getCurrentSnapshotKey(snapshotHint)
      key = current.key
      testFilePath = current.testFilePath
    } catch (error) {
      return {
        pass: false,
        message: () => (error instanceof Error ? error.message : "Unable to resolve snapshot context."),
      }
    }

    const snapshots = getSnapshotEntriesForFile(testFilePath)
    const expected = snapshots.get(key)

    if (expected === undefined) {
      return {
        pass: false,
        message: () => `Missing Bun snapshot entry: ${key}`,
      }
    }

    const pass = received === expected
    return {
      pass,
      message: () => buildMismatchMessage(`Snapshot (${key})`, expected, received),
    }
  },
})

function getMockCallsSymbol(value: Function): symbol | undefined {
  return Object.getOwnPropertySymbols(value).find((symbol) => symbol.toString() === "Symbol(@MOCK)")
}

function clearMockCalls(value: Function): void {
  const symbol = getMockCallsSymbol(value)
  if (!symbol) {
    return
  }

  const metadata = (value as any)[symbol] as { calls?: unknown[] } | undefined
  if (metadata?.calls && Array.isArray(metadata.calls)) {
    metadata.calls.length = 0
  }
}

function createMockFunction<T extends AnyFunction>(implementation: T, onRestore?: () => void): MockFunction<T> {
  let currentImplementation: AnyFunction = implementation

  const mocked = fn(function (this: unknown, ...args: unknown[]) {
    return currentImplementation.apply(this, args)
  }) as unknown as MockFunction<T>

  mocked.mockClear = () => {
    clearMockCalls(mocked)
  }

  mocked.mockImplementation = (nextImpl: T) => {
    currentImplementation = nextImpl
    return mocked
  }

  mocked.mockRestore = () => {
    onRestore?.()
  }

  return mocked
}

export function mock<T extends AnyFunction>(implementation?: T): MockFunction<T> {
  const fallback = ((..._args: unknown[]) => undefined) as unknown as T
  return createMockFunction(implementation ?? fallback)
}

export function spyOn<T extends object, K extends keyof T>(target: T, methodName: K): MockFunction<AnyFunction> {
  const original = target[methodName]
  if (typeof original !== "function") {
    throw new TypeError(`Cannot spyOn non-function property: ${String(methodName)}`)
  }

  const originalFn = original as unknown as AnyFunction
  const spy = createMockFunction(function (this: unknown, ...args: unknown[]) {
    return originalFn.apply(this, args)
  })

  ;(target as Record<PropertyKey, unknown>)[methodName as PropertyKey] = spy as unknown as T[K]
  spy.mockRestore = () => {
    ;(target as Record<PropertyKey, unknown>)[methodName as PropertyKey] = original
  }

  return spy
}

export { afterAll, afterEach, beforeAll, beforeEach, expect }
