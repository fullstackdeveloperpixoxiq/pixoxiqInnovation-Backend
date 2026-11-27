# Pixpi AI

The Pixpi AI is the company's virtual assistant on the public website. It answers questions about PIXOXIQ using **only** the verified information in its knowledge base (retrieval-augmented generation). It is separate from the Carmana ERP and Ostik chatbots.

It spans three repositories:

| Repo | What was added |
|---|---|
| `pixoxiqInnovation-Backend` | AI provider layer, chat API, knowledge base + RAG pipeline, admin APIs |
| `pixoxiqInnovation-AdminPanel` | "AI Assistant" section: Overview, Knowledge Base, Conversations, Usage & Logs, AI Configuration, Chatbot Settings |
| `pixoxiqInnovation` (website) | Floating chat widget on every page + full-page assistant at `/assistant` |

## 1. Architecture

```
Website (Vercel)                  Backend (Render, Express + MongoDB)                 AI provider
┌──────────────┐  SSE stream   ┌──────────────────────────────────────────────┐     ┌──────────────┐
│ ChatWidget   │──────────────▶│ /api/public/chat  (chatController)           │     │ OpenAI /     │
│ /assistant   │ X-Chat-Session│   └─ chatService.generateReply               │────▶│ Anthropic /  │
└──────────────┘               │        ├─ retrieval.searchKnowledge (hybrid) │     │ Gemini /     │
                               │        ├─ prompt.buildSystemPrompt           │     │ OpenAI-compat│
Admin panel (Render)           │        └─ configService.getChatClient ───────┼────▶└──────────────┘
┌──────────────┐  JWT          │ /api/ai  (aiConfig/knowledge/aiAdmin ctrl)   │
│ AI Assistant │──────────────▶│   └─ indexer: extract → chunk → embed → store│
└──────────────┘               └──────────────────────────────────────────────┘
```

### No default model
* No provider, model or API key exists in code or environment variables. A **superadmin** picks a provider and enters/selects a model id in the admin panel.
* Every save runs a live validation: credentials → model is in the provider's model list → a real request to the model. A configuration that fails is **not saved**.
* The live request uses the same generation parameters as real chats (the Chatbot Settings temperature). Changing the temperature later is also checked against the active model, so a model that rejects a custom temperature (for example OpenAI reasoning models) can never be left in a state where every chat fails.
* Reasoning/thinking models (OpenAI o-series/GPT-5, Gemini 2.5, ...) spend part of *Max output tokens* on hidden reasoning. If an answer comes back empty because the budget ran out, the AI log says so: raise *Max output tokens* in Chatbot Settings.
* If nothing is configured, the website hides the widget and the API answers `503` with a clear configuration error (and logs it).
* If the provider fails while answering, the error is logged and the visitor sees a generic message. **There is no retry with, or switch to, another model.**

### Provider layer (`src/ai/providers/`)
* `catalog.js`: supported providers (OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Mistral, DeepSeek, Ollama, any custom OpenAI-compatible API) and their capabilities.
* Three wire-protocol adapters with an identical interface (`chat`, `listModels`, `embed`): `openai.js` (OpenAI and all OpenAI-compatible APIs), `anthropic.js`, `gemini.js`. They use plain `fetch` with no SDKs.
* **Adding a provider:** if it is OpenAI-compatible, add one entry to `catalog.js`. Otherwise write an adapter with the same three functions and register it in `providers/index.js`. Nothing else changes.

### Knowledge base & RAG (`src/ai/`)
1. **Ingest:** admins type entries, upload documents (PDF, DOCX, TXT, MD, CSV, JSON, HTML; max 10 MB) or click **Sync website content** (imports active services, vacancies, certificates and the visiting-card contact details).
2. **Extract** (`textExtract.js`): the file type is verified from its magic bytes; text is extracted (`unpdf`, `mammoth`), and control characters are stripped. The original file is not stored.
3. **Chunk** (`chunker.js`): ~1,200-character chunks with 200-character overlap, split on paragraph/sentence boundaries.
4. **Embed** (`indexer.js`): background queue. If an embedding model is configured, each chunk is embedded; otherwise chunks are stored for keyword search only. Status: `pending → processing → indexed | failed`. Unfinished jobs resume on restart.
5. **Retrieve** (`retrieval.js`): hybrid scoring, `0.8 × cosine similarity + 0.2 × BM25`. With no embedding model it uses BM25 + term coverage. Follow-up questions include the previous question in the search query.
6. **Generate** (`chatService.js`, `prompt.js`): the top chunks are grouped per entry and numbered `[1]…[n]`. The system prompt forces answers to come only from them, with citations.

