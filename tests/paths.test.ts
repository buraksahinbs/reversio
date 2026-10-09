import { describe, expect, it } from "vitest";
import { extractParamValues, isIdLike, templatePaths } from "../src/paths.js";

function templates(paths: string[]): Record<string, string> {
  return Object.fromEntries([...templatePaths(paths)].map(([raw, t]) => [raw, t.template]));
}

describe("isIdLike", () => {
  it.each(["42", "550e8400-e29b-41d4-a716-446655440000", "5f2b8c9e1a3d4e6f7a8b9c0d", "aB3dE5fG7hJ9kL1mN", "2024-05-01"])(
    "treats %s as an identifier",
    (s) => expect(isIdLike(s)).toBe(true),
  );
  it.each(["users", "v1", "graphql", "notifications-settings", "deadbeefcafe"])("treats %s as a literal", (s) =>
    expect(isIdLike(s)).toBe(false),
  );
});

describe("templatePaths", () => {
  it("names parameters after the preceding collection", () => {
    expect(templates(["/api/users/42", "/api/users/7/posts/550e8400-e29b-41d4-a716-446655440000"])).toEqual({
      "/api/users/42": "/api/users/{userId}",
      "/api/users/7/posts/550e8400-e29b-41d4-a716-446655440000": "/api/users/{userId}/posts/{postId}",
    });
  });

  it("collapses varying values that share a continuation", () => {
    const result = templates(["/repos/alice/issues", "/repos/bob/issues", "/repos/carol/issues"]);
    expect(new Set(Object.values(result))).toEqual(new Set(["/repos/{repoId}/issues"]));
  });

  it("keeps distinct resource collections apart", () => {
    const result = templates(["/api/users", "/api/orders", "/api/products", "/api/invoices"]);
    expect(Object.values(result).sort()).toEqual(["/api/invoices", "/api/orders", "/api/products", "/api/users"]);
  });

  it("collapses trailing slugs that look like data", () => {
    const result = templates(["/blog/post-2024-01", "/blog/post-2024-02", "/blog/recap-2023"]);
    expect(new Set(Object.values(result))).toEqual(new Set(["/blog/{blogId}"]));
  });

  it("does not collapse with too few observations", () => {
    expect(templates(["/repos/alice/issues", "/repos/bob/issues"])).toEqual({
      "/repos/alice/issues": "/repos/alice/issues",
      "/repos/bob/issues": "/repos/bob/issues",
    });
  });

  it("gives repeated parameter names unique suffixes", () => {
    expect(templatePaths(["/v1/42/7"]).get("/v1/42/7")?.template).toBe("/v1/{id}/{id2}");
  });

  it("singularizes common plural forms", () => {
    expect(templates(["/categories/3", "/addresses/9", "/status/1"])).toEqual({
      "/categories/3": "/categories/{categoryId}",
      "/addresses/9": "/addresses/{addressId}",
      "/status/1": "/status/{statusId}",
    });
  });

  it("extracts parameter values from a concrete path", () => {
    const t = templatePaths(["/users/42/posts/9"]).get("/users/42/posts/9")!;
    expect(extractParamValues("/users/42/posts/9", t)).toEqual({ userId: "42", postId: "9" });
  });
});
