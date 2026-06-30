# RevisionExt - FSM Revision Management App

A SAP Fiori mobile application for SAP Field Service Management (FSM), designed to run in FSM Mobile (Web Container), FSM Web UI (Shell Extension), or standalone browser. Manages **revision workflows** for FSM inspection smartforms - reading existing revision chains of ServiceCalls, Activities, and ChecklistInstances, and creating new revisions on demand.

> **Version:** 0.0.1
> **Platform:** SAP BTP Cloud Foundry
> **Last Updated:** June 2026

---

## Documentation

- [docs/SETUP.md](docs/SETUP.md) - fresh deployment to a new BTP subaccount
- [docs/RENAME.md](docs/RENAME.md) - renaming an existing app to comply with naming conventions
- [docs/NAMING.md](docs/NAMING.md) - naming convention reference for all tns FSM extensions
- [docs/SECURITY.md](docs/SECURITY.md) - security architecture and threat model (Phase 2 target)

---

## 📋 Table of Contents

- [Screenshots](#-screenshots)
- [Overview](#-overview)
- [Architecture](#-architecture)
- [Core Concepts](#-core-concepts)
- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Setup & Deployment](#-setup--deployment)
- [FSM Mobile Integration](#-fsm-mobile-integration)
- [FSM Web UI Integration](#-fsm-web-ui-integration)
- [Standalone / Development Mode](#-standalone--development-mode)
- [How It Works](#-how-it-works)
- [The Create Revision Flow](#-the-create-revision-flow)
- [API Reference](#-api-reference)
- [Project Structure](#-project-structure)
- [Troubleshooting](#-troubleshooting)
- [Application Details](#-application-details)
- [Current Status](#-current-status)
- [Security Notes](#-security-notes)

---

## 📸 Screenshots

| # | Screenshot | Description | Status |
|---|------------|-------------|--------|
| 1 | Main View - Session Context + Smartform Tables | Collapsed session panel and per-smartform revision tables | ⬜ TODO |
| 2 | Expanded Revision Table | One table expanded showing Original + revision rows with Open/Closed status | ⬜ TODO |
| 3 | Create Revision - Confirmation Dialog | Next revision number, SC/Activity codes (NEW/EXISTS), smartform description | ⬜ TODO |
| 4 | Create Revision - Success Dialog | Confirmation after the revision is created | ⬜ TODO |

**Screenshot folder:** `docs/screenshots/`

---

## 🎯 Overview

This application provides a mobile-optimized interface for viewing and creating **revisions** of FSM inspection smartforms. When a ServiceCall's inspection report needs to be revised, the original activity, its ServiceCall, and its smartform must be duplicated into a new revision - with the correct chain links, revision numbering, and follow-up references. RevisionExt automates the entire assembly and creation.

It integrates with FSM Mobile (Web Container) and FSM Web UI (Shell Extension), auto-detecting the activity in context and presenting its full revision history grouped per inspection smartform.

**Key Features:**
- ✅ Reads the full **revision tree** of an activity (Original → Rev-1 → Rev-2 → …)
- ✅ Groups revisions into **per-smartform tables** - one table per inspection smartform lineage
- ✅ Shows each revision's smartform **Open/Closed status** with color coding
- ✅ One-click **Create Revision** per table: assembles and submits ServiceCall + Activity + smartform
- ✅ Automatic **create-or-append** logic - one ServiceCall and one Activity per revision level, shared across smartform tables
- ✅ Per-table **revision numbering** computed live from existing rows
- ✅ Maintains the original activity's **Z_FollowUpRevisions** links automatically
- ✅ Context activity auto-resolution from FSM Mobile or Web UI Shell
- ✅ Collapsible, mobile-first responsive tables
- ✅ Direct FSM **Query API**, **Composite-Tree API**, and **Data API** integration via SAP BTP Destination Service

**Technology Stack:**
- **Frontend:** SAP UI5 (Fiori)
- **Backend:** Node.js + Express
- **Deployment:** SAP Business Technology Platform (Cloud Foundry)
- **Outbound Authentication:** OAuth 2.0 via BTP Destination Service (`FSM_S4E`)
- **Inbound Authentication:** *Deferred to Phase 2* - see [Security Notes](#-security-notes)

---

## 🏗️ Architecture

The application supports **multiple deployment contexts**:

| Context | Description | How It Works |
|---------|-------------|--------------|
| **FSM Mobile** | Web Container in FSM Mobile app | POST context to `/web-container-access-point`; context stored server-side, retrieved by frontend |
| **FSM Web UI** | Extension in FSM Web application | fsm-shell SDK communicates via iframe postMessage; activity/serviceCall resolved from ViewState |
| **Standalone** | Direct browser access (development) | URL parameters or stored session; used for UI iteration |

**Context Detection Priority:** FSM Shell (if iframe) → Mobile Web Container (stored session) → Standalone.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              ENTRY POINTS                                  │
├──────────────────┬───────────────────────┬───────────────────────────────┤
│   FSM Mobile     │     FSM Web UI         │       Standalone (dev)        │
│   (Web Container)│     (Shell Extension)  │       (browser / session)     │
│        │         │           │            │              │                │
│  POST context    │   fsm-shell SDK        │   stored session / params     │
│  to access-point │   (iframe postMessage) │                               │
└────────┼─────────┴───────────┼────────────┴──────────────┼────────────────┘
         │                     │                           │
         ▼                     ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          SAP BTP (Cloud Foundry)                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                          UI5 App (Frontend)                           │ │
│  │                                                                       │ │
│  │  ContextService.js  - Detects environment, resolves cloudId          │ │
│  │  RevisionService.js - Calls backend revision endpoints               │ │
│  │  RevisionExt.controller.js - Orchestrates load + Create Revision      │ │
│  │       ↓                                                               │ │
│  │  1. Session Context (collapsed panel)                                 │ │
│  │  2. One collapsible table per inspection smartform                    │ │
│  │  3. Per-table "Create Revision" button                                │ │
│  │  4. Confirm dialog → execute → success dialog → refresh               │ │
│  └───────────────────────────┬───────────────────────────────────────────┘ │
│                              │                                              │
│  ┌───────────────────────────▼──────────────────────────────────────────┐ │
│  │                       Express Server (Backend)                        │ │
│  │                                                                       │ │
│  │  - WebContainer entry: /web-container-access-point                    │ │
│  │  - Context store (in-memory, session-keyed)                           │ │
│  │  - Revision read API:  /api/activity-revisions, /api/service-call-tree│ │
│  │  - Revision write API: /api/create-revision                           │ │
│  │  - FSMService.js: Query API, Composite-Tree API, Data API             │ │
│  └───────────────────────────┬──────────────────────────────────────────┘ │
└──────────────────────────────┼─────────────────────────────────────────────┘
                               │ OAuth Token
                               ▼
                      ┌─────────────────┐
                      │ BTP Destination │  (FSM_S4E destination)
                      │    Service      │
                      └────────┬────────┘
                               │ Authenticated Request
                               ▼
                      ┌─────────────────┐
                      │     FSM API     │  (SAP Field Service Management)
                      │                 │
                      │  - Query API (CoreSQL)
                      │  - Composite-Tree API (ServiceCalls)
                      │  - Data API v4 (Activity, ChecklistInstance)
                      └─────────────────┘
```

---

## 🧩 Core Concepts

Understanding RevisionExt requires a few FSM-specific concepts:

| Concept | Meaning |
|---------|---------|
| **Revision tree** | The chain of activities linked by `previousActivity` back to one original activity. Resolved via the FSM Query API (`Activity.previousActivity` + `Z_Activity_Type = '-7'`). |
| **Revision number** | Stored on the revision's ServiceCall as `Z_revisionNumber` (with `Z_RevisionOfActivity` = the original activity code). The next number is computed **per table** as the count of existing revision rows + 1. |
| **Per-smartform table** | The UI renders one table per **inspection smartform** on the original activity. Each table's rows are only the revisions whose smartform chains (via `Z_PreviousChecklist`) back to that table's root smartform. |
| **`Z_PreviousChecklist`** | Links a smartform to its predecessor. Load-bearing: it determines which table a revision row belongs to, not just display order. |
| **One SC + one Activity per revision level** | All smartform tables at revision N share a single ServiceCall (`<code>-Rev-NNN`) and a single Activity (`<actcode>-Rev-NNN`). The first table to create level N creates them; later tables **append** their smartform to the existing activity. |
| **Open vs Closed smartforms** | Closed smartforms always show. Open smartforms show **only for revisions** (so freshly created revisions are visible immediately); open smartforms on the **Original** are hidden, since the inspection isn't finished. |

---

## ✨ Features

### UI Components

| Component | Description |
|-----------|-------------|
| **Session Context Panel** | Collapsed expandable panel showing User, Language, Account, Company, Object Type/ID resolved from the FSM context. |
| **Per-Smartform Tables** | One collapsible panel + table per inspection smartform on the original activity. Collapsed by default for clean scanning of many smartforms. |
| **Revision Rows** | Each row = one activity in the lineage: Revision label, Code, Activity ID, Smartform Description, Smartform Name, Attachment Name, Status. The Original row is highlighted. |
| **Status Column** | Color-coded smartform status - green "Closed" / red "Open" - per revision row. |
| **Create Revision Button** | One per table, in the panel header toolbar. Opens a confirmation dialog with the next revision number and the create-or-append decision, then executes on confirm. |
| **Confirmation Dialog** | Shows next revision number, the revision ServiceCall and Activity codes (with NEW / EXISTS status), and the smartform description, with **Create** / **Close** buttons. |
| **Success Dialog** | After execution, confirms the revision number created for the smartform, then refreshes the tables. |

### Revision Read Pipeline

The app resolves a single context activity into a full grouped revision view:

| Stage | Resolves | Source |
|-------|----------|--------|
| **Activity revision tree** | Original activity + all `-7` revision activities, joined to their ServiceCall revision numbers | Query API (`Activity.43`, `ServiceCall.27`) |
| **Inspection smartforms** | Closed (and open, for revisions) ChecklistInstances tagged "Inspection" | Query API (`ChecklistInstance.20`, `ChecklistTemplate.21`, `ChecklistTag.10`) |
| **Per-chain grouping** | Each smartform → its root table via the `Z_PreviousChecklist` chain | JavaScript chain resolution |
| **Attachments** | Attachment file name + description per populated smartform row | Query API (`Attachment.19`) |

### Revision Write Pipeline

A single "Create Revision" click runs three sequential FSM calls:

| Step | Call | Purpose |
|------|------|---------|
| 1 | **POST/PATCH** Composite-Tree ServiceCall | Create the revision SC (POST) or append the activity to an existing one (PATCH). Carries the transformed header + activity. |
| 2 | **PATCH** Activity (Data API) | Set `previousActivity` on the newly created revision activity (composite-tree create does not persist it). |
| 3 | **POST** ChecklistInstance | Create the new smartform, attached to the revision activity, chained via `Z_PreviousChecklist`. |
| 4 | **PATCH** Activity (Data API) | Update the **original** activity's `Z_FollowUpRevisions` UDF with the new revision link - only when a new revision activity was created. |

---

## ✅ Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | v18.0.0+ | Backend runtime |
| **npm** | v8.0.0+ | Package management |
| **Cloud Foundry CLI** | Latest | `cf` command for deployment |
| **UI5 CLI** | v4.0.33+ | Build tooling (dev dependency) |

### SAP BTP Account

- Cloud Foundry space with available quota
- Memory: 512MB (configurable in `manifest.yaml`)
- Disk: 512MB
- `instances: 1` (in-memory context store - see [Current Status](#-current-status))

### SAP BTP Services

| Service | Instance Name | Purpose |
|---------|---------------|---------|
| **Destination Service** | `fsm-revisionext-destination-dev` | FSM API connectivity (outbound OAuth) |

### Destination Configuration (FSM_S4E)

The destination `FSM_S4E` must be configured in BTP Cockpit with:

```
Name: FSM_S4E
Type: HTTP
URL: https://de.fsm.cloud.sap
Authentication: OAuth2ClientCredentials
Token Service URL: https://de.fsm.cloud.sap/api/oauth2/v2/token
Client ID: <your-fsm-client-id>
Client Secret: <your-fsm-client-secret>

Additional Properties:
  account: <your-account>
  company: <your-company>
  URL.headers.X-Account-ID: <your-account-id>
  URL.headers.X-Company-ID: <your-company-id>
  URL.headers.X-Client-ID: <your-client-id>
  URL.headers.X-Client-Version: <your-client-version>
```

The backend reads these via `DestinationService.js` and attaches `account`/`company`
as query params and the `X-Account-ID` / `X-Company-ID` / `X-Client-ID` /
`X-Client-Version` headers to every FSM call (see `FSMService._getRequestContext()`).

### FSM Access

- SAP Field Service Management instance
- API access credentials (OAuth client) for outbound calls
- User with permissions for:
  - ServiceCalls & Activities (read/write, composite-tree)
  - ChecklistInstances / ChecklistTemplates / ChecklistTags (read/write)
  - Attachments (read)
  - UDF metadata (read)

### Optional (FSM Web UI Integration)

- FSM Shell SDK access (loaded dynamically by the frontend)
- Extension configuration in FSM Admin

---

## 🚀 Setup & Deployment

### 1. Clone & Install

```bash
git clone <repository-url>
cd tns-fsm-revisionext-ui
npm install
```

### 2. Configure BTP Destination

Create the **FSM_S4E** destination as shown in [Prerequisites](#-prerequisites). Account
and company are **not** configured in the app - they come from the destination's
additional properties.

### 3. Create the Destination Service Instance

```bash
cf create-service destination lite fsm-revisionext-destination-dev
```

### 4. Build the UI5 Frontend

```bash
npm run build:cf
```

This runs the UI5 preload build (`ui5-deploy.yaml`) with cachebuster info, producing
the deployable `webapp` bundle the Express server serves statically.

### 5. Deploy via `cf push`

```bash
cf push
```

The `manifest.yaml` defines the app (`tns-fsm-revisionext-ui-dev`), 512MB memory,
the Node.js buildpack, `npm start` as the start command, the CF route, and binds the
`fsm-revisionext-destination-dev` service.

> **Deployment path:** This app deploys via **`cf push`** with `manifest.yaml`.
> The `mta.yaml` present in the repo is unused for the standard flow.

### 6. Get the Application URL

```bash
cf app tns-fsm-revisionext-ui-dev
```

Copy the route (e.g. `https://tns-fsm-revisionext-ui-dev-fsm-dev-op.cfapps.eu10-004.hana.ondemand.com`).
This is the URL you configure in FSM Admin as the Web Container / Extension URL.

### Local Development

```bash
npm start          # Express server (backend + static frontend) on port 3000
npm run start-ui5  # Fiori dev server (frontend only, no backend API)
```

> Local outbound FSM calls require the BTP Destination Service binding (or running in
> SAP Business Application Studio with the bound service). The Fiori dev server
> (`start-ui5`) serves only the UI - backend `/api/*` endpoints are not available.

---

## 📱 FSM Mobile Integration

### Configure FSM Web Container

Navigate to: **FSM Admin → Company → Web Containers**

#### 1. Create Web Container

| Field | Value |
|-------|-------|
| **Name** | `Revisions` |
| **External ID** | `Z_RevisionExt` |
| **URL** | `https://tns-fsm-revisionext-ui-dev-xxx.cfapps.eu10-004.hana.ondemand.com` |
| **Object Types** | `Activity` |
| **Active** | ✓ Checked |

#### 2. Web Container Context

When opened from FSM Mobile, the web container POSTs context to
`/web-container-access-point`. The server stores it keyed by `userName-cloudId` and
the frontend retrieves it via `/web-container-context`.

| Field | Description |
|-------|-------------|
| `cloudId` | Activity ID (used to resolve and load the revision tree) |
| `objectType` | Object type (`ACTIVITY` or `SERVICECALL`) |
| `userName` | Current user's name |
| `cloudAccount` | FSM account name |
| `companyName` | FSM company name |
| `language` | User's language preference |

> **Note:** Inbound authentication (validating the POST) is **not yet implemented** -
> see [Security Notes](#-security-notes). This is Phase 2 work.

#### 3. Add to Mobile Screen Configuration

Navigate to: **FSM Admin → Companies → [Your Company] → Screen Configurations**

1. Select `Activity Mobile` (or your custom activity screen)
2. Click the pencil icon to edit
3. Add a Web Container button to the activity screen
4. Configure: **Label** `Revisions`, **Web Container** `Z_RevisionExt`
5. **Save**

---

## 🖥️ FSM Web UI Integration

The app can also run as an extension in FSM Web UI using the fsm-shell SDK.

### Configure FSM Extension

Navigate to: **FSM Admin → Company → Extensions**

| Field | Value |
|-------|-------|
| **Name** | `Revisions` |
| **External ID** | `Z_RevisionExt_Web` |
| **URL** | `https://tns-fsm-revisionext-ui-dev-xxx.cfapps.eu10-004.hana.ondemand.com` |
| **Context** | `Activity` |
| **Active** | ✓ Checked |

### Shell Context

When running in FSM Web UI, the app uses the fsm-shell SDK to receive context via
iframe postMessage. `ContextService.js` listens for both the session context and
**ViewState** events, preferring `selectedActivityId` (the currently open activity)
over a stale `activityID`. Once an activity (or serviceCall) id is resolved, the app
loads the revision tree for it.

---

## 🧪 Standalone / Development Mode

For local UI iteration, the app can run without an FSM session. `ContextService.js`
falls back to a stored session or defaults when no Mobile/Shell context is present.

```
https://tns-fsm-revisionext-ui-dev-xxx.cfapps.eu10-004.hana.ondemand.com
```

> Standalone mode is primarily for pure-frontend UI work (CSS, layout, view
> structure). Full revision read/write requires a real FSM context and the bound
> destination. For end-to-end testing, launch from FSM Mobile or FSM Web UI.

---

## 🔄 How It Works

### Load Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Context received (Mobile POST / Shell ViewState)               │
│  ContextService.getContext() → { cloudId, objectType, ... }     │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  RevisionService.getActivityRevisions(cloudId)                  │
│  → GET /api/activity-revisions?objectId=<cloudId>               │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend: getActivityTreeWithSmartforms()                       │
│  1. Resolve original activity + revision tree (Query API)       │
│  2. Fetch Inspection smartforms for every activity              │
│  3. Group smartforms per root via Z_PreviousChecklist chains    │
│  4. Build one table per root; rows = covered activities only    │
│  5. Fetch attachments for populated rows                        │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Frontend renders: collapsed panel per smartform table,         │
│  Original row highlighted, Status column color-coded,           │
│  per-table "Create Revision" button                             │
└─────────────────────────────────────────────────────────────────┘
```

### Detailed Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | User opens an Activity in FSM and taps **Revisions** | App opens (web container / iframe) |
| 2 | Context received | `ContextService` resolves the Activity `cloudId` |
| 3 | Revision tree loaded | `/api/activity-revisions` returns activities + per-smartform tables |
| 4 | Tables rendered | One collapsible panel per inspection smartform |
| 5 | Original row highlighted | Blue highlight, always first |
| 6 | Status shown | Each revision row shows Open/Closed (color-coded) |
| 7 | User clicks **Create Revision** on a table | Confirmation dialog with next number + create/append decision |
| 8 | User confirms | Three FSM calls execute; tables refresh; success dialog shown |

### Outbound (app → FSM API)

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Read VCAP_SERVICES → Destination Service credentials        │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Fetch FSM_S4E destination → FSM URL + OAuth config          │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Get FSM OAuth token (cached, 5 min pre-expiry buffer)       │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Make FSM API calls: Query API, Composite-Tree API, Data API │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ The Create Revision Flow

This is the heart of the app. A single **Create Revision** click on a table runs a
confirm → execute → refresh sequence.

### 1. Build & Preview

The frontend calls `GET /api/service-call-tree` with the pressed table's context
(`rootSmartformId`, `lastSmartformId`, `rootPruefberichtNr`, `nextRevisionNumber`).
The backend (`buildNewRevisionPayload`) assembles three payloads and returns them
along with the create-or-append decision, which drives the confirmation dialog:

```
Next revision number: 3
Revision ServiceCall: 8200002124-Rev-003 (NEW — will be created)
Revision Activity: 19846-Rev-003 (NEW — will be created)
Smartform description: Revision - 3: Genehmigt - Testing
```

### 2. Payload Assembly

| Payload | Key transformations |
|---------|---------------------|
| **ServiceCall header** | `id` = existing SC id (append) or absent (create); `code` = `<origCode>-Rev-NNN`; `subject` = `<actCode> Rev-N`; `type` = `-8`; `externalId` removed; upsert `Z_RevisionOfActivity` + `Z_revisionNumber`. |
| **Activity segment** | `id` = existing activity id or absent; `code` = `<actCode>-Rev-NNN`; `previousActivity` = original id; subject rewritten (keeps bracketed suffix); upsert `Z_UpdateAttributes`, `Z_Act_RevisionOfActivity` (deep link), `Z_Activity_Type='-7'`; remove `Z_FollowUpRevisions`, `Z_Act_S4ItemDescription`; attachments cleared. |
| **Smartform** | Copied from the table's root smartform; `description` prefixed `Revision - N: `; `closed: false`; `Z_PreviousChecklist` = last smartform in the table (or root); `Z_PruefberichtNr` = original root's value; fresh UUID v4 `checklistId`; `object.objectId` = the revision activity. |
| **Follow-up** | `Z_FollowUpRevisions` update for the **original** activity - appends the new revision line. Only built when a new revision activity is created. |

Before sending, the ServiceCall payload is sanitized: **identifier references**
(`businessPartner`, `responsibles`, `serviceProduct`, …) are reduced to exactly one
of `id`/`externalId`/`code` (FSM requires exactly one), and all `null` key/value
pairs are stripped (FSM rejects explicit nulls on create). UDF metas are left intact.

### 3. Create-or-Append Decision

The next revision number is computed **per table** (count of existing revision rows
+ 1). The backend then checks whether that revision's ServiceCall and Activity
already exist:

- `SELECT w.id FROM ServiceCall w WHERE w.code = '<code>-Rev-NNN'`
- `SELECT w.id FROM Activity w WHERE w.code = '<actCode>-Rev-NNN'`

If they exist, the new smartform is **appended** to the existing activity (one SC +
one Activity per revision level, shared across smartform tables). If not, they are
**created**.

### 4. Execution (on Confirm)

`POST /api/create-revision` runs `createRevision()`, which executes sequentially:

1. **ServiceCall write** - `POST` to the composite-tree collection (create) or
   `PATCH` to the SC id (append), with `X-Create-Or-Update: true`.
2. **Find created activity** - match by the assembled activity `code` in the
   response, take its real UUID.
3. **Set `previousActivity`** - direct `PATCH /api/data/v4/Activity/<newId>`
   (composite-tree create does not persist `previousActivity`).
4. **Create smartform** - `POST /api/data/v4/ChecklistInstance` with
   `object.objectId` = the real activity UUID.
5. **Follow-up** - `PATCH` the original activity's `Z_FollowUpRevisions` with the
   real UUID substituted into the link (only when a new activity was created).

The tables then refresh and a success dialog confirms:

```
Revision number 3 made for smartform 'Revision - 3: Genehmigt - Testing'.
```

> **Smartform visibility:** New smartforms are created `closed: false`. Open
> revision smartforms **do** appear (with red "Open" status), so a freshly created
> revision is visible immediately. They become "Closed" once approved in FSM.

---

## 🔌 API Reference

### Backend Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/web-container-access-point` | Receive + store context from FSM Mobile (keyed by `userName-cloudId`). |
| POST | `/` | Alternative web container entry point (same handler). |
| GET | `/web-container-context?session=<key>` | Frontend retrieves its stored context. |
| GET | `/api/checklist-instances?objectId=<id>` | Inspection smartforms for an activity (list shape). |
| GET | `/api/activity-revisions?objectId=<id>` | Full revision tree + per-smartform tables for an activity. |
| GET | `/api/service-call-tree?serviceCallId=&keepActivityId=&originalCode=&rootSmartformId=&lastSmartformId=&rootPruefberichtNr=&nextRevisionNumber=` | Build + preview the next-revision payloads (no writes). |
| POST | `/api/create-revision` | Execute the create flow (SC write → activity link → smartform → follow-up). Body: `{ serviceCallId, keepActivityId, originalCode, smartform }`. |

> **API auth:** Inbound authentication is **not yet implemented**. All endpoints are
> currently open. Adding `requireSession`-style middleware is Phase 2 work - see
> [Security Notes](#-security-notes).

### FSM APIs Used (Outbound)

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Query API v1** | `/api/query/v1` | CoreSQL queries: Activity, ServiceCall, ChecklistInstance, ChecklistTemplate, ChecklistTag, Attachment. |
| **Composite-Tree API** | `/api/fsm-connector/v1/composite-tree/service-calls[/<id>]` | Read original SC; create (POST) / append (PATCH) revision SC. |
| **Data API v4** | `/api/data/v4/Activity/<id>` | PATCH activity (`previousActivity`, `Z_FollowUpRevisions`). |
| **Data API v4** | `/api/data/v4/ChecklistInstance` | POST new revision smartform. |
| **OAuth Token Endpoint** | `/api/oauth2/v2/token` | OAuth2 client-credentials flow (via BTP Destination Service). |

### FSM DTOs

| DTO | Version | Used for |
|-----|---------|----------|
| `Activity` | `.43` | Revision tree, activity core fields, existence check |
| `ServiceCall` | `.27` | Revision number map, existence check |
| `ChecklistInstance` | `.20` | Smartforms (read + create) |
| `ChecklistTemplate` | `.21` | Template names + tags |
| `ChecklistTag` | `.10` | "Inspection" tag resolution |
| `Attachment` | `.19` | Attachment file name + description |

---

## 📁 Project Structure

```
tns-fsm-revisionext-ui/
│
├── # ─────────── ROOT LEVEL ───────────
├── index.js                         # Express server, context store, /api routes
├── package.json                     # Node.js deps (express, axios)
├── manifest.yaml                    # Cloud Foundry deployment (cf push)
├── mta.yaml                         # MTA descriptor (unused in cf push flow)
├── xs-app.json                      # App Router configuration
├── xs-security.json                 # Security configuration (Phase 2)
├── ui5.yaml / ui5-local.yaml / ui5-deploy.yaml   # UI5 tooling configs
├── README.md                        # This file
│
├── # ─────────── DOCUMENTATION ───────────
├── docs/
│   ├── SETUP.md                     # Fresh deployment guide
│   ├── RENAME.md                    # App renaming guide
│   ├── NAMING.md                    # Naming convention reference
│   ├── SECURITY.md                  # Security architecture (Phase 2 target)
│   └── screenshots/                 # App screenshots for documentation
│
├── # ─────────── BACKEND SERVICES ───────────
├── utils/
│   ├── FSMService.js                # FSM core: Query/Composite-Tree/Data API,
│   │                                #   revision tree, payload assembly, create flow
│   ├── DestinationService.js        # BTP Destination handling
│   └── TokenCache.js                # OAuth token caching (5 min pre-expiry buffer)
│
└── # ─────────── FRONTEND (SAP UI5) ───────────
webapp/
│
├── index.html                       # App entry point
├── manifest.json                    # UI5 app descriptor (id: com.tns.fsm.revisionext.app)
├── Component.js                     # UI5 Component
├── appconfig.json                   # App configuration
│
├── view/
│   ├── App.view.xml                 # Root view
│   └── RevisionExt.view.xml         # Main view: per-smartform tables (collapsible)
│
├── controller/
│   ├── App.controller.js            # Root controller
│   └── RevisionExt.controller.js    # Main controller: load + Create Revision flow
│
├── utils/
│   ├── ContextService.js            # Context detection (Mobile / Shell / standalone)
│   └── RevisionService.js           # Backend API client (revisions, service-call-tree, create)
│
├── model/
│   └── models.js                    # Device model
│
├── css/
│   └── style.css                    # Custom styles
│
└── i18n/
    └── i18n.properties              # Translations
```

> The `/api/checklist-instances`, `/api/activity-revisions`, and
> `/api/service-call-tree` routes are read-only; `/api/create-revision` is the only
> write path. All FSM I/O lives in `utils/FSMService.js`.

---

## 🐛 Troubleshooting

### View Logs

```bash
cf logs tns-fsm-revisionext-ui-dev --recent   # recent buffered logs
cf logs tns-fsm-revisionext-ui-dev            # live tail
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Created revision doesn't appear in the table | Its smartform is still **open** on an Original-only table, OR the revision activity wasn't linked | Open revision smartforms show with red "Open" status. If a row is fully missing, verify `previousActivity` was set (the post-create Activity PATCH) and the SC carries `Z_RevisionOfActivity` + `Z_revisionNumber`. |
| `405 METHOD_NOT_ALLOWED` on SC write | Wrong HTTP method for create vs append | Create uses **POST** to the collection (no id, no `forceUpdate`); append uses **PATCH** to the SC id. |
| `Argument validation failed (field=businessPartner) ... Exactly one value out of id/code/externalId` | A reference object carried multiple identifiers | Handled by `_reduceIdentifierRefs` (id → externalId → code). If a new ref type appears, confirm it isn't excluded. |
| `Cannot invoke "Object.toString()" because "value" is null` | Explicit `null` sent on create | Handled by `_stripNulls`. Check the logged payload for any remaining nulls. |
| Revision number repeats (e.g. two Rev-2) | A second create fired before the first revision's smartform was visible, or gappy historical data | Numbering counts existing revision rows; open rows now count too. Gappy legacy data (Rev-3 with no Rev-1) can collide - the create-or-append check absorbs most cases. |
| Wrong next revision number per table | Per-table count includes only that table's rows | Expected: each smartform table numbers its own revisions. |
| No tables shown | No closed inspection smartforms on the original activity | Tables form only from **closed** inspection smartforms on the Original. |
| Context not detected | Not opened from FSM Mobile / Web UI | Ensure launched from FSM; standalone mode has no real context. |
| FSM calls fail with auth errors | Destination misconfigured | Verify `FSM_S4E` destination, OAuth credentials, and `account`/`company` additional properties. |

### Backend Error Logs

On a failed write, the backend logs the failing step, status, and FSM's response body:

```
[createRevision] SC POST FAILED status=400 url=...
[createRevision] SC write response body: {...}
[createRevision] Smartform POST FAILED status=... url=...
[createRevision] Activity PATCH FAILED status=... url=...
```

Successful writes do not log (kept quiet by design).

---

## 📝 Application Details

|                          |                                              |
|--------------------------|----------------------------------------------|
| **App Name**             | RevisionExt                                  |
| **Module Name**          | com.tns.fsm.revisionext.app                  |
| **CF App Name**          | tns-fsm-revisionext-ui-dev                   |
| **Framework**            | SAP UI5 (Fiori) + Node.js Express            |
| **UI5 Theme**            | sap_horizon                                  |
| **Deployment Platform**  | SAP Business Technology Platform (Cloud Foundry, eu10-004) |
| **Node.js Version**      | 18+                                          |
| **Destination**          | FSM_S4E (OAuth2 client credentials)          |
| **Outbound Auth**        | OAuth 2.0 via BTP Destination Service        |
| **Inbound Auth**         | Not yet implemented (Phase 2)                |
| **Supported Contexts**   | FSM Mobile, FSM Web UI, Standalone (dev)     |

---

## 🚀 Current Status

### ✅ Implemented

**Context & Integration**
- Multi-context support (FSM Mobile Web Container, FSM Web UI Shell, Standalone)
- Context resolution with `selectedActivityId` preference in Web UI
- Session Context panel (collapsed by default)

**Revision Read Pipeline**
- Activity revision tree resolution (Original + `-7` revisions, joined to SC revision numbers)
- Inspection smartform detection (template tagged "Inspection")
- Per-chain table grouping via `Z_PreviousChecklist`
- Open/Closed status per revision row (color-coded); Original shows closed-only
- Attachment resolution per populated row
- Per-table live revision numbering

**Revision Write Pipeline**
- One-click Create Revision per table (confirm → execute → refresh)
- ServiceCall header + Activity + smartform payload assembly
- Create-or-append: one SC + one Activity per revision level, shared across tables
- Identifier-reference reduction + null stripping for FSM validation
- `previousActivity` set via post-create Activity PATCH
- `Z_FollowUpRevisions` maintenance on the original activity (new activities only)
- UUID v4 generation for new smartforms; activity-UUID substitution between calls

**UI**
- Collapsible per-smartform tables (collapsed on load)
- Original-row highlighting
- Confirmation + success dialogs
- Mobile-first responsive layout

### 📋 Planned

- **Inbound authentication** (Phase 2): FSM Authentication Key (Mobile) + JWT validation (Web UI), session tokens, `requireSession` middleware on all API routes
- Persistent context/session storage (currently in-memory; requires `instances: 1`)
- Eventual-consistency handling on post-create refresh (brief retry if FSM lags)
- Collision guard for gappy legacy revision numbering
- Internationalization beyond the base `i18n.properties`

---

## 🔐 Security Notes

> **⚠️ Phase 2 - Inbound authentication is not yet implemented.**
> Security was intentionally deferred during the build-out of the revision
> read/write pipeline. The notes below describe the **current** state and the
> **target** architecture. See [docs/SECURITY.md](docs/SECURITY.md) and
> [docs/SETUP.md](docs/SETUP.md) (Steps 9-13) for the planned design.

**Current state**
- **Outbound OAuth** to FSM is secured via the BTP Destination Service (`FSM_S4E`);
  credentials live in VCAP_SERVICES (BTP-managed), tokens cached in memory only.
- **No inbound authentication** on `/web-container-access-point` or `/api/*` -
  these routes are currently open. Do not expose the app publicly without the
  Phase 2 auth layer.
- Context is stored **in memory**, keyed by `userName-cloudId`, cleared on restart.
- HTTPS enforced by Cloud Foundry.

**Target (Phase 2)**
- FSM Authentication Key validation on the Mobile WebContainer POST (constant-time)
- FSM JWT signature verification on the Web UI Shell flow (RS256, against FSM JWKS)
- Server-issued session tokens; `requireSession` middleware on all API routes
- Documented in `docs/SECURITY.md` with status banners marking deferred sections

---

## 📄 License

Internal use only - Company proprietary.

---

**Last Updated:** June 2026