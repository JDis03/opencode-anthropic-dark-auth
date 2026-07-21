import { describe, it, expect } from "vitest";
import {
  estimateBodyTokens,
  sanitizeInputSchema,
  transformBody,
} from "./transforms.js";

describe("estimateBodyTokens", () => {
  it("returns 0 for empty/invalid input", () => {
    expect(estimateBodyTokens("")).toBe(0);
    expect(estimateBodyTokens(null as any)).toBe(0);
  });

  it("counts characters across system, messages, tool_result and tool_use blocks", () => {
    const body = JSON.stringify({
      system: [{ type: "text", text: "a".repeat(35) }], // 10 tokens @ 3.5 chars/token
      messages: [
        { role: "user", content: "b".repeat(35) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "c".repeat(35) },
            { type: "tool_use", input: { x: "d".repeat(31) } }, // JSON adds quotes/braces
          ],
        },
      ],
    });

    const tokens = estimateBodyTokens(body);
    // 3 blocks of ~35 chars text (~10 tokens each) plus a small tool_use JSON blob.
    expect(tokens).toBeGreaterThanOrEqual(30);
  });

  it("falls back to whole-body length estimate on unparsable JSON", () => {
    const body = "not json at all, just text ".repeat(5);
    const tokens = estimateBodyTokens(body);
    expect(tokens).toBe(Math.ceil(body.length / 3.5));
  });
});

describe("sanitizeInputSchema — regression: was lossy on property collisions", () => {
  it("passes through schemas without a root combinator returning an equivalent copy", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const result = sanitizeInputSchema(schema);
    expect(result).toEqual(schema);
    // But a fresh object — must not mutate or alias the input.
    expect(result).not.toBe(schema);
  });

  it("flattens oneOf branches into a single object schema", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    };

    const result = sanitizeInputSchema(schema);

    expect(result.type).toBe("object");
    expect(result.properties.a).toEqual({ type: "string" });
    expect(result.properties.b).toEqual({ type: "number" });
    // Neither branch agrees on the other's required field.
    expect(result.required).toBeUndefined();
  });

  it("keeps required fields that every branch agrees on", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
      ],
    };

    const result = sanitizeInputSchema(schema);

    expect(result.required).toEqual(["a"]);
  });

  it("does NOT silently drop a variant when two branches share a property name with different sub-schemas", () => {
    // Discriminated-union style: "value" is a string in one branch, a number in the other.
    const schema = {
      oneOf: [
        { type: "object", properties: { kind: { const: "text" }, value: { type: "string" } } },
        { type: "object", properties: { kind: { const: "count" }, value: { type: "number" } } },
      ],
    };

    const result = sanitizeInputSchema(schema);

    // Previous behaviour (Object.assign) would have silently kept only
    // { type: "number" } here, losing the string variant entirely.
    expect(result.properties.value.anyOf).toBeDefined();
    expect(result.properties.value.anyOf).toContainEqual({ type: "string" });
    expect(result.properties.value.anyOf).toContainEqual({ type: "number" });
  });

  it("does not duplicate identical colliding sub-schemas", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { value: { type: "string" } } },
        { type: "object", properties: { value: { type: "string" } } },
      ],
    };

    const result = sanitizeInputSchema(schema);

    expect(result.properties.value).toEqual({ type: "string" });
  });

  it("regression: sanitizes oneOf nested INSIDE a property, not just at the top level", () => {
    // The original error path: tools.75.custom.input_schema has a root-level
    // object schema, but one of its properties carries a oneOf — that's also
    // rejected by Anthropic's validator with the same error message.
    const schema = {
      type: "object",
      properties: {
        custom: {
          oneOf: [
            { type: "string" },
            { type: "number" },
          ],
        },
      },
    };

    const result = sanitizeInputSchema(schema);

    // The nested oneOf must be flattened too — no oneOf at any depth.
    expect(result.properties.custom.oneOf).toBeUndefined();
    expect(result.properties.custom.anyOf).toBeDefined();
    expect(result.properties.custom.anyOf).toContainEqual({ type: "string" });
    expect(result.properties.custom.anyOf).toContainEqual({ type: "number" });
  });

  it("regression: walks through array items and deeply nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              payload: {
                anyOf: [
                  { type: "string" },
                  { type: "null" },
                ],
              },
            },
          },
        },
      },
    };

    const result = sanitizeInputSchema(schema);

    const payload = (result.properties.items as any).items.properties.payload;
    expect(payload.anyOf).toBeDefined();
    expect(payload.anyOf).toContainEqual({ type: "string" });
    expect(payload.anyOf).toContainEqual({ type: "null" });
    expect(payload.oneOf).toBeUndefined();
  });

  it("does not mutate the original schema object", () => {
    const original = {
      type: "object",
      properties: {
        value: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(original));

    sanitizeInputSchema(original);

    expect(original).toEqual(snapshot);
  });
});

describe("transformBody — sanitizes tool input_schema end-to-end", () => {
  it("rewrites a root-level oneOf on a tool's input_schema so the request would not 400", () => {
    const body = JSON.stringify({
      messages: [],
      tools: [
        {
          name: "my_tool",
          input_schema: {
            oneOf: [
              { type: "object", properties: { a: { type: "string" } } },
              { type: "object", properties: { b: { type: "number" } } },
            ],
          },
        },
      ],
    });

    const result = JSON.parse(transformBody(body));

    expect(result.tools[0].input_schema.oneOf).toBeUndefined();
    expect(result.tools[0].input_schema.type).toBe("object");
    expect(result.tools[0].input_schema.properties.a).toBeDefined();
    expect(result.tools[0].input_schema.properties.b).toBeDefined();
  });
});
