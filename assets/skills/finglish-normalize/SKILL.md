---
name: finglish-normalize
description: Use when the user writes Persian in Latin script (Finglish — e.g. "chetori mishe in error ro fix kard") or mixes Finglish words/romanizations into English (e.g. "use ro instead of raa", "hamoon", "mikhai") — recognize it as Persian, not as malformed English, and respond in the language and script the user is actually most comfortable with.
---

# Finglish recognition

## When this applies

Two input shapes:

1. **Full Finglish** — the whole message is Persian spelled phonetically in
   Latin letters: Persian function words (`mishe`, `chetor`, `baraye`,
   `nemidoonam`, `mikhastam`), Persian grammar order (verb-final clauses),
   mixed-in English technical nouns (`function ro biar bala`, `commit kon`).
2. **Finglish inside English** — mostly-English prose containing Finglish
   words or romanizations of Persian forms, usually when the user has no
   Persian keyboard or is discussing Persian spellings: `ro` vs `raa`,
   `hamoon` vs `hamaan`, `mikhai` vs `mikhahi`, `mishe`, `chetor`.

## Disambiguation: Finglish vs typo-English

Parse as Persian when the message carries Persian **morphemes/function
words** in Latin letters: `ro`/`raa` (object marker), `ke`, `mi-`/`na-`
verb prefixes, `mishe`, `kardam`, `shod`, `biar`, `benevis`, `in`/`oon`,
`hamoon`, verb-final word order. A message with only English lexicon and
typos is English — "giv me suggestions" is a typo of "give", NOT Finglish;
do not force a Persian reading on it. If genuinely unsure which it is, ask
briefly rather than guessing wrong in a way that derails the response.

## What NOT to do

- Don't treat it as broken/ungrammatical English and try to "correct" it as
  English - that will misread the intent.
- Don't silently respond in formal written Persian script unless the user's
  own style suggests that's what they'd prefer - someone writing casual
  Finglish in chat may find a sudden switch to formal Persian script jarring
  rather than helpful.
- Don't machine-translate word-by-word; Finglish carries idiom and code-
  switching (English technical terms embedded in Persian sentences) that a
  literal pass will mangle.

## What to do

1. Parse the message as Persian first when the tells above are present.
2. **Reply-language policy (concrete default):**
   - Full Finglish message → reply in informal Persian SCRIPT (the user's
     Latin typing is usually just a missing keyboard, not a script
     preference). If the user keeps replying in Latin across turns, stay in
     Latin (Finglish) too.
   - English message with Finglish fragments → reply in English; treat the
     Finglish fragments as Persian content (spell them correctly in Persian
     script when quoting or normalizing them).
   - Persian-script message → Persian script back.
3. **Every Persian-script reply follows `natural-farsi`** — colloquial
   register (رو not را, همون not همان, میخوای not میخواهی), its orthography
   rules, and its technical-vocabulary list. This skill decides *which
   language/script*; `natural-farsi` decides *how it is written*.
4. If the user mixes English technical nouns into Persian sentences, keep
   those nouns in English in your reply too (see the technical vocabulary
   section of the `natural-farsi` skill for which terms to leave
   untranslated).

## Quick glossary (recognition + normalization map)

| Finglish | Persian | Meaning |
|---|---|---|
| ro / raa | رو / را | object marker (informal / formal) |
| hamoon / hamaan | همون / همان | "the same" |
| mikhai / mikhahi | میخوای / میخواهی | "you want" |
| mishe / mishavad | میشه / میشود | "it becomes/works" |
| kon / bokon | کن / بکن | "do" |
| biar | بیار | "bring" |
| chetor / chetori | چطوری | "how / how are you" |
| nemidoonam | نمیدونم | "I don't know" |
| mikhastam | میخواستم | "I wanted" |
| kardam / shod | کردم / شد | "I did / it became" |
| in / oon | این / اون | "this / that" |
| dige / dg | دیگه | "anymore / other" |

## Relationship to existing i18n system

This is about interpreting the user's *input* and matching their *reply
language*, not about the UI's locale switch - the webview's `fa`/`en`
strings are a separate, existing system. A user can be on the `en` UI
locale and still type Finglish in chat; this skill covers that case.
