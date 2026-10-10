import { request } from "@playwright/test";

// `next dev` compiles a route the first time it is asked for, and until that finishes the request can come back as
// an HTML error page or a dropped connection. The webServer wait only covers /api/health, so the first test to
// touch any other route was rolling a die: both flakes seen while verifying T01 were a first hit ("Unexpected token
// '<' ... is not valid JSON" from /api/provider, and an ECONNRESET from /api/patient). Warm every route the suite
// uses before any test runs. Nothing here writes: the two POSTs are rejected by the routes' own guards.

const PORT = Number(process.env.E2E_PORT ?? 3100);

export default async function globalSetup() {
  const ctx = await request.newContext({ baseURL: `http://localhost:${PORT}` });
  const warm = async (label: string, call: () => Promise<unknown>) => {
    let last = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await call();
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw new Error(`warm-up never got a usable response from ${label}: ${last}`);
  };
  const json = (path: string) => async () => {
    const res = await ctx.get(path);
    await res.json(); // throws on an HTML error page, which is the failure being warmed away
  };
  const page = (path: string) => async () => {
    const res = await ctx.get(path);
    if (!res.ok()) throw new Error(`${res.status()} from ${path}`);
  };

  await warm("/", page("/"));
  await warm("/demo", page("/demo")); // follows the redirect, so /provider is warmed too
  await warm("/api/provider", json("/api/provider?list=1"));
  await warm("/api/patient/[id]", json("/api/patient/warmup-not-a-real-token")); // 404 JSON
  await warm("/api/book", async () => {
    const res = await ctx.post("/api/book", { data: {} }); // 400 JSON: "name is required", creates nothing
    await res.json();
  });
  await warm("/api/sweetie", json("/api/sweetie?token=warmup-not-a-real-token")); // 404 JSON

  await ctx.dispose();
}
