import assert from 'node:assert/strict';
import { composerDraftKey, promoteComposerDraft, readComposerDraft, saveComposerDraft, readComposerRecoveries, saveComposerRecoveries } from '../src/composerDrafts';
import { getWebviewState, patchWebviewState } from '../src/vscode';

const a = composerDraftKey('/project', 'A');
const b = composerDraftKey('/project', 'B');
const other = composerDraftKey('/other', 'A');
patchWebviewState({ unrelated: { keep: true }, composerDrafts: null });
saveComposerDraft(a, 'draft A', []);
saveComposerDraft(b, 'draft B', []);
assert.equal(readComposerDraft(a).text, 'draft A');
assert.equal(readComposerDraft(b).text, 'draft B');
assert.equal(readComposerDraft(other).text, '');
assert.deepEqual(getWebviewState().unrelated, { keep: true });

const fresh = composerDraftKey('/project', null);
saveComposerDraft(fresh, 'next turn', []);
promoteComposerDraft(fresh, other);
assert.equal(readComposerDraft(fresh).text, '');
assert.equal(readComposerDraft(other).text, 'next turn');
saveComposerDraft(other, '', []);
assert.equal(readComposerDraft(other).text, '');

patchWebviewState({ composerDrafts: { [a]: 14, [b]: 'valid', invalid: 'x'.repeat(200_001) } });
assert.equal(readComposerDraft(a).text, '');
assert.equal(readComposerDraft(b).text, 'valid');
for (let i = 0; i < 40; i++) saveComposerDraft(composerDraftKey('/project', String(i)), 'x'.repeat(10_000), []);
const stored = Object.values(getWebviewState().composerDrafts as Record<string, string>);
assert.ok(stored.length <= 32);
assert.ok(stored.reduce((sum, text) => sum + text.length, 0) <= 200_000);
assert.equal(readComposerDraft(composerDraftKey('/project', '39')).text.length, 10_000);
saveComposerRecoveries(a, [{ id: 'rejected', value: 'do not overwrite newer typing', attachments: [{ id: 'file', name: 'private.txt', mimeType: 'text/plain', size: 6, dataBase64: 'c2VjcmV0' }], missingNames: [] }]);
assert.ok(!JSON.stringify(getWebviewState().composerRecoveries).includes('c2VjcmV0'), 'recovery persistence excludes attachment bytes');
assert.equal(readComposerRecoveries(a)[0].attachments[0].name, 'private.txt');
const restored = composerDraftKey('/restored', 'A');
patchWebviewState({ composerRecoveries: { [restored]: [{ id: 'disk', value: 'recover text', names: ['private.txt'] }] } });
assert.deepEqual(readComposerRecoveries(restored)[0].missingNames, ['private.txt']);
assert.deepEqual(readComposerRecoveries(restored)[0].attachments, []);
console.log('composer-drafts: isolation, promotion, merged state, validation and bounds passed');
