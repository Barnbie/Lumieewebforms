# Lumiee Web Studio — Agentic Client System

## Project Structure

```
lumiee-studio/
│
├── index.html                          ← Client intake form (Phase 1 - done)
├── admin.html                          ← Your dashboard (Phase 6 - coming)
├── netlify.toml                        ← Netlify config and redirects
├── package.json                        ← Node dependencies
│
├── supabase/
│   └── schema.sql                      ← Run this in Supabase SQL Editor
│
└── netlify/
    └── functions/
        ├── _lib/
        │   ├── supabase.js             ← Shared DB client (service role)
        │   └── notify.js              ← WhatsApp + Email helpers
        │
        ├── submit-form.js             ← Receives form, triggers Agent 1
        ├── agent-intake.js            ← Agent 1: reads form, drafts reply + invoice (Phase 3)
        ├── approve.js                 ← Approval endpoint for your WhatsApp tap (Phase 3)
        ├── paystack-webhook.js        ← Agent 2: payment detection (Phase 4)
        ├── agent-onboarding.js        ← Agent 3: project brief + kickoff (Phase 5)
        └── dashboard.js               ← Dashboard data API (Phase 6)
```

---

## Setup Checklist

### Step 1 — Supabase (do this now)
- [ ] Go to your Supabase project
- [ ] Click SQL Editor in the left sidebar
- [ ] Paste the entire contents of `supabase/schema.sql`
- [ ] Click Run
- [ ] Confirm all 6 tables were created

### Step 2 — Netlify Environment Variables (do this now)
Go to your Netlify dashboard → Site settings → Environment variables and add:

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → service_role key |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `TWILIO_ACCOUNT_SID` | Twilio console |
| `TWILIO_AUTH_TOKEN` | Twilio console |
| `TWILIO_WHATSAPP_FROM` | e.g. `+14155238886` (Twilio sandbox number) |
| `OWNER_WHATSAPP` | Your WhatsApp number e.g. `+2348100000000` |
| `BREVO_API_KEY` | Brevo dashboard → SMTP & API → API Keys |
| `OWNER_EMAIL` | Your email address |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → Settings → API |
| `PAYSTACK_WEBHOOK_SECRET` | Paystack dashboard → Settings → Webhooks |
| `BASE_URL` | Your Netlify site URL e.g. `https://lumiee.netlify.app` |

### Step 3 — Deploy to Netlify
- [ ] Push this entire folder to a GitHub repo
- [ ] Connect the repo to Netlify
- [ ] Netlify auto-deploys on every push

---

## What is Built So Far

- Phase 1: Client intake form (complete)
- Phase 2: Database schema + project structure (complete)
- Phase 3: Agent 1 — intake agent + approval flow (next)
- Phase 4: Agent 2 — payment agent + Paystack webhook (coming)
- Phase 5: Agent 3 — onboarding agent (coming)
- Phase 6: Admin dashboard (coming)
