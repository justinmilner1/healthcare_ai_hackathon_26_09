import { expect, type APIRequestContext } from "@playwright/test";

// The CSRF handshake for the suite's direct API calls (design §10.8, lib/csrf.ts).
//
// A POST from the Playwright request fixture is exactly what the protection is there to stop: no page, no
// token, just a request. So the fixture has to do what the browser does — hold the cookie middleware hands
// out and repeat it in a header. One safe GET is enough to be given one; APIRequestContext keeps cookies
// between calls, so the cookie goes back on its own and only the header needs adding.

const CSRF_COOKIE = "ss_csrf";
const CSRF_HEADER = "x-csrf-token";

export async function csrfToken(request: APIRequestContext): Promise<string> {
  const existing = await tokenFromJar(request);
  if (existing) return existing;
  const primer = await request.get("/api/health");
  expect(primer.status(), "the health endpoint should answer before the suite posts anything").toBeLessThan(500);
  const token = await tokenFromJar(request);
  expect(token, `middleware should have set the ${CSRF_COOKIE} cookie`).toBeTruthy();
  return token!;
}

async function tokenFromJar(request: APIRequestContext): Promise<string | null> {
  const { cookies } = await request.storageState();
  return cookies.find((c) => c.name === CSRF_COOKIE)?.value ?? null;
}

/** POST JSON the way the app's own pages do. */
export async function postJson(request: APIRequestContext, path: string, data: unknown) {
  return request.post(path, { data, headers: { [CSRF_HEADER]: await csrfToken(request) } });
}
