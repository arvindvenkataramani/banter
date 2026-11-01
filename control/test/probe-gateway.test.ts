import { describe, it, expect } from "bun:test";
import { parseEnvFile, resolveValue } from "../probe/gateway";

describe("parseEnvFile", () => {
  it("reads KEY=value lines and skips comments and blanks", () => {
    const text = "# Sourced by scripts/control-dev.sh.\n\nOPENCLAW_GATEWAY_TOKEN=abc123\nOTHER=x=y\n";
    expect(parseEnvFile(text)).toEqual({ OPENCLAW_GATEWAY_TOKEN: "abc123", OTHER: "x=y" });
  });

  it.each([
    ['A="quoted value"', "quoted value"],
    ["A='single'", "single"],
    ["export A=exported", "exported"],
    ['A="unbalanced', '"unbalanced'],
    ["A=", ""],
  ])("%s", (line, expected) => {
    expect(parseEnvFile(line).A).toBe(expected);
  });

  it("ignores lines that are not assignments", () => {
    expect(parseEnvFile("set -a\n1BAD=x\n")).toEqual({});
  });
});

describe("resolveValue", () => {
  const secrets = { TOKEN: "from-file" };

  it.each([
    ["environment wins over the secrets file", "${TOKEN}", { TOKEN: "from-env" }, "from-env"],
    ["falls back to the secrets file", "${TOKEN}", {}, "from-file"],
    ["unset everywhere", "${MISSING}", {}, undefined],
    ["a literal is returned as is", "literal-token", {}, "literal-token"],
    ["a non-string is undefined", undefined, {}, undefined],
  ])("%s", (_name, value, env, expected) => {
    expect(resolveValue(value, env, secrets)).toBe(expected);
  });
});
