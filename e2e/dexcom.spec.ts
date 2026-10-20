import { expect, test } from "@playwright/test";
import { postJson } from "./api";
import { MAIL_DIR, signInAsDemo, signOutOfBrowser } from "./auth";
import { patientEmail, verifyLink } from "./patient";
import { shot, WHOLE_PAGE } from "./shot";

// T24, design §9.2: the same OAuth code against the Dexcom sandbox or against production, chosen by
// DEXCOM_ENV. The two servers playwright.config.ts starts are the whole fixture; nothing is stubbed.
//
//   port+3  DEXCOM_ENV=production, with credentials and a registered https callback
//   port    no Dexcom configured at all, which is how the rest of the suite and the demo run
//
// What a patient sees is the point of having both. In production a real visit gets the real OAuth button;
// on the sandbox the same visit would be offered a separate synthetic demonstration instead, because the
// sandbox answers with invented readings and those have no business on a real patient's record — except
// that the second server has no credentials for either Dexcom, so there is nothing to offer and the card
// offers the patient nothing: §2.5's panel never carries a control the patient cannot press (T91).

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DEXCOM_MAIL_DIR = `${MAIL_DIR}-dexcom`;
const LOADED = { timeout: 30_000 };

test.describe("DEXCOM_ENV=production", () => {
  test.use({ baseURL: `http://localhost:${PORT + 3}` });

  test("a real visit is offered the real Dexcom, and the sandbox demo is not on offer at all", async ({ page }) => {
    // Booking is behind the staff role (§5.2), and the patient's code lands in this server's mailbox.
    await signInAsDemo(page, { mailDir: DEXCOM_MAIL_DIR });
    const email = patientEmail("E2E Dexcom");
    const booked = await (
      await postJson(page.request, "/api/book", { name: "E2E Dexcom", email, visitType: "follow_up", reason: "readings after dinner", channel: "none" })
    ).json();
    expect(booked.token).toBeTruthy();

    // The patient has no provider session: the link plus a code is their whole credential (§5.3).
    await signOutOfBrowser(page);
    await verifyLink(page, booked.token, email, DEXCOM_MAIL_DIR);

    const status = await (await page.request.get(`/api/dexcom/status?token=${booked.token}`)).json();
    expect(status.env).toBe("production");
    expect(status.sandboxPatient).toBe(false);
    expect(status.canConnect).toBe(true);
    expect(status.configured).toBe(true);
    expect(status.connected).toBe(false);

    // A synthetic visit holds sandbox readings, and there are none to hold here (§13.4).
    const demo = await postJson(page.request, "/api/dexcom/demo", { token: booked.token });
    expect(demo.status()).toBe(403);

    await page.goto(`/s/${booked.token}/intake`);
    await page.getByRole("button", { name: /Let.s get started/i }).click();
    const connect = page.getByRole("button", { name: "Connect Dexcom", exact: true });
    await expect(connect).toBeVisible(LOADED);
    await expect(connect).toBeEnabled();
    // The lede promises the connection this screen has (T91).
    await expect(page.getByText(/Connect Dexcom or upload a file/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Connect Dexcom · Demo/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Try Dexcom sandbox/ })).toHaveCount(0);
    // Nothing on the card may describe the import as synthetic, or as a demonstration session: these are
    // the patient's own readings now.
    const dexcomCard = page.locator("section, div").filter({ hasText: /Glucose trends/ }).last();
    await expect(dexcomCard).toContainText(/Your last 7 days of readings are imported/);
    await expect(dexcomCard).not.toContainText(/synthetic/i);
    await shot(page, "dexcom-production-connect", WHOLE_PAGE);

    // The same patient, the same browser, against the server that has no Dexcom configured at all — the
    // mode the rest of the suite, the README and the demo run in. A cookie is scoped to the host and not
    // the port, so the verified session (§5.3) carries over to the other server and the only thing that
    // differs is the switch. An absolute URL because baseURL is this describe's.
    await page.goto(`http://localhost:${PORT}/s/${booked.token}/intake`);
    await page.getByRole("button", { name: /Let.s get started/i }).click();
    // T91: neither connect control is rendered — not rendered, not merely disabled. The patient is left the
    // one thing that works without credentials, which is their own Clarity export.
    const upload = page.getByLabel(/Upload Dexcom file/i);
    await expect(upload).toBeAttached(LOADED);
    await expect(page.getByRole("button", { name: /Connect Dexcom · Demo/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect Dexcom", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Try Dexcom sandbox/ })).toHaveCount(0);
    // And the lede over the cards does not promise one either: it offered "Connect Dexcom or upload a
    // file" above a panel whose only control is the upload.
    await expect(page.getByText(/Connect Dexcom or upload a file/)).toHaveCount(0);
    await expect(page.getByText(/Upload your Dexcom export/)).toBeVisible();
    // Nor does anything on the card explain the absence in the deployment's words (§2.5, the T71 rule).
    const sandboxCard = page.locator("section, div").filter({ hasText: /Glucose trends/ }).last();
    await expect(sandboxCard).toContainText(/Upload your Clarity CSV export/);
    await expect(sandboxCard).not.toContainText(/not configured|demo mode|credential/i);
    // And no control anywhere on the panel is a dead one: a disabled button is the shape of this bug, so
    // the whole step is held to it rather than the Dexcom card alone.
    await expect(page.locator("[class*='connectStep']").locator("button:disabled, input:disabled")).toHaveCount(0);
    await shot(page, "dexcom-unconfigured-connect", WHOLE_PAGE);

    const sandboxStatus = await (await page.request.get(`http://localhost:${PORT}/api/dexcom/status?token=${booked.token}`)).json();
    expect(sandboxStatus.env).toBe("sandbox");
    expect(sandboxStatus.canConnect).toBe(false);
    expect(sandboxStatus.configured).toBe(false);

    // The same deployment's Sweetie page carried the other half of the offer: an amber card headed "Try
    // Dexcom sandbox", which POST /api/dexcom/demo answers 503 to without credentials (T91).
    await page.goto(`http://localhost:${PORT}/s/${booked.token}`);
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible(LOADED);
    await expect(page.getByRole("button", { name: /Try Dexcom sandbox/ })).toHaveCount(0);
    expect((await postJson(page.request, `http://localhost:${PORT}/api/dexcom/demo`, { token: booked.token })).status()).toBe(503);
  });
});
