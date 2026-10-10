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
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
