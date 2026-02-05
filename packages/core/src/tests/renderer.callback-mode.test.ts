import { test, expect } from "bun:test"
import { createTestRenderer } from "../testing/test-renderer"

test("callback output mode requires onFlush", async () => {
  await expect(createTestRenderer({ outputMode: "callback" })).rejects.toThrow('outputMode "callback" requires onFlush')
})
