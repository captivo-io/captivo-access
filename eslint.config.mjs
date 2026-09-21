import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Claude Code skill tooling (vendored .cjs scripts) — not app source.
    ".claude/**",
    // Prisma-generated client.
    "src/generated/**",
    // Local git worktrees: each holds a full copy of the source, so linting
    // the repo root otherwise reports thousands of problems from files that
    // are not this checkout's -- which made `pnpm lint` useless here.
    ".wt/**",
  ]),
  {
    // We intentionally enforce ONLY rules-of-hooks (the misplaced-hook class of
    // bug — e.g. calling useRouter() inside an event handler — which is valid
    // TypeScript, so only this lint rule catches it). eslint-config-next also
    // pulls in react-hooks v7's react-compiler rules (set-state-in-effect,
    // purity, immutability); those flag deliberate patterns we use widely
    // (post-hydration setState to avoid SSR mismatch, etc.), so we keep them off.
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
    },
  },
]);

export default eslintConfig;
