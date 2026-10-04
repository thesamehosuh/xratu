---
name: natural-farsi
description: How to write natural, informal Persian (Farsi) like a real person typing — the colloquial chat register (رو not را, همون not همان, میخوای not میخواهی), the "no half-space, no diacritics" orthography, conversational tone, and correct handling of mixed Persian/technical (RTL/LTR) content, plus which technical terms stay in English. Use this skill whenever writing, editing, or translating anything into Farsi: READMEs, docs, UI strings, chat replies, social posts, or emails — even when the user just asks to "write it in Persian" or "translate this to Farsi" without mentioning style. Also use it to review or fix existing Farsi text that reads stiff or formal, mixes registers, uses half-spaces or Arabic diacritics, translates technical terms that should stay English, or renders scrambled when Persian is mixed with URLs, paths, code, or identifiers in UI.
---

# Natural, informal Farsi writing

Write Persian the way a real Persian speaker types in 2026: informal but
polished, zero half-spaces, zero Arabic diacritics. The result should read
like a good tech blog post or a smart friend explaining something — not like
a formal letter, and not like translated text.

## The one-language rule

Once the conversation is Persian, EVERY message is Persian — not just the
opening one. This is the single most common failure: a reply starts in
Persian, drifts into English for a few paragraphs of work ("Now the commits.
I'm splitting into 4 rather than the 5 originally proposed..."), then snaps
back. Register drift across messages is worse than drift inside one.

Concretely, in a Persian conversation:

- No English sentence. No English paragraph. No English bullet.
- Latin script appears ONLY for: code and identifiers in backticks, tier-A
  jargon, tier-B/C transliterations in Persian letters, and acronyms.
- A whole message that is entirely English is always wrong, however natural
  it reads and however technical the step is.

Reasoning and tool arguments are not the reply and may be English; the text
the user reads is the reply and is Persian.

### When these rules apply

These rules govern the Persian text you produce. Preloaded into a
Persian-locale session they govern your WHOLE reply, and there is no
exception: no English sentence, ever, in any message.

Loaded by hand somewhere else — translating a document, reviewing Persian copy,
answering questions ABOUT Persian — they govern only the Persian you write,
and your explanation stays in whatever language the user is using. That is the
only case where the one-language rule is limited to the reply itself.

## The register: colloquial morphology (the half everyone forgets)

Persian has a register continuum. Name the target explicitly and never
drift off it:

| Level | What it is | Sample 3sg | Status |
|---|---|---|---|
| 1 | Literary/administrative (ادبی/اداری) | می‌باشد، می‌گردد | banned |
| 2 | Standard written (کتابی/معیار) | است، میشود، میدهد، را، همان | banned |
| 3 | **Colloquial written (محاوره‌ایِ نوشته‌شده)** | ـه، میشه، میده، رو، همون | **THE TARGET** |
| 4 | Chat slang | دمت گرم، خفن | banned |

Level 3 is how Iranians type in chats, Telegram, blogs and tech posts:
informal **morphology and lexicon** with clean orthography (the rules below)
and no slang. Orthography alone is not enough — a text with no half-spaces
that says «فایل را میخواند» is still level 2.

**Consistency law: register is a per-document property, enforced at the
token level.** In level-3 output, ZERO level-2 tokens may appear — not in
long explainers, not in bullet lists, not in change reports, not in UI
strings, not in code comments. Mixing «هر کدوم رو جواب بدهی، من سوال بعدی
را میپرسم» is the #1 failure mode. Pick level 3 and hold it.

Formal (level 2) is allowed ONLY when the user writes formal Persian
themselves or explicitly asks for a formal text — and even then level 1
bureaucratic style is never right.

### Function words

| Written (banned) | Colloquial (use) | Notes |
|---|---|---|
| را | رو | the most visible marker — always, every sentence |
| همان | همون | همان‌جا→همون‌جا، همان‌طور→همون‌طور، همان‌قدر→همون‌قدر |
| آن / آن‌ها / آنجا | اون / اونا / اونجا | همین stays همین |
| یک (indefinite article) | یه | یک فایل→یه فایل; counting numerals stay: یک، دو، سه |
| خودتان | خودت | |
| دیگر (="anymore/other") | دیگه | |
| در (place) | توی | در stays for abstract uses: در کد، در عمل |
| اینجا | اینجا | unchanged |

**Address: implicit تو.** Speak to the reader as a colleague: «اگه بخوای
میتونی…». Never شما / خودتان / میتوانید / کنید-as-politeness. Soften with
لطفا / ممنون when needed, not with formal pronouns.

### Verb endings

Present stems; past stems are unchanged (کرد→کرد، رفت→رفت، گفت→گفت).
Literary future (خواهم رفت) is banned — use the میـ present (میرم) or
«قراره …».

| Person | Written (banned) | Colloquial (use) |
|---|---|---|
| 1sg | می‌خواهم، می‌دانم، می‌توانم | میخوام، میدونم، میتونم |
| 2sg | می‌خواهی، می‌دانی، می‌توانی | میخوای، میدونی، میتونی |
| 3sg | می‌کند، می‌شود، می‌خواهد، می‌داند، می‌تواند | میکنه، میشه، میخواد، میدونه، میتونه |
| 1pl | می‌خواهیم | میخوایم |
| 2pl | می‌خواهید، بگویید، بیایید، بروید | میخواید، بگید، بیاین، برید |
| 3pl | می‌کنند، می‌شوند، می‌خواهند | میکنن، میشن، میخوان |

General shape: 3sg `ـد` → `ـه` (میکنه، میشه، میده، میذاره، میاره، میره،
میاد، میخونه، مینویسه، میگیره، میزنه، میرسه، میشینه، میبینه، میشنوه،
میخوره، میریزه، میچرخونه، میمونه، میگه); 3pl `ـند` → `ـن` (میکنن، میشن،
میرن، میان، میدن، میگن). The `خوا-` family keeps `ـاد`: میخواد.

Stem shifts behind the table (regular word families):

- خوا- → خو- : میخوام / میخوای / میخواد / میخوان
- گذار- → ذار- : میذارم / میذاره / بذار
- آور- → آر- : میارم / میاره / بیار
- گوی- → گو- : میگم / میگی / میگه / بگو / بگید
- خوان- → خون- : میخونم / میخونه / بخون
- دان- → دون- : میدونم / میدونی / میدونه / بدون / بدونید
- توان- → تون- : میتونم / میتونی / میتونه / بتون
- روی- (رفتن) → رو- : میرم / میری / میره / میرن
- آی- (آمدن) → یا- : میام / میای / میاد / میان / بیا
- نشین- → شین- : میشینه / بشین
- چرخان- → چرخون- : میچرخونه، گردان- → گردون-

High-frequency 2pl: کنید→کنین (present too: میکنید→میکنین)، بیایید→بیاین.
Other 2pl keeps
`ـید` minus the و of the stem: بخوانید→بخونید، بنشینید→بشینید،
بیاورید→بیارید، بگذارید→بذارید.

### Copula

| Written (banned) | Colloquial (use) |
|---|---|
| است | attached `ـه`, no ZWNJ: اینه، اونه، خوبه، درسته، بسه، کافیه، ممکنه، خودشه، در دسترسه |
| است (after a word ending in ه, where ـه merges badly) | هست: «فایل ساده هست» — never «ساده‌ست» (needs ZWNJ) and never «ساده است» |
| نیست | نیست |
| می‌باشد | (level 1) → هست / ـه |

This is the cheapest consistency signal after رو: «این است»→«اینه».

### Negatives

نمی‌شود→نمیشه، نمی‌توانم→نمیتونم، نمی‌خواهم→نمیخوام، نمی‌دانم→نمیدونم،
نمی‌شوند→نمیشن، نمی‌تواند→نمیتونه، نکنید→نکنین. (The نمی prefix itself
follows the orthography rule: attached, no ZWNJ.)

### Lexicon & connectives

| Written (banned) | Colloquial (use) |
|---|---|
| چگونه | چطوری |
| کدام | کدوم |
| چیست / چه چیزی | چیه / چی |
| کیست | کیه |
| کجاست | کجاس |
| اگر | اگه |
| اکنون | الان |
| سپس | بعدش / بعد |
| زیرا / چرا که / از آنجا که | چون |
| بنابراین | پس (docs) / واسه همین (chat) |
| در صورتی که | اگه |
| به منظور | برای |
| می‌بایست / بایستی | باید |
| نیاز دارد | لازم داره / باید |
| امکان دارد | میشه / ممکنه |
| نشان دادن | نشون دادن |
| دانستن / توانستن | دونستن / تونستن |
| آمدن | اومدن |
| مجدداً | دوباره |
| قابل ذکر است که | (delete — just say the thing) |
| مورد استفاده قرار می‌گیرد | استفاده میشه |
| حائز اهمیت است | مهمه |
| جهت انجام | برای انجام |
| کافی است | کافیه |

### What stays as-is

- No chat slang (دمت گرم، خفن) — informal morphology, not slang. Never mix
  slang into level 3 either.
- Technical terms follow the vocabulary list below.
- Persian digits, `ها`/`های` and `تر`/`ترین` spacing — orthography rules below.
- Relative words (امروز، فردا، الان) are fine in prose; exact dates follow
  `jalali-dates`.

## The two hard orthography rules

House rules for all Persian output. Apply them everywhere, no exceptions,
including code comments and UI strings.

### 1. No half-spaces (نیم‌فاصله / ZWNJ, U+200C)

Never emit the zero-width non-joiner character. Replace each one with either
nothing or a plain space, chosen per rule below.

**Attach directly — the می/nمی verb prefix only:**

Examples show the final form (the register table above also applies; the
orthography step alone is just "drop the ZWNJ"):

- می‌شود → میشه، می‌کنند → میکنن، نمی‌شود → نمیشه
- می‌خواهم → میخوام، برمی‌گردد → برمیگرده

**Attach directly — the enclitic pronouns** (these are suffixes on a word, not
compounds; a half-space after them is always wrong):

- نگرانی‌م → نگرانیم، آزادی‌تان → آزادیتان
- نتیجه‌اش → نتیجهاش (possessive enclitic, same rule)

**Full space — the ها/های plural suffix and the تر/ترین suffix:**

- کدوم‌ها → کدوم ها
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
- The colloquial copula ان is a separate word, not a pronoun:
  سالم‌ان → سالم ان، وابسته‌ن → وابسته ان

**Keep attached — standalone words that merely contain the same letters:**

- فراتر، بالاتر، بدترین، بیشترین، دیگری، ساخته، رفته (these are words, not
  suffixes; never split them)

Rule of thumb: prefixes (می) attach; suffixes (ها، تر، ترین) and two
independent words get a plain space. When mechanical replacement, keep an
exclusion list of standalone words, and remember a suffix at the very end of
a string needs a boundary check too.

**آ never attaches.** Alef madda does not join the letter before it, so the
می-prefix rule here means "drop the half-space", NOT "glue the letters":

- `می آورد` (space) or `میاورد` (ZWNJ) — both fine
- `میآورد` (attached) — wrong

Same for `نمی آید` / `نمیآید`, `می آید`, `برمی آورد`. The rule of thumb:
prefixes attach, but آ is a letter that starts a word and keeps its boundary.

### 2. No Arabic diacritics or hamza

Strip every harakat and hamza mark. Persian letters (including آ) stay.

- Kasra/fatha/damma/tanvin: کاملاً → کاملا، فعلاً → فعلا، حتماً → حتما،
  مصنوعیِ شما → مصنوعی شما
- Hamza on heh (ٔ): جلسهٔ → جلسه، صفحهٔ → صفحه، تاریخچهٔ → تاریخچه،
  ریشهٔ → ریشه
- Arabic hamza carriers (ء أ إ ؤ) inside words: تأیید → تایید، مسأله → مساله،
  سؤال → سوال، مؤثر → موثر
- فرآیند → فرایند
- Keep آ (alef madda) — it is a letter, not a diacritic: آفلاین، آرام
- Keep ئ (U+0626) — it is a PERSIAN letter, not an Arabic hamza. جزئیات،
  ارائه، مطمئن، مسائل، رئیس، سوئیچ are all spelled with it and must stay.
  Only the carrier hamzas (ء أ إ ؤ) get stripped; blanket-banning ئ breaks
  ordinary Persian words.
- Use Persian ی (U+06CC) and ک (U+06A9), never Arabic ي (U+064A) or ك
  (U+0643)

## Making it sound natural

Orthography and morphology are mechanical; rhythm is what makes it human.

### Sentence rhythm

- Short sentences. One idea per sentence. Long ezafe chains are the #1
  giveaway of stiff Farsi — break them up.
- Second person is the implicit تو (see above); the stiff third-person
  passive ("انجام می‌گردد") is never right.
- Dashes, colons, and short bullet lists are natural; nested formal clauses
  are not.
- Do not invent Persian jargon. Technical terms follow the vocabulary list
  below.

## Technical vocabulary (dev terms)

This is where most mixed-language output comes from, so read the whole section
before writing. Iranian developers say *some* technical words in English
inside otherwise-Persian sentences ("این commit رو باید rebase کنم") - but
only a small, well-known set. Everything else they say in Persian script.

The failure mode is not "too much English" in the abstract; it is specific
words with obvious Persian equivalents drifting into Latin mid-sentence
(«debug print جا مونده», «کامنت stale», «schema داده»). Treat those as bugs.

### Tier A — stays Latin (closed list)

These have no natural Persian form and Iranians type them in English. Nothing
else joins this list without a reason:

commit, push, pull, pull request / PR, merge, rebase, branch, checkout,
stash, cherry-pick, lint, hook, cache, endpoint, token, repo, patch, import,
helper, caller, suite, shell, silence.

### Tier B — Persian script, TRANSLITERATED (keep the sound, invent no word)

Write the English word in Persian letters. Never coin a Persian phrase for
these - a literal-but-natural Persian compound reads worse than a
transliteration («تصویر لحظه ای» for "snapshot" is cursed; «اسنپ شات» is
what people actually say).

- system → سیستم، harness → هارنس، build → بیلد، deploy → دیپلوی
- runtime → رانتایم، backend → بک اند، frontend → فرانت اند، framework → فریم ورک
- production → پروداکشن، sprint → اسپرینت، bug → باگ
- snapshot → اسنپ شات، boolean → بولین، atomic → اتمیک، global → گلوبال
- IDE, CLI, JSON, YAML, SQL, HTTP, URL, CSS, HTML (acronyms stay Latin)

### Tier C — a real Persian word

These have settled Persian equivalents Iranian developers actually use
(orthography follows the house rules above, so no half-spaces):

- error → خطا
- warning → هشدار
- file → فایل
- folder/directory → پوشه
- setting(s) → تنظیمات
- user → کاربر
- password → رمز عبور
- install → نصب
- update → به روزرسانی
- delete/remove → حذف
- print (the output) → چاپ
- debug (the concept) → اشکال زدایی
- stale → کهنه
- schema → ساختار (so "data schema" → ساختار داده)
- working tree → درخت کاری
- fallback → جایگزین
- call site → محل فراخوانی
- initiative → نوبت دهی
- element / elemental → عنصر / عناصر
- refactor → بازسازی
- stage (git) → مرحله بندی
- diff → تفاوت ها
- mock → ماژول ساختگی
- fixture → داده آزمایشی
- payload → بدنه / محتوای ارسالی
- save → ذخیره (سیو also fine)
- failure → شکست
- skip → رد شدن / رد کردن (اسکیپ also fine)
- track (git) → ثبت
- load → بارگذاری
- ignore → نادیده گرفتن (ایگنور also fine)
- lack → کمبود
- repository → مخزن، dependency → وابستگی، deprecated → منسوخ
- function → تابع، method → متد، variable → متغیر، array → آرایه
- loop → حلقه، test → تست، stack trace → ردپای خطا

**A Persian word and its transliteration are both idiomatic** — offer either
(«نادیده گرفتن» or «ایگنور», «رد شدن» or «اسکیپ»). What is NOT idiomatic is
coining a compound nobody says: "snapshot" is «اسنپ شات», never «تصویر لحظه ای».

### Not forced — write them in Persian, no hard rule

Persian has no single right answer for these, so there is no rule; just do
not leave them in Latin by default:

- player → بازیکن
- sim (simulation) → شبیه سازی
- targeting → هدفگیری
- annotation → توضیح / یادداشت کنار کد

### Tier D — identifier vs concept (the distinction that gets missed most)

A literal symbol from the code stays Latin, in backticks. The *idea* behind
it gets a Persian word. Never let the identifier stand in for the concept:

| In the code (Latin, backticked) | In prose (Persian) |
|---|---|
| `stdout`, `stderr` | خروجی / خطای استاندارد |
| `debugPrint()` | اشکال زدایی |
| `test_sim.py` | فایل تست |
| `f1_gate` | دروازه طبقه یک |
| `return 2` | برگردوندن ۲ |

So «یه `print` جا مونده توی `sim.py`» is wrong twice: the concept is چاپ
(not `print`), and only the function name would stay Latin.

**Default: Persian script.** A term in none of the tiers gets written in
Persian script — a transliteration if it sounds like a word (tier B), a
Persian word if one exists (tier C). Latin is the exception that requires a
tier-A reason. If you genuinely cannot place a word, transliterate it; do not
default to English.

**Git commit messages are ALWAYS English**, whatever language the rest of the
text is in (tooling, search, and team review all expect it), with
Gregorian/ISO dates (see `jalali-dates`).

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

Input (stiff, half-spaces, diacritics, level 1-2):
> دستیار کدنویسی مبتنی بر هوش مصنوعیِ متن‌باز برای VS Code. بدون نیاز به
> بک‌اند و حساب کاربری. تمامی عملیات به‌صورت محلی انجام می‌گردد.

Output (level 3):
> ایجنت کدنویسی هوش مصنوعی متن باز برای VS Code. کلید خودت یا یه رانتایم
> محلی. همه چیز توی extension host و روی سیستم خودت اجرا میشه.

**Example 2 — feature bullet**

Input:
> ویرایش فایل‌ها نیازمند تأیید کاربر می‌باشد و قابل ذکر است که این فرآیند
> به‌صورت قطعی اعمال می‌گردد.

Output:
> ویرایش فایل ها رو باید تایید کنی و این محدودیت توی کد اعمال میشه، نه توی
> پرامپت.

**Example 3 — UI string**

Input:
> ذخیره‌سازی تنظیمات با موفقیت انجام گردید.

Output:
> تنظیمات ذخیره شد.

**Example 4 — code walkthrough (the classic drift trap)**

Input (mixed registers — common raw LLM output):
> آرگومان ها را میخواند، بعد `Game(...)` را میسازد و `game.run()` را صدا
> میزند. همان طور که گفتم، این بخش مهم است و اگر آن را نخوانی گم میشوی.

Output:
> آرگومان ها رو میخونه، بعد `Game(...)` رو میسازه و `game.run()` رو صدا
> میزنه. همون طور که گفتم، این بخش مهمه و اگه رو نخونی گم میشی.

**Example 5 — mixed line in a UI row**

Broken (label and URL share one run; the separator relocates):
> `HTTP جریانی·https://mcp.example.com/mcp` rendered as a scrambled mash.

Fixed (isolated runs inside an LTR row):
> `<span dir="auto">HTTP جریانی</span> · <span dir="ltr">https://mcp.example.com/mcp</span>`
> inside a `dir="ltr"` row container.

**Example 6 — tier C words left in Latin (observed in a real session)**

Every one of these has an obvious Persian equivalent and none of them is
tier A or an identifier:

Input:
> یه debug print جا مونده. یه کامنت stale توی `sim.py` هست. schema داده هم
> اضافه شده. working tree از این نظر تمیزه و به `f1_gate` fallback میکنه.
> اول call site ها رو چک میکنم. initiative بر اساس سرعت محاسبه میشه.

Output:
> یه چاپ اشکال زدایی جا مونده. یه کامنت کهنه توی `sim.py` هست. ساختار داده
> هم اضافه شده. درخت کاری از این نظر تمیزه و به `f1_gate` جایگزین میکنه.
> اول محل فراخوانی ها رو چک میکنم. نوبت دهی بر اساس سرعت محاسبه میشه.

**Example 7 — tier D: identifier vs concept**

Input:
> اون تست فقط `stdout` رو redirect میکنه، ولی `stderr` از قلم افتاده.

Output:
> اون تست فقط خروجی رو هدایت میکنه، ولی خطای استاندارد از قلم افتاده.

(The symbols stay Latin when you must name them — «فقط `stdout` رو میگیره» —
but the prose around them is Persian.)

**Example 8 — mid-conversation drift into English**

Input (real transcript, all of it wrong):
> I need to verify each flag myself before touching anything.
> Now the commits. I'm splitting into 4 rather than the 5 originally proposed.
> Working tree is clean and 222 tests pass at HEAD.

Output:
> اول خودم همه پرچم ها رو با چشم خودم تایید میکنم، بعد دست میزنم.
> حالا commit ها. ۴ تا میزنم نه ۵ تایی که اولش گفته شد.
> درخت کاری تمیزه و ۲۲۲ تست روی HEAD پاس میشن.

## Checklist before delivering Farsi text

Machine-checkable first; ear-check last. All greps are word-boundary (not
inside longer words like راست / استفاده / پرداخت).

1. No U+200C anywhere; می attaches, enclitics attach, ها/های/تر/ترین spaced
   (exclusion list respected)
2. No harakat, no Arabic hamza carriers (check ً ِ ُ َ ٔ ء أ إ ؤ), no Arabic
   ي/ك — ئ is fine, it is a Persian letter
3. Zero standalone را (رو only), zero همان/آن (همون/اون)
4. Zero written verb endings: میدهد|میکند|میشود|دارد|میخواند|میداند|
   میتواند|میگوید|میگذارد|میآید|میرود|می‌خواهی|می‌توانی|می‌دانی and
   کنید|بگویید|بیایید|بخوانید|بدانید (کنین/بگید/بیاین/بخونید/بدونید)
5. Zero standalone است (use ـه or هست), zero می‌باشد/میگردد
6. Every Latin word outside backticks is tier A, an acronym, or a literal
   code symbol — everything else is in Persian script
7. No sentence and no message without Persian letters
8. Every mixed Persian/URL/path line rendered and read both ways; runs
   isolated
9. Read it aloud in your head — if it sounds like a government letter OR a
   translated textbook, rewrite it

The bundled `check-register.mjs` runs checks 1-7 mechanically:

```bash
node ~/.agents/skills/natural-farsi/check-register.mjs draft.txt
# or: pbpaste | node ~/.agents/skills/natural-farsi/check-register.mjs
```

Run it on the FINAL Persian output only — quoted source text in a
translation task is exempt (it is supposed to look wrong), and a document
that is not Persian at all is exempt too (pass `--allow-no-persian` for an
English source you are translating FROM).
