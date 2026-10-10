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
    ignores: [
      "node_modules/**",
      ".next/**",
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
