import { test, expect } from "bun:test"
import { installWin32ProcessedInputGuard } from "../lib/win32-console"

test("installWin32ProcessedInputGuard clears ENABLE_PROCESSED_INPUT", () => {
  let mode = 0b1011
  const setModes: number[] = []
  const ignoreCalls: boolean[] = []

  const console = {
    getMode: () => mode,
    setMode: (next: number) => {
      setModes.push(next)
      mode = next
    },
    setIgnoreCtrlC: (ignore: boolean) => {
      ignoreCalls.push(ignore)
    },
  }

  const immediates: Array<() => void> = []
  const intervals: Array<() => void> = []

  const guard = installWin32ProcessedInputGuard(console, {
    interval: 50,
    scheduler: {
      setImmediate: (fn) => {
        immediates.push(fn)
        return 0 as any
      },
      setInterval: (fn) => {
        intervals.push(fn)
        return 1 as any
      },
      clearInterval: () => {},
    },
  })

  expect(mode & 0b1).toBe(0)
  expect(setModes).toEqual([0b1010])
  expect(ignoreCalls).toEqual([true])
  expect(immediates.length).toBe(1)
  expect(intervals.length).toBe(1)

  immediates[0]!()
  expect(setModes).toEqual([0b1010])

  mode |= 0b1
  intervals[0]!()
  expect(mode & 0b1).toBe(0)
  expect(setModes).toEqual([0b1010, 0b1010])

  guard.dispose()
  expect(ignoreCalls).toEqual([true, false])
})

test("installWin32ProcessedInputGuard is a no-op when already cleared", () => {
  let mode = 0b1010
  let sets = 0

  const guard = installWin32ProcessedInputGuard(
    {
      getMode: () => mode,
      setMode: () => {
        sets++
      },
    },
    {
      scheduler: {
        setImmediate: () => 0 as any,
        setInterval: () => 1 as any,
        clearInterval: () => {},
      },
    },
  )

  expect(sets).toBe(0)
  guard.enforce()
  expect(sets).toBe(0)
  guard.dispose()
})

test("installWin32ProcessedInputGuard dispose clears interval", () => {
  let cleared: any
  const ignoreCalls: boolean[] = []

  const guard = installWin32ProcessedInputGuard(
    {
      getMode: () => 0,
      setMode: () => {},
      setIgnoreCtrlC: (ignore: boolean) => {
        ignoreCalls.push(ignore)
      },
    },
    {
      scheduler: {
        setImmediate: () => 0 as any,
        setInterval: () => "interval-id" as any,
        clearInterval: (id) => {
          cleared = id
        },
      },
    },
  )

  guard.dispose()
  expect(cleared).toBe("interval-id")
  expect(ignoreCalls).toEqual([true, false])
})
