import { describe, expect, it } from "vitest";
import { inferSchema } from "../src/schema.js";

describe("inferSchema", () => {
  it("marks keys present in every sample as required", () => {
    expect(inferSchema([{ id: 1, name: "a" }, { id: 2 }])).toEqual({
      type: "object",
      properties: { id: { type: "integer" }, name: { type: "string" } },
      required: ["id"],
    });
  });

  it("widens integer to number and adds null when observed", () => {
    expect(inferSchema([1, 2.5, null])).toEqual({ type: ["number", "null"] });
  });

  it("uses anyOf for genuinely mixed types", () => {
    expect(inferSchema(["a", 1])).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
  });

  it("detects string formats only when every value matches", () => {
    expect(inferSchema(["2024-01-01T10:00:00Z", "2024-02-01T10:00:00.123+02:00"])).toEqual({
      type: "string",
      format: "date-time",
    });
    expect(inferSchema(["a@b.co", "not an email"])).toEqual({ type: "string" });
  });

  it("turns recurring short strings into an enum", () => {
    expect(inferSchema(["active", "inactive", "active", "active", "inactive"])).toEqual({
      type: "string",
      enum: ["active", "inactive"],
    });
  });

  it("does not invent enums from few or unique values", () => {
    expect(inferSchema(["a", "b"])).toEqual({ type: "string" });
    expect(inferSchema(["alice", "bob", "carol", "dave"])).toEqual({ type: "string" });
  });

  it("merges array items across samples", () => {
    expect(inferSchema([[{ a: 1 }], [{ a: 2, b: true }]])).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "boolean" } },
        required: ["a"],
      },
    });
  });

  it("recognizes objects keyed by identifiers as maps", () => {
    expect(inferSchema([{ "101": { n: 1 }, "102": { n: 2 }, "103": { n: 3 } }])).toEqual({
      type: "object",
      additionalProperties: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
    });
  });

  it("only includes example values when asked", () => {
    expect(inferSchema(["secret-token"])).toEqual({ type: "string" });
    expect(inferSchema(["x"], { examples: true })).toEqual({ type: "string", examples: ["x"] });
    expect(inferSchema([3], { examples: true })).toEqual({ type: "integer", examples: [3] });
  });

  it("represents an empty array without inventing item types", () => {
    expect(inferSchema([[]])).toEqual({ type: "array", items: {} });
  });
});

describe("enum safety", () => {
  it("does not turn free text such as names into enums", () => {
    expect(inferSchema(["Mug", "Pen", "Mug", "Pen", "Mug"])).toEqual({ type: "string" });
    expect(inferSchema(["IN_PROGRESS", "DONE", "DONE", "DONE"])).toEqual({ type: "string", enum: ["DONE", "IN_PROGRESS"] });
  });
});
