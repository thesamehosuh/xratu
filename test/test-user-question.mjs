#!/usr/bin/env node
/**
 * `ask_user_question` (decision card) argument/result tests.
 *
 * The card is the agent's only user-decision surface: a malformed question
 * (one option, empty labels, several "recommended" marks) must never reach
 * the webview, and the model-facing result must always make the user's pick
 * unambiguous - including the dismissal case, which is NOT an error and must
 * read as "continue with best judgment" rather than leaving the tool call
 * without a result.
 *
 * Run (after `npx tsc -p . --outDir out`):  node test/test-user-question.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
    USER_QUESTION_TOOL_NAME,
    parseUserQuestionArgs,
    formatUserQuestionResult,
} = require('../out/tooling/userQuestion.js');

let failed = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (name, cond, detail = '') => {
    if (!cond) failed++;
    console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !detail ? '' : ` (${detail})`}`);
};
const parseError = (args) => {
    const r = parseUserQuestionArgs(args);
    return r.ok ? null : r.error;
};

check('tool name is stable', USER_QUESTION_TOOL_NAME, 'ask_user_question');

// --- validation -------------------------------------------------------------
check('missing question is rejected', parseError({}), 'Missing required argument: question');
check('blank question is rejected', parseError({ question: '   ' }), 'Missing required argument: question');
check('missing options is rejected', parseError({ question: 'Which?' }), 'ask_user_question requires at least 2 options with a non-empty label');
check('one option is rejected', parseError({ question: 'Which?', options: [{ label: 'A', description: '' }] }), 'ask_user_question requires at least 2 options with a non-empty label');
check('empty labels are dropped', parseError({ question: 'Which?', options: [{ label: '  ', description: '' }, { label: 'B', description: '' }] }), 'ask_user_question requires at least 2 options with a non-empty label');
check('garbage options are rejected', parseError({ question: 'Which?', options: ['x', 'y'] }), 'ask_user_question requires at least 2 options with a non-empty label');

// --- happy path -------------------------------------------------------------
const good = parseUserQuestionArgs({
    question: '  Which database?  ',
    header: '  Database  ',
    options: [
        { label: '  Postgres  ', description: ' Relational, boring.  ', recommended: true },
        { label: 'SQLite', description: 'Single file.' },
    ],
});
ok('happy path parses', good.ok === true);
check('question trimmed', good.value.question, 'Which database?');
check('header trimmed', good.value.header, 'Database');
check('label trimmed', good.value.options[0].label, 'Postgres');
check('description trimmed', good.value.options[0].description, 'Relational, boring.');
check('recommended flag kept', good.value.options[0].recommended, true);
check('second option not recommended', good.value.options[1].recommended, false);

// --- "(Recommended)" suffix normalization (opencode/codex convention) -------
const suffixed = parseUserQuestionArgs({
    question: 'Approach?',
    options: [
        { label: 'Rewrite (Recommended)', description: 'Clean slate' },
        { label: 'Refactor', description: 'Keep structure' },
    ],
});
ok('suffix path parses', suffixed.ok === true);
check('suffix stripped from label', suffixed.value.options[0].label, 'Rewrite');
check('suffix promotes recommended', suffixed.value.options[0].recommended, true);
check('plain label untouched', suffixed.value.options[1].label, 'Refactor');

const bracketSuffixed = parseUserQuestionArgs({
    question: 'Approach?',
    options: [
        { label: 'Rewrite [recommended]', description: '' },
        { label: 'Refactor', description: '' },
    ],
});
check('bracket suffix stripped', bracketSuffixed.value.options[0].label, 'Rewrite');
check('bracket suffix promotes recommended', bracketSuffixed.value.options[0].recommended, true);

// --- several recommended marks: first wins ---------------------------------
const multi = parseUserQuestionArgs({
    question: 'Approach?',
    options: [
        { label: 'A', description: '', recommended: true },
        { label: 'B', description: '', recommended: true },
        { label: 'C', description: '', recommended: 'true' },
    ],
});
check('first recommended wins (a)', multi.value.options[0].recommended, true);
check('first recommended wins (b)', multi.value.options[1].recommended, false);
check('string "true" coerced then dropped', multi.value.options[2].recommended, false);

// --- length caps (truncated, never rejected) --------------------------------
const long = parseUserQuestionArgs({
    question: 'Q'.repeat(5000),
    header: 'H'.repeat(120),
    options: [
        { label: 'L'.repeat(300), description: 'D'.repeat(900) },
        { label: 'B', description: '' },
    ],
});
check('question capped', long.value.question.length, 2000);
check('header capped', long.value.header.length, 40);
check('label capped', long.value.options[0].label.length, 80);
check('description capped', long.value.options[0].description.length, 300);

// --- defaults ---------------------------------------------------------------
const minimal = parseUserQuestionArgs({
    question: 'Which?',
    options: [{ label: 'A' }, { label: 'B' }],
});
check('header defaults empty', minimal.value.header, '');
check('description defaults empty', minimal.value.options[0].description, '');

// --- model-facing result text ----------------------------------------------
check(
    'selected result names the option',
    formatUserQuestionResult({ kind: 'selected', label: 'Postgres', description: 'Relational, boring.' }),
    'The user selected the option: "Postgres"\n\nRelational, boring.',
);
check(
    'selected result omits empty description',
    formatUserQuestionResult({ kind: 'selected', label: 'SQLite', description: '' }),
    'The user selected the option: "SQLite"',
);
check(
    'custom result carries the free text',
    formatUserQuestionResult({ kind: 'custom', text: 'Use MySQL instead' }),
    'The user provided a custom answer:\nUse MySQL instead',
);
const dismissed = formatUserQuestionResult({ kind: 'dismissed' });
ok('dismissed result is not an error marker', !/error|denied|fail/i.test(dismissed), dismissed);
ok('dismissed result tells the model to continue', /Continue with your best judgment/.test(dismissed), dismissed);

console.log(failed === 0 ? '\nall user-question checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