**Sync rules:** editing an entry deletes its old chunks immediately, so outdated facts are never served while it re-indexes. Deleting an entry deletes its chunks. Deactivating hides it from retrieval. Changing the embedding model re-indexes everything automatically.

The vector index is kept in memory and rebuilt on change. This suits a company knowledge base (up to tens of thousands of chunks on one instance). For a much larger corpus or several backend instances, replace the body of `searchKnowledge()` with MongoDB Atlas Vector Search; callers do not change.

### Live company data (`src/ai/companyData.js`)
Structured website content is **not** taken from vector search. For every question the assistant reads the published records straight from the existing collections (`services`, `visitingcards`, plus `certificates` / `vacancies` when the question is about them) and puts them first in the model context:
* the complete list of published services (title, description, features, page link), so "what services do you offer?" always lists all of them;
* full details (`content`) of up to 3 services the question names;
* contact details and the company "about" text from the visiting card.

Only `isActive: true` records are used. Mongoose hooks on these models (`utils/changeTracker.js`) refresh the cache on any create/update/delete/publish toggle/reorder, with a 60-second safety expiry, so admin changes apply to the next question with no manual sync. Knowledge entries created by the older **Sync website content** button (`sourceType: website`) are skipped in search, so they can never duplicate or contradict the live data. The knowledge base remains the place for information that has no website module (company profile documents, projects, technologies, FAQs).

### Conversation context
* Only the last **N messages** are sent (Chatbot Settings → History window, default 10).
* Older messages are folded into a **rolling summary** (stored on the conversation) using the same configured model, after the answer has been sent.

## 2. Database collections (new)

| Collection | Purpose |
|---|---|
| `aiconfigs` | Single doc. `chat` and `embedding` targets: `provider`, `model`, `baseUrl`, `apiKeyEnc` (AES-256-GCM, `select: false`), `apiKeyLast4`, `dimensions`, `status {ok, checkedAt, message, latencyMs}` |
| `chatsettings` | Single doc. `enabled` (default **false**), `assistantName`, `welcomeMessage`, `suggestedQuestions`, `additionalInstructions`, `temperature` (null = provider default), `maxOutputTokens`, `historyWindow`, `retrievalTopK`, `minRelevance`, `maxMessageLength`, `visitorDailyQuestionLimit` (10), `userDailyQuestionLimit` (100), `visitorIpDailyLimit` (30, 0 = off), `inputTokenPricePerMillion` / `outputTokenPricePerMillion` (USD, cost estimates), `retentionDays` |
| `knowledgeentries` | `title`, `category`, `content` (`select: false`), `contentHash`, `sourceType` (`manual`/`file`/`website`), `sourceRef`, `file {name, mimeType, size}`, `isActive`, `status`, `error`, `chunkCount`, `embeddingKey`, `indexedAt` |
| `knowledgechunks` | `entry`, `index`, `title`, `category`, `text`, `embedding [Number]`, `embeddingKey` |
| `chatconversations` | `visitorHash` (SHA-256 of the visitor token, `select: false`), `visitorTag`, `title`, `messageCount`, `lastMessageAt`, `summary`, `summarizedCount`, token totals |
| `chatmessages` | `conversation`, `visitorHash` (`select: false`), `role`, `content`, `sources`, `provider`, `model`, `usage {inputTokens, outputTokens}`, `latencyMs`, `finishReason`, `interrupted`, `regenerated` |
| `chatusages` | Daily question quota counters, one per subject per IST day. `subjectKey` (`u:<userId>`, `v:<sha256 cookie>`, `s:<sha256 session>`, `ip:<hmac ip>`), `subjectType`, `authenticated`, `user`, `isPrimary`, `day` (YYYY-MM-DD, Asia/Kolkata), `used`, `limit`, `remaining`, `failed`, `answered`, `inputTokens`, `outputTokens`, `carriedOver`, `createdAt`, `updatedAt`. Unique index `(subjectKey, day)`. TTL 400 days |
| `ailogs` | Redacted error/event log: `level`, `source`, `message`, `code`, `provider`, `model`, `providerStatus`, `context`. TTL 90 days |

