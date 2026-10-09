import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A tiny web app whose page calls a JSON API, for recording tests. */
const PAGE = `<!doctype html>
<title>loading</title>
<script>
  (async () => {
    const json = { "content-type": "application/json" };
    await fetch("/api/items?page=1").then((r) => r.json());
    await fetch("/api/items?page=2").then((r) => r.json());
    for (const id of [42, 7, 99]) await fetch("/api/items/" + id).then((r) => r.json());
    await fetch("/api/items", { method: "POST", headers: json, body: JSON.stringify({ name: "Lamp", qty: 1 }) });
    document.title = "done";
  })();
</script>`;

export async function startAppServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    } else if (url.pathname === "/api/items" && req.method === "GET") {
      const page = Number(url.searchParams.get("page") ?? 1);
      send(200, { page, items: [{ id: page * 10, name: "Chair", tags: ["home"] }] });
    } else if (url.pathname === "/api/items" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => send(201, { id: 100, ...JSON.parse(body) }));
    } else if (/^\/api\/items\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split("/").pop());
      send(200, { id, name: "Chair", price: 49.5 });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
