import { expect, test } from "#test-runtime"
import { normalizeSymbolsForRuntime, type CompatSymbolDefinitions } from "./ffi"

test("normalizeSymbolsForRuntime maps shared symbol shape to bun ffi shape", () => {
  const symbols: CompatSymbolDefinitions = {
    add: {
      parameters: ["u32", "u32"],
      result: "u32",
    },
  }

  const out = normalizeSymbolsForRuntime(symbols, "bun") as {
    add: { args: string[]; returns: string }
  }

  expect(out.add.args).toEqual(["u32", "u32"])
  expect(out.add.returns).toBe("u32")
})

test("normalizeSymbolsForRuntime maps shared symbol shape to deno ffi shape", () => {
  const symbols: CompatSymbolDefinitions = {
    write: {
      args: ["ptr", "usize"],
      returns: "i32",
    },
  }

  const out = normalizeSymbolsForRuntime(symbols, "deno") as {
    write: { parameters: string[]; result: string }
  }

  expect(out.write.parameters).toEqual(["pointer", "usize"])
  expect(out.write.result).toBe("i32")
})
