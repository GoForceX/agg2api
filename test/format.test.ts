/**
 * Admin UI formatters.
 *
 * These live with the server tests because the repository has one test runner; the
 * module under test is presentation-only but its output is what an operator reads, and
 * a wrong formatter is indistinguishable from wrong data.
 */
import { describe, expect, test } from "bun:test"
import { formatBucket, formatCompact, formatCredits, formatInt } from "../web/src/lib/format.ts"

describe("formatCredits", () => {
  test("keeps fractional balances instead of rounding them away", () => {
    // Credit balances are small decimal quantities. `formatCompact` is a token-count
    // formatter that rounds to whole numbers, so it displayed 10.5 as "11", 4.25 as
    // "4", and anything under 0.5 as "0" — which reads as an exhausted account.
    expect(formatCredits(10.5)).toBe("10.5")
    expect(formatCredits(4.25)).toBe("4.25")
    expect(formatCredits(14.75)).toBe("14.75")
    expect(formatCredits(42.75)).toBe("42.75")
    expect(formatCredits(0.25)).toBe("0.25")
    expect(formatCredits(999.9)).toBe("999.9")
  })

  test("keeps the exact figure for balances an operator is budgeting", () => {
    // A 7032-credit pool is actionable to the digit; "7.0k" is not.
    expect(formatCredits(2256)).toBe("2,256")
    expect(formatCredits(4776)).toBe("4,776")
    expect(formatCredits(7032)).toBe("7,032")
  })

  test("only abbreviates a pool large enough that digits stop mattering", () => {
    expect(formatCredits(250_000)).toBe("250k")
    expect(formatCredits(1_500_000)).toBe("1.5M")
  })

  test("renders zero and unknown distinctly", () => {
    expect(formatCredits(0)).toBe("0")
    expect(formatCredits(null)).toBe("—")
    expect(formatCredits(Number.NaN)).toBe("—")
  })
})

describe("formatCompact", () => {
  test("remains the integer formatter token counts need", () => {
    expect(formatCompact(10.5)).toBe("11")
    expect(formatCompact(999)).toBe("999")
    expect(formatCompact(1250)).toBe("1.3k")
    expect(formatInt(1234567)).toBe("1,234,567")
  })
})

describe("formatBucket", () => {
  test("uses the coarsest exact unit so a bucket width reads naturally", () => {
    // A 30-minute bucket went through `formatMs`, which is a latency formatter, and
    // rendered as "1800.0 秒".
    expect(formatBucket(1_800_000)).toBe("30 分钟")
    expect(formatBucket(60_000)).toBe("1 分钟")
    expect(formatBucket(10_800_000)).toBe("3 小时")
    expect(formatBucket(86_400_000)).toBe("1 天")
    expect(formatBucket(1500)).toBe("1500 毫秒")
    expect(formatBucket(0)).toBe("—")
  })
})
