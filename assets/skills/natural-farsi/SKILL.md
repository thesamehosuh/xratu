---
name: natural-farsi
description: How to write natural, informal Persian (Farsi) like a real person typing — the "no half-space, no diacritics" orthography, plus conversational tone, plus correct handling of mixed Persian/technical (RTL/LTR) content. Use this skill whenever writing, editing, or translating anything into Farsi: READMEs, docs, UI strings, commit descriptions, chat replies, social posts, or emails — even when the user just asks to "write it in Persian" or "translate this to Farsi" without mentioning style. Also use it to review or fix existing Farsi text that reads stiff or formal, uses half-spaces or Arabic diacritics, or renders scrambled when Persian is mixed with URLs, paths, code, or identifiers in UI.
---

# Natural, informal Farsi writing

Write Persian the way a real Persian speaker types in 2026: informal but
polished, zero half-spaces, zero Arabic diacritics. The result should read
like a good tech blog post or a smart friend explaining something — not like
a formal letter, and not like translated text.

## The two hard orthography rules

House rules for all Persian output. Apply them everywhere, no exceptions,
including code comments and UI strings.

### 1. No half-spaces (نیم‌فاصله / ZWNJ, U+200C)

Never emit the zero-width non-joiner character. Replace each one with either
nothing or a plain space, chosen per rule below.

**Attach directly — the می/nمی verb prefix only:**

- می‌شود → میشود
- می‌کنند → میکنند
- نمی‌شود → نمیشود
- می‌خواهم → میخواهم
- برمی‌گردد → برمیگردد

**Full space — the ها/های plural suffix and the تر/ترین suffix:**

- فایل‌ها → فایل ها
- مهارت‌های ایجنت → مهارت های ایجنت
- Checkpoint‌ها → Checkpoint ها (even after Latin words: PR ها)
- اعلان‌ها → اعلان ها، پیام‌ها → پیام ها
- بهینه‌تر → بهینه تر، کوچک‌تر → کوچک تر
- مهم‌ترین → مهم ترین، سنگین‌ترین → سنگین ترین
- Words ending in ه always take the space: ارائه‌دهنده‌ها → ارائه دهنده ها،
  جلسه‌ها → جلسه ها

**Full space — everything else that was a half-space compound:**

- متن‌باز → متن باز، به‌طور → به طور، گردش‌کار → گردش کار
- کرده‌اید → کرده اید، خوش‌آمد → خوش آمد، برنامه‌ریزی → برنامه ریزی

**Keep attached — standalone words that merely contain the same letters:**

- فراتر، بالاتر، بدترین، بیشترین، دیگری، ساخته، رفته (these are words, not
  suffixes; never split them)

Rule of thumb: prefixes (می) attach; suffixes (ها، تر، ترین) and two
independent words get a plain space. When mechanical replacement, keep an
exclusion list of standalone words, and remember a suffix at the very end of
a string needs a boundary check too.

### 2. No Arabic diacritics or hamza

Strip every harakat and hamza mark. Persian letters (including آ) stay.

- Kasra/fatha/damma/tanvin: کاملاً → کاملا، فعلاً → فعلا، حتماً → حتما،
  مصنوعیِ شما → مصنوعی شما
- Hamza on heh (ٔ): جلسهٔ → جلسه، صفحهٔ → صفحه، تاریخچهٔ → تاریخچه،
  ریشهٔ → ریشه
- Hamza inside words: تأیید → تایید، مسأله/مسئله → مساله، سؤال → سوال،
  مؤثر → موثر
- فرآیند → فرایند
- Keep آ (alef madda) — it is a letter, not a diacritic: آفلاین، آرام
- Use Persian ی (U+06CC) and ک (U+06A9), never Arabic ي (U+064A) or ك
  (U+0643)

## Making it sound natural

Orthography alone is not enough — the prose itself must feel human.

### Prefer the conversational register

- می‌باشد / میگردد → است / هست / میشود. (میباشد is wrong Persian anyway.)
- پس از → بعد از؛ جهت (as "for") → برای؛ مجدداً → دوباره؛ قابل ذکر است که →
  (delete — just say the thing).
- Do not invent Persian jargon. Technical terms stay in English or in their
  common Persian transliteration: API، کلید API، رانتایم، بک اند، اندپوینت.

### Sentence rhythm

- Short sentences. One idea per sentence. Long ezafe chains are the #1
  giveaway of stiff Farsi — break them up.
- Second person plural (شما) is fine and normal; the stiff third-person
  passive ("انجام می‌گردد") is not.
- Dashes, colons, and short bullet lists are natural; nested formal clauses
  are not.

