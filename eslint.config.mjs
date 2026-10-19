import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// Cookie hygiene in the suite (T69). `clearCookies()` with no filter takes `ss_csrf` with it, and any page
// still open then mints a second token into document.cookie the moment apiFetch finds the cookie gone
// (lib/csrf.ts) — overwriting the one a request already read out of the jar, which middleware answers with a
// 403 `csrf_failed` that looks like anything but a cookie problem. Sign out through signOutOfBrowser in
// e2e/auth.ts, which drops the credentials and leaves the token alone; the filtered call it makes is the one
// clearCookies this suite needs, and the filter is what this rule looks for.
const noBareClearCookies = {
  selector: "CallExpression[callee.property.name='clearCookies'][arguments.length=0]",
  message: "clearCookies() with no filter drops ss_csrf too (T69): sign out with signOutOfBrowser from e2e/auth.ts.",
};

// Screenshots go through shot() in e2e/shot.ts and nowhere else (T57, T77). The helper is the only place that
// knows how much of the page this project wants in the image, and the only place that passes
// `animations: "disabled"` — without which the shutter can open part-way through a 480ms card fade or a 500ms
// progress-bar transition, and the committed PNG shows a state the product is never in. Both routines read
// those PNGs as their evidence about what was built (design §12.3), so freezing the page cannot be something
// each new spec has to remember.
const noBareScreenshot = {
  selector: "CallExpression[callee.property.name='screenshot']",
  message: "Take screenshots with shot() from e2e/shot.ts (T57, T77): it decides fullPage per project and freezes transitions.",
};

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Logging hygiene (design §10.3): application code must log through lib/log.ts, which drops every field
    // outside its allow-list. A bare console.* takes whatever it is handed — a patient's name, a phone
    // number, a chat message — straight to stdout. lib/log.ts itself writes the line; tests and the
    // developer-only scripts in scripts/ and e2e/ never see production data and may print freely.
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: ["lib/log.ts", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "no-console": "error" },
  },
  {
    // Two things the suite may not write by hand. They share one rule because `no-restricted-syntax` takes
    // the whole list from the last config block that sets it: a second block for `e2e/**/*.ts` would not add
    // a selector, it would replace the other one and switch it off everywhere.
    files: ["e2e/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", noBareClearCookies, noBareScreenshot] },
  },
  {
    // e2e/shot.ts is the helper the screenshot rule points at, so it is the one file allowed to take one.
    files: ["e2e/shot.ts"],
    rules: { "no-restricted-syntax": ["error", noBareClearCookies] },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      // /infra is a separate package (design §3.6) with its own TypeScript config and its own libraries;
      // `bash scripts/infra-check.sh` typechecks and tests it. Linting it from here would resolve
      // aws-cdk-lib against the app's node_modules, where it is deliberately absent.
      "infra/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      // Playwright output. A failing run drops a minified trace viewer in e2e/report/, which otherwise becomes
      // thousands of lint errors on the next run and hides the real failure.
      "e2e/report/**",
      "e2e/screenshots/**",
      "e2e/test-results/**",
      "test-results/**",
    ],
  },
];

export default eslintConfig;
