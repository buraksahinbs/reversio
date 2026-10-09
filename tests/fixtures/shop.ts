import type { FakeEntry } from "../helpers.js";

const auth = { Authorization: "Bearer abc.def.ghi", Cookie: "theme=dark; session_id=xyz" };

/** A small shop API as a browser would capture it, including noise. */
export const shopEntries: FakeEntry[] = [
  { url: "https://shop.example.com/", response: "<html></html>", responseMime: "text/html" },
  { url: "https://shop.example.com/static/app.js", response: "x", responseMime: "application/javascript" },
  ...[1, 2, 3].map((page) => ({
    url: `https://api.shop.example.com/v1/products?page=${page}&limit=20${page === 3 ? "&sort=price" : ""}`,
    requestHeaders: auth,
    response: {
      items: [
        { id: page * 10, name: "Mug", price: 9.5, status: "active", tags: ["kitchen"] },
        { id: page * 10 + 1, name: "Pen", price: 2, status: "archived", tags: [], discount: null },
      ],
      next: page < 3 ? `https://api.shop.example.com/v1/products?page=${page + 1}` : null,
    },
  })),
  ...[10, 11, 12].map((id) => ({
    url: `https://api.shop.example.com/v1/products/${id}`,
    requestHeaders: auth,
    response: { id, name: "Mug", price: 9.5, createdAt: "2024-03-01T12:00:00Z" },
  })),
  { url: "https://api.shop.example.com/v1/products/999", requestHeaders: auth, status: 404, response: { error: "not_found" } },
  {
    method: "POST",
    url: "https://api.shop.example.com/v1/cart/items",
    requestHeaders: auth,
    requestBody: { productId: 10, quantity: 2 },
    status: 201,
    response: { cartId: "550e8400-e29b-41d4-a716-446655440000", total: 19 },
  },
  { method: "DELETE", url: "https://api.shop.example.com/v1/cart/items/10", requestHeaders: auth, status: 204 },
  {
    method: "POST",
    url: "https://auth.shop.example.com/oauth/token",
    requestBody: "grant_type=password&username=a&password=b",
    requestMime: "application/x-www-form-urlencoded",
    response: { access_token: "t", expires_in: 3600, token_type: "Bearer" },
  },
];