### Words to swap for their everyday version

| Stiff / formal | Natural |
|----------------|---------|
| می‌باشد | است / هست |
| مجدداً | دوباره |
| قابل ذکر است که | (delete) |
| بنابراین | پس |
| گردید / می‌گردد | شد / میشود |
| مورد استفاده قرار می‌گیرد | استفاده میشود |
| حائز اهمیت است | مهم است |
| جهت انجام | برای انجام |

### What "informal but polished" means

The audience is a developer, the channel is documentation. So:

- OK: میشود، نمیخواد، راحت، فقط، خیلی، کاملا
- Not OK: chat slang like دمت گرم، خفن — informal orthography, not slang.
- Never mix registers inside one document.

## Mixed Persian + technical content (RTL/LTR islands)

Persian pages are RTL, but the data inside them is usually LTR: URLs, file
paths, commands, model names, API keys, code. Bidi rendering of mixed
content is where Persian UIs break. Rules:

**In prose and docs:** rely on the bidi algorithm, but put every URL, path,
command, or identifier in code formatting (backticks in markdown). That
isolates the run and prevents reordering — no extra work needed.

**In UI code (webview/CSS):**

- Identify the "technical islands": rows/cards whose content is primarily
  data (server rows, saved credentials, file chips, diff blocks). Mark those
  whole containers `dir="ltr"` so name, URL, and metadata lines lay out
  left-to-right, with actions consistently on one side.
- Persian labels inside an LTR island render correctly as isolated runs —
  but only if each run is isolated. Never let a Persian label and a URL
  share one direction run: the neutral separator between them (·، -، ;) gets
  visually relocated by the bidi algorithm and the line scrambles. Wrap the
  Persian label in its own `dir="auto"` span and the URL in its own
  `dir="ltr"` span.
- Knobs, dots, and switches positioned with logical properties
  (`inset-inline-start`) flip when you flip a container's direction. Inside
  an LTR island, prefer physical `left`/`right` plus a physical
  `translateX`, and delete any `[dir='rtl']` overrides that target elements
  now living inside LTR islands — ancestor `[dir='rtl']` selectors still
  match through the root and will fight the island.
- One `$direction` mistake to avoid: `dir="ltr"` on a row changes
  `text-align: start` to left for every child. That is usually what you
  want; if a Persian description inside the island must stay right-aligned,
  give that span its own explicit alignment.

**Sanity check for any mixed line:** read it as rendered, character by
character, in both directions. If the separator dot lands on the wrong side
of the URL or a Persian word order inverts, a run is not isolated.

## Before / after

**Example 1 — README intro**

Input (stiff, half-spaces, diacritics):
> دستیار کدنویسی مبتنی بر هوش مصنوعیِ متن‌باز برای VS Code. بدون نیاز به
> بک‌اند و حساب کاربری. تمامی عملیات به‌صورت محلی انجام می‌گردد.

Output (natural):
> ایجنت کدنویسی هوش مصنوعی متن باز برای VS Code. کلید خودتان یا یک رانتایم
> محلی. همه چیز درون extension host و روی سیستم خودتان اجرا میشود.

**Example 2 — feature bullet**

Input:
> ویرایش فایل‌ها نیازمند تأیید کاربر می‌باشد و قابل ذکر است که این فرآیند
> به‌صورت قطعی اعمال می‌گردد.

Output:
> ویرایش فایل ها به تایید شما نیاز دارد و این محدودیت در سطح کد اعمال
> میشود، نه در سطح پرامپت.

**Example 3 — UI string**

Input:
> ذخیره‌سازی تنظیمات با موفقیت انجام گردید.

Output:
> تنظیمات ذخیره شد.

**Example 4 — mixed line in a UI row**

Broken (label and URL share one run; the separator relocates):
> `HTTP جریانی·https://mcp.example.com/mcp` rendered as a scrambled mash.

Fixed (isolated runs inside an LTR row):
> `<span dir="auto">HTTP جریانی</span> · <span dir="ltr">https://mcp.example.com/mcp</span>`
> inside a `dir="ltr"` row container.

## Checklist before delivering Farsi text

1. No U+200C anywhere; می attaches, ها/های/تر/ترین spaced (exclusion list
   respected)
2. No harakat, no hamza (check ً ِ ُ َ ٔ ء أ إ ؤ ئ)
3. No میباشد / میگردد
4. Long sentences split, ezafe chains broken
5. Technical terms left in Latin where natives leave them
6. Every mixed Persian/URL/path line rendered and read both ways; runs
   isolated
7. Read it aloud in your head — if it sounds like a government letter,
   rewrite it
