/**
 * Flat ESLint config - the machine-checkable half of AGENTS.md.
 *
 * The "Non-negotiable rules" in AGENTS.md used to live only in reviewer
 * memory; every one of them that CAN be expressed as an AST rule is enforced
 * here (the R* rules below). Rules that cannot be enforced honestly are
 * deliberately left out rather than approximated into noise - see the note
 * next to each one.
 *
 * CALIBRATION RULE: this config must be GREEN on a clean tree. Every error
 * below was measured against the current codebase before being enabled. When
 * a rule cannot be green today without a repo-wide refactor (which is its own
 * PR under AGENTS.md's "small, scoped PRs"), it is `warn` so the debt stays
 * visible instead of being hidden in an allowlist. Do not "fix" a red lint by
 * loosening an R* rule - fix the code, or document why the rule does not
 * apply, right here.
 */

import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const JAVASCRIPT = '**/*.{js,mjs,cjs}';
const TYPESCRIPT = '**/*.{ts,tsx}';

/**
 * Product code only. The R* rules protect SHIPPED runtime behaviour, so they
 * deliberately do not cover `test/**`: a test fixture that spawns a throwaway
 * process and kills it directly is not the bug AGENTS.md is describing, and
 * exempting tests keeps the rules tight on the code that actually runs.
 */
const PRODUCT = ['src/**/*.ts', 'src/**/*.tsx', 'webview-ui/src/**/*.ts', 'webview-ui/src/**/*.tsx'];

export default [
    {
        // Build output is NEVER linted: `dist-tests/**` in particular is
        // compiled webview-test output and it carries eslint-disable comments
        // copied from React's own source (react-internal/unicorn), which
        // ESLint reports as "Definition for rule was not found" errors.
        ignores: [
            'dist/**',
            'out/**',
            'node_modules/**',
            'dist-tests/**',
            'test-results/**',
            'playwright-report/**',
            '.playwright-mcp/**',
            'assets/**',
            '.vscode/**',
            'webview-ui/dist/**',
            'test/e2e/**-snapshots/**',
        ],
    },

    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: [TYPESCRIPT],
    })),

    /* ------------------------------------------------------------------ *
     * Baseline TS/JS correctness
     *
     * Debt rules are `warn` ON PURPOSE: they cannot be made green without
     * touching many files, and a lint that is already red on a clean tree is
     * a lint everyone learns to ignore. Warnings keep the count visible while
     * every R* rule below stays a hard error.
     * ------------------------------------------------------------------ */
    {
        files: [TYPESCRIPT],
        rules: {
            // Existing `any`s are mostly deliberate protocol/FFI edges.
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-require-imports': 'warn',
            // The repo convention is `_name` for intentionally-unused bindings;
            // without this the underscore convention itself is an error.
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    args: 'after-used',
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    ignoreRestSiblings: true,
                },
            ],
            'prefer-const': 'warn',
        },
    },

    /* ------------------------------------------------------------------ *
     * R1-R4: AGENTS.md non-negotiables as AST rules, product code only.
     * ------------------------------------------------------------------ */
    {
        files: PRODUCT,
        rules: {
            'no-restricted-syntax': [
                'error',

                // R1 - "kill process TREES with killTree(), never a bare child.kill()".
                // The selector is `child.kill()` specifically: `process.kill()`,
                // `job.kill()` and `killTree()` are all legitimate and must not
                // fire. One pre-existing site (processIdentity.ts:227) is
                // allowlisted AT THE SITE with its own justification.
                {
                    selector: "CallExpression[callee.object.name='child'][callee.property.name='kill']",
                    message:
                        'R1 (AGENTS.md): kill process trees with killTree(), never a bare child.kill(). ' +
                        'If the target truly has no descendants, allowlist this line with a comment saying so.',
                },

                // R2 - "spawn processes via cross-spawn": a SHELL STRING is what
                // breaks Windows (quoting, .cmd shims) and invites injection.
                // Matches the `cp.` namespace this repo uses everywhere.
                // `execFile`/`execFileSync` (no shell) and `spawn` (the
                // cmd.exe / bash wrapper) are deliberate and allowed.
                {
                    selector: "CallExpression[callee.object.name='cp'][callee.property.name=/^(exec|execSync)$/]",
                    message:
                        'R2 (AGENTS.md): never spawn through a shell string. Use cp.execFile for a fixed ' +
                        'binary, or cross-spawn for user/config-supplied commands.',
                },

                // R3 - "dir is set ONLY on the root .app div in App.tsx".
                // Catches a literal dir="rtl" in any component. The expression
                // form `dir={cond ? "rtl" : "ltr"}` is intentionally NOT caught:
                // InputBar and CapabilitiesPage use it on purpose for
                // empty-input direction, and that predates this config.
                {
                    selector: "JSXAttribute[name.name='dir'][value.value='rtl']",
                    message:
                        'R3 (AGENTS.md): dir is set only on the root .app div in App.tsx, driven by the ' +
                        'locale - never hardcoded on an inner component.',
                },

                // R4 - "CSS is RTL-safe (logical props); don't introduce
                // margin-left/padding-right/left in shared components".
                // Scoped to webview-ui/src so it never reads a TEST that is
                // asserting on computed border widths (a real false positive
                // that fired in test/e2e/approval-card.spec.ts).
                {
                    selector:
                        "Property[key.name=/(^(marginLeft|marginRight|paddingLeft|paddingRight)$|^(left|right)$)/]",
                    message:
                        'R4 (AGENTS.md): use logical properties (margin-inline-start, inset-inline-start, ' +
                        'padding-inline) instead of physical direction props - physical ones break RTL.',
                },
            ],
        },
    },

    /* ------------------------------------------------------------------ *
     * Webview (React)
     * ------------------------------------------------------------------ */
    {
        files: ['**/*.tsx'],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { react, 'react-hooks': reactHooks },
        rules: {
            ...react.configs['jsx-runtime'].rules,

            // R5 - "every user-visible string goes through i18n".
            // NOT `react/jsx-no-literals`: measured at 1440 hits, and the vast
            // majority are `className`/`aria-*`/`placeholder` attribute values,
            // not user-visible text. A rule that only produces noise gets
            // disabled on day one, so it is not enabled. The real invariant is
            // already enforced by test:nls + test:farsi-orthography (fa/en key
            // parity) and i18n.ts's type-checked `en` map.
            'react/jsx-no-literals': 'off',

            // exhaustive-deps is the one this repo actually opts into - there
            // are 8 `eslint-disable react-hooks/exhaustive-deps` comments in
            // webview-ui/src that previously reported "Definition for rule was
            // not found" because the plugin was never installed.
            ...reactHooks.configs.recommended.rules,

            // The React Compiler-era rules ship as `error` in the plugin's
            // recommended set, but they encode a different architecture:
            // `react-hooks/refs` alone fires 29 times on existing code and
            // cannot be satisfied without a refactor (its own PR). Off, not
            // downgraded, so the output stays signal. Revisit deliberately.
            'react-hooks/refs': 'off',
            'react-hooks/set-state-in-effect': 'off',
            'react-hooks/preserve-manual-memoization': 'off',
            'react-hooks/static-components': 'off',
            'react-hooks/purity': 'off',
        },
    },
];
