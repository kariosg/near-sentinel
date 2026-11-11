import { describe, expect, it } from "vitest";
import { formatNear, plural } from "../src/text.js";

describe("text helpers", () => {
  it("plural picks singular or plural by count", () => {
    expect(plural(1, "provider")).toBe("1 provider");
    expect(plural(0, "provider")).toBe("0 providers");
    expect(plural(3, "provider response")).toBe("3 provider responses");
  });

  it("formatNear converts yoctoNEAR exactly, without float rounding", () => {
    expect(formatNear("10000000000000000000000")).toBe("0.01");
    expect(formatNear("1000000000000000000000000")).toBe("1");
    expect(formatNear("1234567890000000000000000000")).toBe("1234.56789");
    expect(formatNear("1")).toBe("0");
    expect(formatNear("not-a-number")).toBe("0");
  });
});