`chatsettings.dailyMessageLimit` (rolling 24 h) was replaced by the daily quota fields above. Indexes are created automatically by Mongoose.

## 3. API

All responses use the existing `{ success, data, message }` envelope.

### Public: `/api/public/chat` (website)
| Method | Path | Notes |
|---|---|---|
| GET | `/status` | `{ enabled, assistantName, welcomeMessage, suggestedQuestions, maxMessageLength }` |
| POST | `/session` | Issues an anonymous session token (30/hour/IP) |
| GET | `/conversations` | Own conversations (needs `X-Chat-Session`) |
| GET | `/conversations/:id` | Own conversation + messages |
| DELETE | `/conversations/:id` | Delete own conversation |
| POST | `/messages` | `{ message, conversationId? }` → SSE stream (`?stream=0` for JSON). 12/min/IP + daily per-visitor cap |
| POST | `/conversations/:id/regenerate` | Replace the last answer (SSE). The previous answer is only deleted once the new one is stored, so a failed regeneration keeps it |

SSE events: `meta {conversation}` → `usage {…}` → `sources [{title, category}]` → `delta {text}`… → `done {message, conversation, usage}` or `error {message, usage}`. With `?stream=0` the JSON is `{ success, answer, usage, data: { message, conversation, usage } }`.

