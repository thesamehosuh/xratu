/**
 * Decision card (`ask_user_question`) behavior checks:
 *  - the card NEVER renders as a tool pill (the card IS the UI), live or on
 *    reload;
 *  - a settled card collapses into an "Answered" line (pointing chevron),
 *    and the expanded body shows the option the user chose;
 *  - the recommended option carries its badge; a dismissal is explicit.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
    DecisionResolvedBody,
    MessageItem,
    decisionPayloadFromStep,
    parseQuestionAnswer,
    parseQuestionStep,
} from '../src/components/MessageItem';
import { t } from '../src/i18n';
import type { ChatMessage, DecisionPayload, Step } from '../src/types';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string): void {
    if (cond) pass++;
    else {
        fail++;
        console.error('  FAIL:', name);
    }
}

const OPTIONS = [
    { label: 'Postgres', description: 'Relational, boring.', recommended: true },
    { label: 'SQLite', description: 'Single file.' },
];

function decisionMessage(decision: DecisionPayload, steps: Step[] = []): ChatMessage {
    return {
        id: 'a1',
        role: 'assistant',
        text: '',
        steps,
        status: 'done',
        createdAt: 1,
        decisions: [decision],
    };
}

function render(message: ChatMessage): string {
    return renderToString(createElement(MessageItem, { message }));
}

function renderBody(decision: DecisionPayload): string {
    return renderToString(createElement(DecisionResolvedBody, { payload: decision }));
}

const QUESTION_ARGS = JSON.stringify({ question: 'Which database?', options: OPTIONS });
const RESULT_PICK = 'The user selected the option: "SQLite"\n\nSingle file.';

// 1. Pending card: question, every option, recommended badge, free-text entry.
{
    const html = render(decisionMessage({
        decision_id: 'dec-1',
        header: 'Database',
        question: 'Which database?',
        options: OPTIONS,
    }));
    ok(html.includes('Which database?'), 'question renders');
    ok(html.includes('Database'), 'header renders');
    ok(html.includes('Postgres') && html.includes('SQLite'), 'both options render');
    ok(html.includes('decision-option-badge'), 'recommended option wears the badge');
    ok(html.includes('decision-other-btn'), 'free-text Other entry is available');
    ok(html.includes('decision-card pending'), 'card is in pending state');
    ok(!html.includes('decision-collapsed'), 'pending card shows no Answered line');
    ok(!html.includes('<details'), 'pending question renders no tool pill');
}

// 2. A settled card collapses to the Answered line - the card body is gone
//    until the line is clicked (interactivity is e2e-tested; here: states).
{
    const html = render(decisionMessage({
        decision_id: 'dec-2',
        header: 'Database',
        question: 'Which database?',
        options: OPTIONS,
        answered: true,
        answer: 'SQLite',
    }));
    ok(html.includes('decision-collapsed'), 'settled card shows the Answered line');
    ok(!html.includes('decision-card'), 'settled card body is collapsed away');
    ok(!html.includes('Which database?'), 'question hidden while collapsed');
}

// 3. The expanded body shows the pick highlighted and everything else dimmed.
{
    const html = renderBody({
        decision_id: 'dec-3',
        header: 'Database',
        question: 'Which database?',
        options: OPTIONS,
        answered: true,
        answer: 'SQLite',
    });
    ok(html.includes('Which database?'), 'expanded body shows the question');
    ok(html.includes('decision-option selected'), 'chosen option is highlighted');
    ok(html.includes('decision-card resolved'), 'expanded body is the resolved card');
}

// 4. Custom answers and dismissals read as themselves.
{
    const custom = renderBody({
        decision_id: 'dec-4',
        question: 'Which database?',
        options: OPTIONS,
        answered: true,
        answer: 'Use MySQL instead',
    });
    ok(custom.includes('Use MySQL instead'), 'custom answer is shown');
    ok(custom.includes('decision-resolution custom'), 'custom answer uses the resolution row');

    const dismissed = render(decisionMessage({
        decision_id: 'dec-5',
        question: 'Which database?',
        options: OPTIONS,
        answered: true,
        answer: null,
    }));
    ok(dismissed.includes('decision-collapsed'), 'dismissed card collapses too');
    ok(dismissed.includes(t('decisionDismissed')), 'dismissal line is explicit');
}

// 5. Tool-pill suppression: the question's call/result steps never become
//    pills - live (card carries the UI) NOR on reload (the record line does).
{
    const callStep: Step = {
        id: 's1',
        kind: 'toolCall',
        tool: 'ask_user_question',
        text: QUESTION_ARGS,
        result: RESULT_PICK,
    };
    // Reload path (no live decision payload): one Answered line, no pills.
    const html = render({
        id: 'a2',
        role: 'assistant',
        text: '',
        steps: [callStep],
        status: 'done',
        createdAt: 1,
    });
    ok(!html.includes('<details'), 'reload: no tool pill for the question');
    ok(html.includes('decision-collapsed'), 'reload: the Answered record line stands in');
    ok(html.includes('decision-collapsed'), 'reload record present');

    // Live path (card present): the record row must NOT duplicate the card.
    const live = render(decisionMessage(
        {
            decision_id: 'dec-6',
            question: 'Which database?',
            options: OPTIONS,
            answered: true,
            answer: 'SQLite',
        },
        [callStep],
    ));
    ok((live.match(/class="decision-collapsed"/g) ?? []).length === 1, 'live: exactly one Answered line (no duplicate record row)');
    ok(!live.includes('<details'), 'live: no tool pill for the question');

    // Pending call step with no result and no card: still no pill.
    const pending = render({
        id: 'a3',
        role: 'assistant',
        text: '',
        steps: [{ id: 's2', kind: 'toolCall', tool: 'ask_user_question', text: QUESTION_ARGS }],
        status: 'done',
        createdAt: 1,
    });
    ok(!pending.includes('<details'), 'pending question step is not a pill either');
}

// 6. The record payload is rebuilt from steps (args + result shapes).
{
    const parsed = parseQuestionStep(QUESTION_ARGS);
    ok(parsed?.question === 'Which database?', 'args parse: question');
    ok(parsed?.options.length === 2, 'args parse: options');
    ok(parsed?.options[0].recommended === true, 'args parse: recommended');

    const pick = parseQuestionAnswer(RESULT_PICK);
    ok(pick?.kind === 'selected' && pick.label === 'SQLite', 'result parse: selected option');
    ok(parseQuestionAnswer('The user dismissed the question without selecting an option. Continue with your best judgment and do not ask again.')?.kind === 'dismissed', 'result parse: dismissed');
    const custom = parseQuestionAnswer('The user provided a custom answer:\nUse MySQL instead');
    ok(custom?.kind === 'custom' && custom.text === 'Use MySQL instead', 'result parse: custom text');

    const payload = decisionPayloadFromStep({
        id: 's9',
        kind: 'toolCall',
        tool: 'ask_user_question',
        text: QUESTION_ARGS,
        result: RESULT_PICK,
    });
    ok(payload.answered === true && payload.answer === 'SQLite', 'record payload carries the pick');
}

// 7. A decision-only system row (2nd+ question of a turn) carries NO bubble
//    box around the card - the card is the surface.
{
    const html = render({
        id: 'sys1',
        role: 'system',
        text: '',
        steps: [],
        status: 'done',
        tone: 'pending',
        createdAt: 1,
        decisions: [{
            decision_id: 'dec-sys',
            question: 'Which cache?',
            options: [{ label: 'Redis' }, { label: 'Memcached' }],
        }],
    });
    ok(html.includes('decision-holder'), 'system decision row uses the bare holder');
    ok(!html.includes('class="msg system'), 'system decision row has no bubble box');
    ok(html.includes('Which cache?'), 'and still renders the card');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
