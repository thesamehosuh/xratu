---
name: jalali-dates
description: Use when writing or discussing dates in a Persian-language context (fa locale, or the user is writing in Persian/Finglish) — commit messages, changelog entries, comments, or answering "what's today's date" — so dates are given in the Jalali (Shamsi) calendar the user actually uses, not silently left in Gregorian.
---

# Jalali (Shamsi) calendar dates

## When this applies

- The active locale is `fa`, or the user is writing to you in Persian
  (script or Finglish).
- You are producing a **prose date** meant for a human to read: a changelog
  entry, a comment explaining "as of [date]", or a direct answer to a
  date/time question.

## When this does NOT apply

Never convert or reinterpret dates that are data, not prose:

- ISO 8601 timestamps, file metadata, git commit dates/hashes, log
  timestamps, JSON/config values, API payloads.
- Any date embedded in code that a machine will parse.

These stay Gregorian/ISO exactly as they are. Converting them would silently
corrupt data the user didn't ask you to touch.

## What to do

1. Convert Gregorian → Jalali for the human-facing text only. Format as
   `YYYY/MM/DD` in Persian numerals when the surrounding text is in Persian
   script (e.g. ۱۴۰۴/۰۶/۱۸), or Latin numerals in a Jalali order if the user
   is writing Finglish.
2. Prefer a trusted conversion over hand arithmetic:
   - Zero dependency, good enough for display: the platform formatter —
     `new Intl.DateTimeFormat('fa-IR-u-ca-persian').format(date)` (this is
     exactly what Xratu itself uses for its Jalali dates).
   - In a JS project that needs parsing/maths: `jalaali-js` or
     `dayjs-jalali`. Jalali's leap-year rule is not a simple modulo and is
     easy to get subtly wrong at century boundaries - do not hand-roll it.
3. If you're not confident of the conversion, say the Gregorian date and
   note the Jalali equivalent is approximate rather than presenting a wrong
   date with false confidence.
4. If a date is ambiguous whether it's meant as data or prose (e.g. a
   changelog heading), ask once rather than guessing - getting this wrong in
   a changelog is a persistent, visible mistake.
5. When in doubt about whether the user wants Jalali at all (e.g. locale is
   `fa` but the project's changelog convention is Gregorian), default to
   showing both on first use, then follow whichever the user corrects you
   toward.