### Daily question quotas (`src/ai/quotaService.js`)
* Visitors: **10** questions per day, logged-in users: **100** (Chatbot Settings). Quotas reset at **midnight IST** (Asia/Kolkata). A new message and a regenerated answer each use one question.
* Enforced only on the server, before the AI provider is called: identify → IST day → atomic reserve (`used < limit` conditional upsert on the unique `(subjectKey, day)` index, so parallel requests can never exceed the limit) → AI request → on a server/provider error the question is refunded (`failed` +1). Empty/too long messages, unknown conversations and other rejected requests are never counted. A visitor pressing *Stop* still uses the question (the provider already worked on it).
* Users are identified by the verified JWT (`optionalUser`), never by a client-supplied id.
* Visitors are counted on an HttpOnly signed cookie `pxq_vid` (path `/api/public/chat`; `SameSite=None; Secure; Partitioned` in production because the website and API are on different sites) **and** on the session token, plus a per-network ceiling (`visitorIpDailyLimit`). Refreshing, or clearing only the cookie or only localStorage, keeps the quota.
* Logging in carries today's visitor questions into the user counter (e.g. 10 used as a visitor → 90 left); logging out finds the visitor counters unchanged.
* `GET /usage` → `{ limit, used, remaining, resetsAt, timezone, authenticated, authenticatedLimit? }` (`authenticatedLimit`: visitors only, the logged-in quota). When the limit is reached, `POST /messages` and `/regenerate` return **429** `{ success: false, code: "quota_exceeded", message, usage }` with `Retry-After`.
* Tests: `npm test` (starts a throwaway `mongod` and a fake OpenAI-compatible provider; never uses `.env`'s database).

### Admin: `/api/ai` (JWT; 🔒 = superadmin only)
| Method | Path | |
|---|---|---|
| GET | `/overview`, `/usage?days=7\|30\|90` | Dashboard and analytics |
| GET | `/quota?days=7\|30\|90` | Question quotas: today's totals (users / visitors, utilization, at limit, failed, tokens, estimated cost, blocked networks), daily series, most active users |
| GET / DELETE🔒 | `/logs` | Paginated logs (`level`, `source`, `search`) / clear |
| GET | `/providers`, `/config` | Catalog; masked config + status |
| POST🔒 | `/config/models` | List models for `{purpose, provider, baseUrl?, apiKey?}` |
| POST🔒 | `/config/test` | Live test without saving |
| PUT🔒 / DELETE🔒 | `/config/chat`, `/config/embedding` | Validate & save / remove |
| GET / PUT🔒 | `/settings` | Chatbot settings |
| POST | `/test-chat` | Full RAG pipeline, nothing stored |
| GET / POST | `/knowledge` | List (filters) / create text entry |
| POST | `/knowledge/upload` | multipart `file`, `category`, `title?` |
| GET / PUT / DELETE | `/knowledge/:id` | Read (with content) / update / delete |
| PUT | `/knowledge/:id/file` | Replace a document |
| POST | `/knowledge/:id/reindex`, `/knowledge/reindex` | Re-index one / all |
| POST | `/knowledge/sync-website` | Import website content |
| POST | `/knowledge/search` | Retrieval preview |
| GET | `/knowledge/categories` | Suggested + used categories |
| GET / DELETE | `/conversations`, `/conversations/:id` | Review / delete |

## 4. Environment variables (backend)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AI_ENCRYPTION_KEY` | **yes** (for AI) | — | 32-byte key (64 hex chars) to encrypt provider API keys. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it stable; changing it means re-entering keys |
| `CHAT_RATE_LIMIT_PER_MINUTE` | no | 12 | Chat requests per IP per minute |
| `CHAT_IDENTITY_RATE_LIMIT_PER_MINUTE` | no | 8 | Chat requests per visitor / user per minute (any IP) |
| `CHAT_SESSIONS_PER_HOUR` | no | 30 | New chat sessions per IP per hour |
| `AI_PROVIDER_TIMEOUT_MS` | no | 90000 | Timeout per provider request |
| `KNOWLEDGE_MAX_FILE_MB` | no | 10 | Max knowledge document size |

No AI provider keys go into environment variables. The website and admin panel need no new variables: they use their existing `VITE_API_URL`.

## 5. Setup

1. **Backend:** `npm install`, add `AI_ENCRYPTION_KEY` to `.env`, restart.
2. **Admin panel → AI Assistant → AI Configuration** (as superadmin):
   * **Chat model (required):** choose provider → paste API key → *Load* models or type the exact model id → *Test connection* → *Validate & activate*.
   * **Embedding model (recommended):** e.g. OpenAI, Gemini, Mistral or Ollama with an embedding model. Without it retrieval is keyword-only.
3. **Knowledge Base:** click *Sync website content*, then add the company profile, products/services, projects, technologies, operations, FAQs and contact details (typed or uploaded). Wait until every entry shows **Indexed**, then use *Test retrieval* to check what is found.
4. **Chatbot Settings:** review texts and limits, try the *Test the assistant* playground, then switch **Availability** on. The widget appears on the website within a few minutes (status is cached for 5 minutes per visitor).

## 6. Local testing

```bash
# backend
cd pixoxiqInnovation-Backend && npm install && npm run dev        # http://localhost:5000
# admin panel
cd pixoxiqInnovation-AdminPanel && npm install && npm run dev     # http://localhost:5173
# website
cd pixoxiqInnovation && npm install && npm run dev                # http://localhost:8080
```
For a free local model, run [Ollama](https://ollama.com), pull a chat model and an embedding model, and configure both with the **Ollama** provider (base URL `http://localhost:11434/v1`).

Checklist: unconfigured → widget hidden and `POST /messages` returns 503; wrong key or model → save rejected; upload PDF/DOCX → *Indexed*; ask a question covered by the knowledge base → cited answer; ask something not covered → the assistant says it has no verified information; stop, regenerate, new conversation and history all work; a second browser cannot open the first browser's conversation.

## 7. Deployment

1. **Backend (Render):** add `AI_ENCRYPTION_KEY` in the service environment (and keep a secure copy). Deploy; the new dependencies are `unpdf` and `mammoth`. Render already proxies SSE; the API sends `X-Accel-Buffering: no` and a heartbeat every 15 s.
2. **Admin panel (Render static):** redeploy, no new variables.
3. **Website (Vercel):** redeploy, no new variables. The widget stays hidden until the assistant is enabled.
4. Configure the provider, load the knowledge base, test in the playground, then enable.

**Scaling note:** the indexing queue and vector cache are in-process. With more than one backend instance, run indexing on one instance and move retrieval to Atlas Vector Search (see section 1).

## 8. Security checklist

- [x] Provider API keys only on the backend, AES-256-GCM encrypted at rest, write-only through the API (only `••••last4` returned).
- [x] Secrets redacted from all logs and error messages (`redact.js`); visitors never see provider or model names or raw errors.
- [x] AI configuration and settings are superadmin-only; other admin endpoints use the existing JWT `protect` middleware.
- [x] Every save is validated live; no default model and no silent fallback.
- [x] Anonymous visitor sessions: random 256-bit tokens, stored only as SHA-256 hashes; all conversation queries are scoped to the hash.
- [x] Rate limits: chat per IP and per visitor/user per minute, sessions per IP per hour, daily question quotas (visitor cookie + session + network, or user id), admin AI calls per minute.
- [x] Input validation: message length cap, control characters stripped, ObjectId checks, whitelisted fields (no mass assignment).
- [x] Uploads: extension allow-list, magic-byte verification, size limit, memory-only processing, original files not kept.
- [x] Prompt injection: knowledge and summaries are wrapped as data with tag-escaping, and the system prompt orders the model to ignore embedded instructions and never reveal its configuration. Admin "additional instructions" cannot override the core rules.
- [x] Output rendering: the website renders answers with `react-markdown` (no raw HTML, unsafe URLs stripped, links `rel="noopener noreferrer nofollow"`).
- [x] Privacy: configurable conversation retention (default 180 days) with automatic deletion; logs expire after 90 days.
- [ ] Before go-live: set `AI_ENCRYPTION_KEY` in production, confirm `CLIENT_URLS`, review the knowledge base content, and set spending limits at the AI provider.

## 9. Enquiry classification and job-enquiry access

* **Intent layer** (`src/ai/intentService.js`): every question (new message or regeneration) is classified by the configured chat model from the recent conversation, as `JOB_ENQUIRY`, `WEBSITE_ENQUIRY` or `AMBIGUOUS`, with a confidence score (stored on the user message and the conversation). Below 0.6 confidence the assistant asks a clarifying question instead of guessing. The browser never supplies the category.
* **Job enquiries need a logged-in account or a verified email** (`src/ai/chatAccess.js`). Otherwise `POST /messages` and `/regenerate` return **403** `{ code: "verification_required", message, conversation, usage }`; the question is kept in the conversation (`awaitingVerification`) and its quota unit refunded. After login or verification the website calls `/regenerate` to continue the same conversation. As a second safeguard, recruitment data (vacancies and career knowledge entries) is never given to the answering model for an unauthorised visitor.
* **Email OTP** (no account): `POST /verification/request { email }` → 6-digit code by email (hashed in `chatotpchallenges`, expires after `CHAT_OTP_TTL_MINUTES`, 60 s resend cooldown, 5 sends/hour per session, 5 attempts per code, per-IP limiter). `POST /verification/confirm { email, otp }` marks the chat session as verified for 30 days (`chatverifiedsessions`, keyed by the session token hash). `GET /verification` / `DELETE /verification` read or remove it. Verification does not change the question quota (visitors keep the visitor limit).
* **Enquiry records** (`chatenquiries`, unique per conversation + type): job enquiries for logged-in users and verified guests, website enquiries for logged-in users. Anonymous visitors never get one. Records are deleted with their conversation (visitor delete, admin delete, retention job).
* **Admin API**: `GET /api/ai/enquiries?type=job|website&status&search&from&to&page` (`export=1` for up to 5000 rows), `GET /api/ai/enquiries/stats`, `GET /api/ai/enquiries/:id` (with conversation), `PATCH /api/ai/enquiries/:id/status { status: new|in_progress|resolved }`. Admin panel: AI Assistant → Enquiries.

## 10. Odoo Recruitment integration (chatbot job enquiries)

Verified against the production instance (read-only): **Odoo 19.0 Enterprise, JSON-2 API** (`/json/2/<model>/<method>`, API key as bearer token). `hr.candidate` does not exist in 19; `hr.applicant` has no `name`/`description`. The client still falls back to JSON-RPC for older Odoo (needs the API user login).

**Flow.** Verified visitor (account or email OTP) asks job questions → the assistant collects details conversationally (`src/ai/candidateService.js`: only facts the candidate stated; account name/phone and the verified email are never re-asked) → the candidate reviews them in the chat's **Application** panel, optionally attaches a CV and **submits with consent** (`POST /api/public/chat/conversations/:id/application`) → the enquiry is saved (`chatenquiries`) and synced in the background (`src/services/recruitmentSync.js`). Website enquiries are never sent.

**Field mapping (`hr.applicant`).**

| PIXOXIQ | Odoo |
|---|---|
| Candidate name | `partner_name` |
| Verified email | `email_from` |
| Phone | `partner_phone` |
| Vacancy | `job_id` (the vacancy's Odoo job; general enquiries: configured default job or none, no jobs are created) |
| LinkedIn / portfolio | `linkedin_profile` |
| Enquiry, skills, experience, qualification, location, identity type, consent time, reference | `applicant_notes` (HTML) |
| Source | `source_id` → utm.source "PIXOXIQ AI Assistant" (configurable) |
| CV | `ir.attachment` (`res_model=hr.applicant`, `res_id`), verified after upload |

**Sync and retries.** Statuses `not_submitted → pending → processing → synced | failed | requires_attention`. A worker (every 30 s, plus immediately after submit) claims due enquiries atomically with a 5-minute lease. Failures retry with exponential backoff (30 s, 1 min, 2 min … max 6 h, 8 attempts). Access/validation errors (HTTP 400/401/403/422), a deleted applicant or a missing default job go to *requires attention*. Every attempt is logged in `chatenquirysynclogs` (ids, outcome, redacted error; no credentials or documents). Admins: *Sync now / Retry* and *View sync log* in AI Assistant → Enquiries.

**Duplicate prevention.** (1) applicant id saved right after creation; (2) stable reference `PIXOXIQ-ENQ-<id>` in the notes, searched before creating (crash-safe); (3) an existing applicant with the same email and job is linked (a note is posted, their record is not overwritten); (4) one enquiry per conversation and vacancy, so follow-up messages update it and a different vacancy is a separate application.

**Configuration.** Admin panel → **Odoo Integration** (superadmin): URL, database, API user login (Odoo < 19 only), API key (AES-256-GCM encrypted with `AI_ENCRYPTION_KEY`, never returned), *Test connection* (version, API mode, required rights: `hr.applicant` create/write/read, `hr.job` read, `ir.attachment` create), recruitment on/off, default job for general enquiries, source name. Without saved credentials the existing `ODOO_URL` / `ODOO_DB` / `ODOO_API_KEY` (/ `ODOO_USERNAME`) are used. Use a dedicated Odoo user with Recruitment Officer rights only.

**Privacy.** CVs are stored privately (`StoredFile` purpose `chat-enquiry/resume`, also `application/resume`); the public file route refuses them and admins download them via `GET /api/ai/enquiries/:id/resume`. Deleting a conversation (visitor, admin or retention) deletes its enquiries, sync logs and CVs in PIXOXIQ; the Odoo applicant then follows Odoo's own retention.

## 11. Job Queries vs Normal / General Queries (admin)

* **Classification (server only).** The intent classifier also returns a `topic` (company, services, technology, website, business, contact, general, other). Each conversation gets `queryType`: `job` as soon as one question is a recruitment intent (the whole conversation, history included, moves to Job Queries and stays there), otherwise `general`. Ambiguous questions get a clarifying question and change nothing. Client-sent categories are ignored.
* **Job Queries** (`/api/ai/job-queries`, superadmin/admin/HR): the job enquiry records (logged-in or OTP-verified only) with candidate details, CV, HR status, Odoo applicant id and sync status, retry and sync log. Stats: total, new, in progress, resolved, pending Odoo sync.
* **Normal / General Queries** (`/api/ai/general-queries`, superadmin/admin): read directly from the conversation records (no copies; general questions no longer create `chatenquiries` "website" records). Identity only for logged-in users; anonymous visitors appear as a tag and only in aggregate statistics. Filters: category, date, logged-in/anonymous, open/archived, search (questions, answers, user). Archive / restore. Never sent to Odoo.
* **HR role.** Admin accounts can have role `hr` (Settings → admin users). `protect` allows HR only `/api/ai/job-queries/*`, their own profile (`/api/auth/me`) and the vacancy list; every other admin API returns 403, independent of the admin panel menu.
* **Existing data.** On startup `backfillQueryTypes()` classifies older conversations (job if they have a job enquiry or a JOB_ENQUIRY question, else general). Idempotent; nothing is deleted. Old "website" enquiry records stay in the database but are no longer used.
