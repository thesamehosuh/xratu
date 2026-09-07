# خراتو

<p align="center">
  <img src="assets/brand/logo-128.png" width="88" alt="Xratu" />
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="#خراتو">فارسی</a>
</p>

<p align="center">
  <a href="https://github.com/thesamehosuh/xratu/actions/workflows/ci.yml"><img src="https://github.com/thesamehosuh/xratu/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC.svg" alt="VS Code 1.90+" />
</p>

ایجنت کدنویسی هوش مصنوعی متن باز برای VS Code. کلید خودتان یا یک رانتایم
محلی. همه چیز درون extension host و روی سیستم خودتان اجرا میشود.

## کلید شما. مدل شما. سیستم شما.

- کلید های API در مخزن secrets ادیتور VS Code ذخیره میشوند و فقط به
  اندپوینت تنظیم شده توسط کاربر میروند.
- کاملا آفلاین کار میکند: Ollama، LM Studio، vLLM و llama.cpp به طور
  خودکار شناسایی میشوند.

## امکانات

- **کدنویسی ایجنتیک** - خواندن فایل، ویرایش کد، اجرای دستور ترمینال و
  جستجوی وب. هر ویرایش و دستور به تایید شما نیاز دارد؛ تایید خودکار هر
  ابزار برای گردش کار های مورد اعتماد، و حالت YOLO برای حذف کامل تایید ها.
- **حالت Plan** - برنامه ریزی فقط خواندنی (read-only) با فهرست کار. ابزار های ویرایش
  در سطح کد مسدود میشوند، نه با پرامپت.
- **Checkpoint** - اسنپ شات shadow-git پیش از ارسال ها و ویرایش ها، با
  بازیابی هر زمان. مخزن git واقعی شما دستکاری نمیشود.
- **سرور های MCP** - از طریق stdio، WebSocket یا HTTP/SSE، با پیکربندی
  فایل محور سازگار با Cline.
- **مهارت های ایجنت** - استاندارد باز
  [agentskills.io](https://agentskills.io)؛ قابل اشتراک با Claude Code،
  Roo Code، OpenCode و دیگر ابزار ها.
- **جلسه های طولانی** - هدایت وسط کار، ویرایش و ارسال مجدد هر پیام، پیوست
  تصویر و PDF، فشرده سازی خودکار زمینه.

## مدل ها

| گروه | ارائه دهنده ها |
|------|----------------|
| ابری | OpenAI، Google Gemini، OpenRouter، xAI، Groq، DeepSeek، Mistral، Perplexity، Cohere، Together، Fireworks، Cerebras، NVIDIA NIM، Hugging Face، SambaNova، Moonshot، Z.AI، OpenCode Zen |
| محلی | Ollama، LM Studio، vLLM، llama.cpp |
| سفارشی | هر اندپوینت HTTPS سازگار با OpenAI |

## شروع به کار

نصب از VS Code Marketplace:
[xratu.xratu](https://marketplace.visualstudio.com/items?itemName=xratu.xratu)

اگر نصب دستی را ترجیح میدهید، آخرین فایل `xratu-*.vsix` را از
[Releases](https://github.com/thesamehosuh/xratu/releases) بگیرید و از
طریق **Code → Extensions → ⋯ → Install from VSIX…** نصب کنید.

1. پنل خراتو را از نوار کناری باز کنید.
2. یک پریست یا رانتایم محلی انتخاب کنید، کلید API را وارد کنید و مدل را
   انتخاب کنید.
3. گفتگو را شروع کنید. ویرایش ها و دستور ها را حین کار ایجنت تایید کنید -
   یا وقتی به روند کار اعتماد کردید، تایید خودکار را روشن کنید.

## سرور های MCP

پیکربندی از دو فایل خوانده میشود:

- **سراسری**: `mcp.json` در global storage افزونه
- **فضای کاری**: `.xratu/mcp.json` در ریشه پروژه (به ازای هر کلید سرور، بر
  پیکربندی سراسری اولویت دارد)

قالب پیکربندی با Cline سازگار است: `command`/`args`/`env` برای stdio و
`url` برای سرور های راه دور. ابزار ها با نام `mcp__<server>__<tool>` به ایجنت
میرسند و همان فرایند تایید ابزار های داخلی را دارند.

## مهارت های ایجنت

هر مهارت پوشه ای با فایل `SKILL.md` است - frontmatter YAML
(`name` + `description`) به همراه بدنه مارکداون. ابتدا فقط نام و توصیف
بارگیری میشود؛ ایجنت هنگام تطابق درخواست شما، بقیه را از طریق ابزار
`skill` میخواند. ترتیب جستجو (اولین تطابق برنده است):

- `.xratu/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md` (مشترک با ابزار های ایجنتی دیگر)
- `.claude/skills/<name>/SKILL.md` (Claude Code)
- `~/.agents/skills/<name>/SKILL.md`
- `~/.claude/skills/<name>/SKILL.md` (Claude Code)

```markdown
---
name: deploy-staging
description: Deploy the app to staging; use when the user asks to deploy or ship to staging.
---

1. Run the test suite
2. Build the app
3. `npm run deploy:staging`
```

فایل های جانبی (اسکریپت، مرجع، قالب) کنار `SKILL.md` قرار میگیرند.
فعال/غیرفعالسازی مهارت ها در Settings → Servers & skills → Skills.

## حریم خصوصی

کلید های API در مخزن secrets ادیتور VS Code ذخیره میشوند و فقط به
اندپوینتی که خودتان تنظیم کرده اید ارسال میشوند. تاریخچه گفتگو و
Checkpoint ها فقط روی دیسک شما هستند.

## توسعه

```bash
npm ci
npm run compile        # باندل میزبان (esbuild) + وب ویو (vite)
npm run test:webview
```

CI برای میزبان و وب ویو بررسی نوع جداگانه انجام میدهد و تست ها را روی
Ubuntu و ویندوز اجرا میکند. جزئیات در [AGENTS.md](AGENTS.md).

## مشارکت

Issue و Pull Request خوش آمدند. پیش از تغییر های بزرگ، یک Issue باز کنید.
Conventional Commits، CI سبز و بازبینی کد برای هر PR الزامی است.

## مجوز

[Apache-2.0](LICENSE)
