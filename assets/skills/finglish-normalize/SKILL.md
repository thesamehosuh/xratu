---
name: finglish-normalize
description: Use when the user's message is Persian written in Latin script (Finglish — e.g. "chetori mishe in error ro fix kard") rather than English — recognize it as Persian, not as malformed English, and respond in whichever language/script the user is actually most comfortable with.
---

# Finglish recognition

## When this applies

The user's message doesn't parse as fluent English but does parse as
Persian sentence structure spelled phonetically in Latin letters. Common
tells: Persian function words spelled out (`mishe`, `chetor`, `baraye`,
`nemidoonam`, `mikhastam`), Persian grammar order (verb-final clauses),
mixed-in English technical nouns (`function ro biar bala`, `commit kon`).

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
2. Mirror the user's register back: if they wrote casual Finglish, casual
   Finglish or plain Persian script back is more natural than switching to
   formal Persian. If they mix English technical nouns into Persian
   sentences, keep those nouns in English in your reply too (see the
   technical vocabulary section of the `natural-farsi` skill for which terms
   to leave untranslated).
3. If genuinely unsure whether a message is Finglish or just terse English,
   ask briefly rather than guessing wrong in a way that derails the
   response.

## Relationship to existing i18n system

This is about interpreting the user's *input* and matching their *reply
language*, not about the UI's locale switch - the webview's `fa`/`en`
strings are a separate, existing system. A user can be on the `en` UI
locale and still type Finglish in chat; this skill covers that case.
