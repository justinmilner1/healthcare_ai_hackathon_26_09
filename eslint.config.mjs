import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

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
