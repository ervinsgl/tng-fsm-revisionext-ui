# RevisionExt - FSM Revision Management App

A SAP Fiori application for SAP Field Service Management (FSM), operated as an FSM Web UI Shell Extension (with FSM Mobile Web Container code retained). Manages **revision workflows** for FSM inspection smartforms - reading existing revision chains of ServiceCalls, Activities, and ChecklistInstances, and creating new revisions on demand.

> **Version:** 0.0.1
> **Platform:** SAP BTP Cloud Foundry
> **Last Updated:** September 2026

---

## Documentation

- [docs/SETUP.md](docs/SETUP.md) - fresh deployment to a new BTP subaccount
- [docs/RENAME.md](docs/RENAME.md) - renaming an existing app to comply with naming conventions
- [docs/NAMING.md](docs/NAMING.md) - naming convention reference for all tns FSM extensions
- [docs/SECURITY.md](docs/SECURITY.md) - security architecture and threat model (as-built; Web UI active path)
- [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md) - sandbox + mtar deployment-split playbook

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
| 1 | Main View - Smartform Tables | Per-smartform revision tables with search and expand/collapse | ⬜ TODO |
| 2 | Expanded Revision Table | One table expanded showing Original + revision rows with Open/Closed status | ⬜ TODO |
| 3 | Create Revision - Confirmation Dialog | Next revision number, SC/Activity codes (NEW/EXISTS), smartform description | ⬜ TODO |
| 4 | Create Revision - Success Dialog | Confirmation after the revision is created | ⬜ TODO |

**Screenshot folder:** `docs/screenshots/`

---

## 🎯 Overview

This application provides an interface for viewing and creating **revisions** of FSM inspection smartforms. When a ServiceCall's inspection report needs to be revised, the original activity, its ServiceCall, and its smartform must be duplicated into a new revision - with the correct chain links, revision numbering, and follow-up references. RevisionExt automates the entire assembly and creation.

It integrates with FSM Web UI (Shell Extension), auto-detecting the activity in context and presenting its full revision history grouped per inspection smartform.

**Key Features:**
- ✅ Reads the full **revision tree** of an activity (Original → Rev-1 → Rev-2 → …)
- ✅ Groups revisions into **per-smartform tables** - one table per inspection smartform lineage
- ✅ Only **approved** originals form tables - smartforms whose approval status is not `Genehmigt` are hidden
- ✅ Shows each revision's smartform **Open/Closed status** with color coding
- ✅ **Clickable Code column** - each row's code deep-links to that activity in the FSM Shell
- ✅ **Search** smartform tables by description/name, and **expand/collapse all**
- ✅ Tables sorted **newest-first** by the root smartform's last-changed
- ✅ One-click **Create Revision** per table: assembles and submits ServiceCall + Activity + smartform
- ✅ Automatic **create-or-append** logic - one ServiceCall and one Activity per revision level, shared across smartform tables
- ✅ Per-table **revision numbering** computed live from existing rows
- ✅ Maintains the original activity's **Z_FollowUpRevisions** links automatically
- ✅ Context activity auto-resolution from FSM Web UI Shell
- ✅ Collapsible, responsive tables
- ✅ Direct FSM **Query API**, **Composite-Tree API**, and **Data API** integration via SAP BTP Destination Service

**Technology Stack:**
- **Frontend:** SAP UI5 (Fiori)
- **Backend:** Node.js + Express
- **Deployment:** SAP Business Technology Platform (Cloud Foundry)
- **Outbound Authentication:** OAuth 2.0 via BTP Destination Service (`FSM_OAUTH_CONNECT`)
- **Inbound Authentication:** FSM JWT verification + session token (Web UI path) - see [Security Notes](#-security-notes)

---

## 🏗️ Architecture

The app is operated as an **FSM Web UI Shell Extension**. Code for the FSM Mobile Web Container and a standalone/dev path is retained, but Web UI is the active context.

| Context | Description | How It Works |
|---------|-------------|--------------|
| **FSM Web UI** (active) | Extension in FSM Web application | fsm-shell SDK communicates via iframe postMessage; activity/serviceCall resolved from ViewState; FSM JWT exchanged for a session token |
| **FSM Mobile** (retained) | Web Container in FSM Mobile app | POST context to `/web-container-access-point`; context stored server-side, session cookie issued |
| **Standalone** (dev) | Direct browser access | Stored session; used for UI iteration |

**Context Detection Priority:** FSM Shell (if iframe) → Mobile Web Container (stored session) → Standalone.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              ENTRY POINTS                                  │
├──────────────────┬───────────────────────┬───────────────────────────────┤
│   FSM Web UI     │     FSM Mobile         │       Standalone (dev)        │
│   (Shell Ext.)   │     (Web Container)    │       (browser / session)     │
│        │         │           │            │              │                │
│  fsm-shell SDK   │   POST context         │   stored session              │
│  (postMessage)   │   to access-point      │                               │
│  + JWT → session │   + session cookie     │                               │
└────────┼─────────┴───────────┼────────────┴──────────────┼────────────────┘
         │                     │                           │
         ▼                     ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          SAP BTP (Cloud Foundry)                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                          UI5 App (Frontend)                           │ │
│  │                                                                       │ │
│  │  ContextService.js  - Detects environment, resolves cloudId,         │ │
│  │                       inits Web UI session (JWT → token)             │ │
│  │  Component.js       - Global fetch wrapper attaches Bearer token     │ │
│  │  RevisionService.js - Calls backend /api/v1/* revision endpoints     │ │
│  │  RevisionExt.controller.js - Orchestrates load + Create Revision      │ │
│  │       ↓                                                               │ │
│  │  1. Per-smartform tables (search + expand/collapse all)              │ │
│  │  2. One collapsible table per inspection smartform                    │ │
│  │  3. Per-table "Create Revision" button                                │ │
│  │  4. Confirm dialog → execute → success dialog → refresh               │ │
│  └───────────────────────────┬───────────────────────────────────────────┘ │
│                              │                                              │
│  ┌───────────────────────────▼──────────────────────────────────────────┐ │
│  │                       Express Server (Backend)                        │ │
│  │                                                                       │ │
│  │  - Web UI session init: /api/v1/shell-session-init (verifies FSM JWT) │ │
│  │  - requireSession middleware guards all /api/v1/* routes              │ │
│  │  - WebContainer entry (retained): /web-container-access-point         │ │
│  │  - Revision read API:  /api/v1/activity-revisions,                    │ │
│  │                        /api/v1/service-call-tree                      │ │
│  │  - Revision write API: /api/v1/create-revision                        │ │
│  │  - utils/: FsmHttpClient, RevisionReadService, RevisionWriteService,  │ │
│  │            fsmPayloadUtils, fsmConstants, FSMJwtValidator             │ │
│  └───────────────────────────┬──────────────────────────────────────────┘ │
└──────────────────────────────┼─────────────────────────────────────────────┘
                               │ OAuth Token
                               ▼
                      ┌─────────────────┐
                      │ BTP Destination │  (FSM_OAUTH_CONNECT destination)
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
| **One SC + one Activity per revision level (per original activity)** | For a given original activity, all smartform tables at revision N share a single ServiceCall (`<origCode>-<actCode>-Rev-NNN`) and a single Activity (`<actCode>-Rev-NNN`). The first table to create level N creates them; later tables **append** their smartform to the existing activity. The SC code embeds the **original activity code** so that two revisioned activities under the **same** parent ServiceCall get distinct SC codes and never collide (see [Revision ServiceCall code](#revision-servicecall-code)). |
| **Revision state** | A revision is always created as plannable work: ServiceCall `status = '-2'` ("Bereit zur Planung"), activity `status = 'DRAFT'` + `executionStage = 'DISPATCHING'`, unassigned (`responsibles` stripped). Never inherited from the original, which is usually already closed. Set on **create only**; appends leave the revision's own state alone. |
| **Approval gate (`Genehmigt`)** | An original smartform forms a table **only** when its approval status is `Genehmigt` (approved). Status comes from the `Linker_Object` UDO (`z_Linker_ApprovalActivity_Status`); anything else (e.g. `Offen`) is hidden, since revisions are only relevant once the original is approved. |
| **Open vs Closed smartforms** | Closed smartforms always show. Open smartforms show **only for revisions** (so freshly created revisions are visible immediately); open smartforms on the **Original** are hidden, since the inspection isn't finished. |

---

## ✨ Features

### UI Components

| Component | Description |
|-----------|-------------|
| **Search & Expand/Collapse** | A search field filters smartform tables by description/name (client-side, live); an Expand/Collapse All toggle opens or closes every table at once. |
| **Per-Smartform Tables** | One collapsible panel + table per inspection smartform on the original activity. Collapsed by default for clean scanning of many smartforms. Sorted newest-first by the root smartform's last-changed. |
| **Revision Rows** | Each row = one activity in the lineage: Revision label, Code, Smartform Description, Smartform Name, Attachment Name, Status. The Original row is highlighted. The **Code** is a hyperlink that opens that activity in the FSM Shell (new tab). |
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
| **Approval gate** | Each candidate original root smartform is kept only if its approval status is `Genehmigt` | Query API (`UdoValue.10` JOIN `UdoMeta.10`, `Linker_Object`) |
| **Per-chain grouping** | Each smartform → its root table via the `Z_PreviousChecklist` chain | JavaScript chain resolution |
| **Attachments** | Attachment file name + description per populated smartform row | Query API (`Attachment.19`) |
| **Activity deep-links** | Full FSM Shell URL per row (Code column hyperlink) | BTP Destination (`FSM_OAUTH_CONNECT`: base URL + company id) |

*Backend module: `utils/RevisionReadService.js` (HTTP via `utils/FsmHttpClient.js`).*

### Revision Write Pipeline

A single "Create Revision" click runs sequential FSM calls:

| Step | Call | Purpose |
|------|------|---------|
| 1 | **POST/PATCH** Composite-Tree ServiceCall | Create the revision SC (POST) or append the activity to an existing one (PATCH). Carries the transformed header + activity. |
| 2 | **PATCH** Activity (Data API) | Set `previousActivity` + `Z_Activity_Type` on the newly created revision activity (composite-tree create does not persist these). Skipped when appending to an existing activity. |
| 3 | **POST** ChecklistInstance | Create the new smartform, attached to the revision activity, chained via `Z_PreviousChecklist`. |
| 4 | **PATCH** Activity (Data API) | Update the **original** activity's `Z_FollowUpRevisions` UDF with the new revision link - only when a new revision activity was created. |

*Backend module: `utils/RevisionWriteService.js` (payload transforms in `utils/fsmPayloadUtils.js`).*

---

## ✅ Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | v18.0.0+ | Backend runtime |
| **npm** | v8.0.0+ | Package management |
| **Cloud Foundry CLI** | Latest | `cf` command for deployment |
| **UI5 CLI** | v4.0.33+ | Build tooling (dev dependency) |
| **MBT** (Cloud MTA Build Tool) | v1.2+ | Builds the `.mtar` for DevOps transport |

### SAP BTP Account

- Cloud Foundry space with available quota
- Memory: 512MB (configurable in `manifest.yaml` / `mta.yaml`)
- Disk: 512MB
- `instances: 1` (in-memory session/context store - see [Current Status](#-current-status))

### SAP BTP Services

| Service | Instance Name | Purpose |
|---------|---------------|---------|
| **Destination Service** | `fsm-revisionext-destination` | FSM API connectivity (outbound OAuth) |

> The destination service instance is **unsuffixed** (`fsm-revisionext-destination`)
> and reused in every subaccount/environment - see
> [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md).

### Destination Configuration (FSM_OAUTH_CONNECT)

The destination config `FSM_OAUTH_CONNECT` must be configured in BTP Cockpit with:

```
Name: FSM_OAUTH_CONNECT
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

> The destination **config** name (`FSM_OAUTH_CONNECT`, what the app reads via
> `DESTINATION_NAME` in `utils/fsmConstants.js`) is separate from the destination
> **service instance** name (`fsm-revisionext-destination`, what the manifest binds to).

The backend reads these via `utils/DestinationService.js` and `utils/FsmHttpClient.js`,
attaching `account`/`company` as query params and the `X-Account-ID` / `X-Company-ID` /
`X-Client-ID` / `X-Client-Version` headers to every FSM call.

### FSM Access

- SAP Field Service Management instance
- API access credentials (OAuth client) for outbound calls
- User with permissions for:
  - ServiceCalls & Activities (read/write, composite-tree)
  - ChecklistInstances / ChecklistTemplates / ChecklistTags (read/write)
  - Attachments (read)
  - UDF metadata (read)

### FSM Web UI Integration

- FSM Shell SDK access (loaded dynamically by the frontend)
- Extension configuration in FSM Admin (Shell extension URL)
- FSM JWKS endpoint reachable for inbound JWT verification (default DE region;
  overridable via `FSM_JWKS_URL`)

---

## 🚀 Setup & Deployment

This app uses the **sandbox + mtar deployment split**: a local sandbox via
`cf push` (`manifest.yaml`), and DevOps DEV/QA/PROD via `mta.yaml` (mtar transport).
See [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md) for the full model.

### 1. Clone & Install

```bash
git clone <repository-url>
cd tns-fsm-revisionext-ui
npm install
```

### 2. Configure BTP Destination

Create the **FSM_OAUTH_CONNECT** destination config as shown in
[Prerequisites](#-prerequisites). Account and company are **not** configured in the
app - they come from the destination's additional properties.

### 3. Create the Destination Service Instance

```bash
cf create-service destination lite fsm-revisionext-destination
```

This must exist **before** any deploy - the manifest/mta binds it as an existing
service. Missing instance = bind/staging failure (the most common deploy error).

### 4. Build the UI5 Frontend

```bash
npm run build:cf
```

This runs the UI5 preload build (`ui5-deploy.yaml`) with cachebuster info, producing
the deployable `webapp` bundle the Express server serves statically.

### 5a. Deploy — Local Sandbox (`cf push`)

```bash
cf push        # uses the local-only manifest.yaml (-sandbox name/route)
```

The sandbox `manifest.yaml` defines `tns-fsm-revisionext-ui-sandbox`, 512MB memory,
the Node.js buildpack, `npm start`, the pinned `-sandbox` route, and binds
`fsm-revisionext-destination`.

> The `-sandbox` `manifest.yaml` / `mta.yaml` are **local only — never committed.**
> The DevOps repo carries the unsuffixed variants (app `tns-fsm-revisionext-ui`,
> `default-route: true`).

### 5b. Deploy — DevOps (mtar transport)

```bash
npm run build:mta      # produces mta_archives/*.mtar
cf deploy mta_archives/<archive>.mtar
```

DEV deploys from the committed `mta.yaml`; QA/PROD are promoted via cTMS / Cloud ALM,
not a direct `cf deploy`. See the change-workflow doc.

### 6. Set the JWKS URL (inbound auth)

```bash
cf set-env tns-fsm-revisionext-ui-sandbox FSM_JWKS_URL \
  'https://de.fsm.cloud.sap/api/oauth2/v2/.well-known/jwks.json'
cf restage tns-fsm-revisionext-ui-sandbox
```

Optional (a DE-region default exists in code), but set explicitly per environment.
Required for the Web UI JWT verification to succeed.

### 7. Get the Application URL

```bash
cf app tns-fsm-revisionext-ui-sandbox
```

Copy the route. This is the URL you register in FSM Admin as the **Web UI Shell
extension** URL.

### Local Development

```bash
npm start          # Express server (backend + static frontend) on port 3000
npm run start-ui5  # Fiori dev server (frontend only, no backend API)
```

> Local outbound FSM calls require the BTP Destination Service binding (or running in
> SAP Business Application Studio with the bound service). The Fiori dev server
> (`start-ui5`) serves only the UI - backend `/api/v1/*` endpoints are not available.

---

## 🖥️ FSM Web UI Integration (primary)

This app is operated as an extension in **FSM Web UI** using the fsm-shell SDK. This is the active, configured integration path.

### Configure FSM Extension

Navigate to: **FSM Admin → Company → Extensions**

| Field | Value |
|-------|-------|
| **Name** | `Revisions` |
| **External ID** | `Z_RevisionExt_Web` |
| **URL** | `https://tns-fsm-revisionext-ui-sandbox-xxx.cfapps.eu10-004.hana.ondemand.com` |
| **Context** | `Activity` |
| **Active** | ✓ Checked |

> Use the sandbox route for the sandbox app, or the DevOps app's route
> (`tns-fsm-revisionext-ui`) for DEV/QA/PROD. One URL field per registration -
> the cutover moment is when you change it.

### Shell Context

When running in FSM Web UI, the app uses the fsm-shell SDK to receive context via
iframe postMessage. `ContextService.js` listens for both the session context and
**ViewState** events, preferring `selectedActivityId` (the currently open activity)
over a stale `activityID`. Once an activity (or serviceCall) id is resolved, the app
loads the revision tree for it.

### Inbound Authentication (Web UI)

The Shell context includes an FSM-issued JWT (`access_token`). On load,
`ContextService.js` exchanges it for an app session token via
`POST /api/v1/shell-session-init`, which verifies the JWT against FSM's JWKS
(`utils/FSMJwtValidator.js`). The returned token is attached as
`Authorization: Bearer <token>` on every `/api/v1/*` request, validated by the
`requireSession` middleware. See [Security Notes](#-security-notes).

---

## 📱 FSM Mobile Integration (retained, not active)

> **Status:** The FSM Mobile Web Container code path is retained but is **not** the
> operated context, and its inbound Tier-1 Authentication-Key check is **not
> implemented**. Treat this section as reference for a future Mobile rollout - see
> [Security Notes](#-security-notes) and `docs/SECURITY.md` before enabling it.

### Configure FSM Web Container

Navigate to: **FSM Admin → Company → Web Containers**

#### 1. Create Web Container

| Field | Value |
|-------|-------|
| **Name** | `Revisions` |
| **External ID** | `Z_RevisionExt` |
| **URL** | `https://tns-fsm-revisionext-ui-sandbox-xxx.cfapps.eu10-004.hana.ondemand.com` |
| **Object Types** | `Activity` |
| **Active** | ✓ Checked |

#### 2. Web Container Context

When opened from FSM Mobile, the web container POSTs context to
`/web-container-access-point`. The server stores it keyed by `userName-cloudId`,
issues a session cookie, and the frontend retrieves context via
`/web-container-context`.

| Field | Description |
|-------|-------------|
| `cloudId` | Activity ID (used to resolve and load the revision tree) |
| `objectType` | Object type (`ACTIVITY` or `SERVICECALL`) |
| `userName` | Current user's name |
| `cloudAccount` | FSM account name |
| `companyName` | FSM company name |
| `language` | User's language preference |

> **Note:** The Mobile entry POST issues a session cookie but does **not** yet
> validate an Authentication Key (Tier 1). This must be implemented before any
> Mobile rollout - see [Security Notes](#-security-notes).

#### 3. Add to Mobile Screen Configuration

Navigate to: **FSM Admin → Companies → [Your Company] → Screen Configurations**

1. Select `Activity Mobile` (or your custom activity screen)
2. Click the pencil icon to edit
3. Add a Web Container button to the activity screen
4. Configure: **Label** `Revisions`, **Web Container** `Z_RevisionExt`
5. **Save**

---

## 🧪 Standalone / Development Mode

For local UI iteration, the app can run without an FSM session. `ContextService.js`
falls back to a stored session or defaults when no Mobile/Shell context is present.

```
https://tns-fsm-revisionext-ui-sandbox-xxx.cfapps.eu10-004.hana.ondemand.com
```

> Standalone mode is for pure-frontend UI work (CSS, layout, view structure) only.
> With inbound auth in place, `/api/v1/*` calls require a valid session token, so
> standalone has no FSM data - revision read/write returns 401 without a real Web UI
> (or Mobile) session. For end-to-end testing, launch from FSM Web UI.

---

## 🔄 How It Works

### Load Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Context received (Shell ViewState / Mobile POST)               │
│  ContextService.getContext() → { cloudId, objectType, ... }     │
│  (Web UI: also exchanges FSM JWT for a session token here)      │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  RevisionService.getActivityRevisions(cloudId)                  │
│  → GET /api/v1/activity-revisions?objectId=<cloudId>            │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend: RevisionReadService.getActivityTreeWithSmartforms()   │
│  1. Resolve original activity + revision tree (Query API)       │
│  2. Fetch Inspection smartforms for every activity              │
│  3. Group smartforms per root via Z_PreviousChecklist chains    │
│  4. Build one table per root; rows = covered activities only    │
│  5. Fetch attachments for populated rows                        │
│  6. Sort tables newest-first by root smartform lastChanged      │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Frontend renders: collapsed panel per smartform table,         │
│  Original row highlighted, Status column color-coded,           │
│  search + expand/collapse all, per-table "Create Revision"      │
└─────────────────────────────────────────────────────────────────┘
```

### Detailed Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | User opens an Activity in FSM Web UI and launches **Revisions** | App opens in the Shell iframe |
| 2 | Context received | `ContextService` resolves the Activity `cloudId` and establishes a session token (Web UI: JWT → token) |
| 3 | Revision tree loaded | `/api/v1/activity-revisions` returns activities + per-smartform tables |
| 4 | Tables rendered | One collapsible panel per inspection smartform, newest-first |
| 5 | Original row highlighted | Blue highlight, always first |
| 6 | Status shown | Each revision row shows Open/Closed (color-coded) |
| 7 | User clicks **Create Revision** on a table | Confirmation dialog with next number + create/append decision |
| 8 | User confirms | The FSM call sequence executes; tables refresh; success dialog shown |

### Outbound (app → FSM API)

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Read VCAP_SERVICES → Destination Service credentials        │
└──────────────────────────┬──────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Fetch FSM_OAUTH_CONNECT destination → FSM URL + OAuth config│
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

*Outbound is handled by `utils/FsmHttpClient.js` (destination + token via
`utils/DestinationService.js` and `utils/TokenCache.js`).*

---

## 🛠️ The Create Revision Flow

This is the heart of the app. A single **Create Revision** click on a table runs a
confirm → execute → refresh sequence.

### 1. Build & Preview

The frontend calls `GET /api/v1/service-call-tree` with the pressed table's context
(`rootSmartformId`, `lastSmartformId`, `rootPruefberichtNr`, `nextRevisionNumber`).
The backend (`RevisionWriteService.buildNewRevisionPayload`) assembles the payloads
and returns them along with the create-or-append decision, which drives the
confirmation dialog:

```
Next revision number: 3
Revision ServiceCall: 8200002124-19846-Rev-003 (NEW — will be created)
Revision Activity: 19846-Rev-003 (NEW — will be created)
Smartform description: Revision - 3: Genehmigt - Testing
```

### 2. Payload Assembly

| Payload | Key transformations |
|---------|---------------------|
| **ServiceCall header** | `id` = existing SC id (append) or absent (create); `code` = `<origCode>-<actCode>-Rev-NNN`; `subject` = the assembled code; `type` = `-8`; **`status` = `-2` ("Bereit zur Planung") on create, removed entirely on append**; `externalId` removed; upsert `Z_RevisionOfActivity` + `Z_revisionNumber`. |
| **Activity segment** | `id` = existing activity id or absent; `code` = `<actCode>-Rev-NNN`; `previousActivity` = original id; subject rewritten (keeps bracketed suffix); **`status` = `DRAFT` + `executionStage` = `DISPATCHING` on create, both removed entirely on append**; upsert `Z_UpdateAttributes`, `Z_Act_RevisionOfActivity` (deep link), `Z_Activity_Type='-7'`; remove `Z_FollowUpRevisions`, `Z_Act_S4ItemDescription`; attachments cleared. |
| **Smartform** | Copied from the table's root smartform; `description` prefixed `Revision - N: `; `closed: false`; `Z_PreviousChecklist` = last smartform in the table (or root); `Z_PruefberichtNr` = original root's value; fresh UUID v4 `checklistId`; `object.objectId` = the revision activity. |
| **Follow-up** | `Z_FollowUpRevisions` update for the **original** activity - appends the new revision line. Only built when a new revision activity is created. |

**Status and execution stage are never inherited.** The composite tree is fetched from
the **original** ServiceCall on every run - including on append, where the whole
transformed tree is PATCHed onto the existing revision SC. An original is routinely
already closed (`-1`) by the time a revision is raised, and FSM keeps the activities of
a closed SC out of the planning list, so a copied status silently makes the revision
undispatchable and uneditable. On **create** the app writes `status = -2` on the SC and
`DRAFT` / `DISPATCHING` on the activity. On **append** all three fields are deleted from
the payload, so FSM keeps what the revision already has and a planner's scheduling
survives a second smartform being attached. The values live in `SC_STATUS` /
`ACTIVITY_STATE` in `utils/fsmConstants.js`.

Before sending, the ServiceCall payload is sanitized: **identifier references**
(`businessPartner`, `responsibles`, `serviceProduct`, …) are reduced to exactly one
of `id`/`externalId`/`code` (FSM requires exactly one), and all `null` key/value
pairs are stripped (FSM rejects explicit nulls on create). UDF metas are left intact.
These transforms live in `utils/fsmPayloadUtils.js`.

### 3. Create-or-Append Decision

The next revision number is computed **per table** (count of existing revision rows
+ 1). The backend then checks whether that revision's ServiceCall and Activity
already exist - matched by **UDF**, not by code:

- ServiceCall: `WHERE w.udf.Z_RevisionOfActivity = '<origCode>' AND w.udf.Z_revisionNumber = '<N>'`
- Activity: matched via its ServiceCall (`previousActivity = '<origActId>'` AND
  `Z_Activity_Type = '-7'` AND `object.objectId = '<revScId>'`)

> **Why UDF, not code:** FSM auto-suffixes duplicate ServiceCall codes (e.g.
> `8200002124-Rev-004-7`), so a bare-code match would never find the SC the app
> just created and would create a new one every time. The revision UDFs are stable
> regardless of the stored code, making the existence check suffix-proof.

If they exist, the new smartform is **appended** to the existing activity (one SC +
one Activity per revision level, shared across smartform tables). If not, they are
**created**. The two existence flags are evaluated independently, so the mixed case
(revision SC exists, its activity does not) creates the activity with the full
`DRAFT` / `DISPATCHING` state while leaving the SC's status untouched.

#### Revision ServiceCall code

The revision ServiceCall code is `<origCode>-<actCode>-Rev-NNN` (e.g.
`8200002124-19846-Rev-003`) - the original ServiceCall code, the **original
activity code**, then the zero-padded revision number.

Embedding the activity code makes the SC code **unique per original activity**. A
single parent ServiceCall can carry several inspection activities, and each can be
revised independently. Without the activity code, two activities under the same
parent SC would both resolve to `<origCode>-Rev-NNN` and collide on FSM's SC-code
uniqueness constraint:

```
CA-202: Object [ServiceCall:...] doesn't have a unique code [8200008332-Rev-001].
```

With the activity code in the middle, `8200008332-33219-Rev-001` and
`8200008332-33223-Rev-001` are distinct, so sibling activities never collide. The
revision-number regex (`/-Rev-0*(\d+)/i`) still parses correctly, since the code
still ends in `-Rev-NNN`. The two assembly sites - `RevisionWriteService`
(`revisionCode`, drives the preview) and `fsmPayloadUtils` (`tree.code`, what's
written) - are kept in lock-step.

### 4. Execution (on Confirm)

`POST /api/v1/create-revision` runs `RevisionWriteService.createRevision()`, which
executes sequentially:

1. **ServiceCall write** - `POST` to the composite-tree collection (create) or
   `PATCH` to the SC id (append), with `X-Create-Or-Update: true`.
2. **Find created activity** - match by the assembled activity `code` in the
   response, take its real UUID.
3. **Set `previousActivity` + `Z_Activity_Type`** - direct
   `PATCH /api/data/v4/Activity/<newId>` (composite-tree create does not persist
   these). Only when a new activity was created.
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

All `/api/v1/*` routes are guarded by the `requireSession` middleware (a valid
session token is required; see [Security Notes](#-security-notes)).
`/api/v1/shell-session-init` is the unguarded bootstrap that issues the token.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/v1/shell-session-init` | open (bootstrap) | Verify the FSM Shell JWT, issue a session token (returned in the body). |
| POST | `/web-container-access-point` | open (Mobile entry) | Receive + store context from FSM Mobile (keyed by `userName-cloudId`), issue a session cookie. |
| POST | `/` | open (Mobile entry) | Alternative web container entry point (same handler). |
| GET | `/web-container-context?session=<key>` | requireSession | Frontend retrieves its stored context. |
| GET | `/api/v1/activity-revisions?objectId=<id>` | requireSession | Full revision tree + per-smartform tables for an activity. |
| GET | `/api/v1/service-call-tree?serviceCallId=&keepActivityId=&originalCode=&rootSmartformId=&lastSmartformId=&rootPruefberichtNr=&nextRevisionNumber=` | requireSession | Build + preview the next-revision payloads (no writes). |
| POST | `/api/v1/create-revision` | requireSession | Execute the create flow (SC write → activity link → smartform → follow-up). Body: `{ serviceCallId, keepActivityId, originalCode, smartform }`. |

### FSM APIs Used (Outbound)

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Query API v1** | `/api/query/v1` | CoreSQL queries: Activity, ServiceCall, ChecklistInstance, ChecklistTemplate, ChecklistTag, Attachment. |
| **Composite-Tree API** | `/api/fsm-connector/v1/composite-tree/service-calls[/<id>]` | Read original SC; create (POST) / append (PATCH) revision SC. |
| **Data API v4** | `/api/data/v4/Activity/<id>` | PATCH activity (`previousActivity`, `Z_Activity_Type`, `Z_FollowUpRevisions`). |
| **Data API v4** | `/api/data/v4/ChecklistInstance` | POST new revision smartform. |
| **OAuth Token Endpoint** | `/api/oauth2/v2/token` | OAuth2 client-credentials flow (via BTP Destination Service). |
| **JWKS Endpoint** | `/api/oauth2/v2/.well-known/jwks.json` | Public keys for inbound FSM JWT verification (`FSMJwtValidator`). |

### FSM DTOs

| DTO | Version | Used for |
|-----|---------|----------|
| `Activity` | `.43` | Revision tree, activity core fields, existence check |
| `ServiceCall` | `.27` | Revision number map, existence check |
| `ChecklistInstance` | `.20` | Smartforms (read + create) |
| `ChecklistTemplate` | `.21` | Template names + tags |
| `ChecklistTag` | `.10` | "Inspection" tag resolution |
| `Attachment` | `.19` | Attachment file name + description |
| `UdoMeta` | `.10` | Approval lookup: resolve the `Linker_Object` UDO meta |
| `UdoValue` | `.10` | Approval lookup: read `z_Linker_ApprovalActivity_Status` per smartform |

> DTO versions and UDF external IDs are centralized in `utils/fsmConstants.js`.
> The approval lookup and the `Genehmigt` value live under the `APPROVAL` export;
> the revision status/stage values under `SC_STATUS` and `ACTIVITY_STATE`.
>
> **Type codes vs status codes:** both are negative strings and they overlap. On a
> ServiceCall, `-1` as a **type** is "Inspection" (`TYPE.SERVICE_CALL_ORIGINAL`) while
> `-1` as a **status** is "Closed"; `-2` as a status is "Bereit zur Planung". The
> `ServiceCall.27` query DTO surfaces them as `typeCode`/`typeName` and
> `statusCode`/`statusName`.

---

## 📁 Project Structure

```
tns-fsm-revisionext-ui/
│
├── # ─────────── ROOT LEVEL ───────────
├── index.js                         # Express server, session store, /api/v1 routes, shell-session-init
├── package.json                     # Node.js deps (express, axios, jsonwebtoken, jwks-rsa)
├── manifest.yaml                    # Cloud Foundry deployment — SANDBOX (cf push, local only)
├── mta.yaml                         # MTA transport descriptor — SANDBOX (local only)
│                                    #   (DevOps repo carries unsuffixed manifest.yaml / mta.yaml)
├── xs-app.json                      # App Router configuration
├── xs-security.json                 # Security configuration (xsappname = App ID)
├── ui5.yaml / ui5-local.yaml / ui5-deploy.yaml   # UI5 tooling configs
├── README.md                        # This file
│
├── # ─────────── DOCUMENTATION ───────────
├── docs/
│   ├── SETUP.md                     # Fresh deployment guide
│   ├── RENAME.md                    # App renaming guide
│   ├── NAMING.md                    # Naming convention reference
│   ├── SECURITY.md                  # Security architecture (as-built; Web UI active path)
│   ├── SANDBOX_MTAR_MIGRATION.md    # Sandbox + mtar deployment-split playbook
│   ├── RevisionExt_Change_Workflow.md  # BAS → DevOps → DEV → QA → PROD change flow
│   └── screenshots/                 # App screenshots for documentation
│
├── # ─────────── BACKEND SERVICES ───────────
├── utils/
│   ├── fsmConstants.js              # Destination name, DTO versions, UDF ids, type + status codes, revision state, approval consts
│   ├── fsmPayloadUtils.js           # Stateless payload transforms (header/activity/refs/nulls)
│   ├── FsmHttpClient.js             # FSM HTTP/auth layer: Query + Composite-Tree GETs, headers
│   ├── RevisionReadService.js       # Read pipeline: revision tree + per-smartform tables (approval gate, deep-links)
│   ├── RevisionWriteService.js      # Write pipeline: payload assembly + create flow
│   ├── DestinationService.js        # BTP Destination handling
│   ├── TokenCache.js                # OAuth token caching (5 min pre-expiry buffer)
│   ├── FSMJwtValidator.js           # Inbound FSM JWT verification (RS256, JWKS) — Web UI auth
│   └── requireSession.js            # Session-token middleware guarding /api/v1/*
│
└── # ─────────── FRONTEND (SAP UI5) ───────────
webapp/
│
├── index.html                       # App entry point
├── manifest.json                    # UI5 app descriptor (id: com.tns.fsm.revisionext.app)
├── Component.js                     # UI5 Component (installs Bearer-token fetch wrapper)
├── appconfig.json                   # FSM extension descriptor (sandbox name carries "(Sandbox)")
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
│   ├── ContextService.js            # Context detection (Shell / Mobile / standalone) + Web UI session init
│   └── RevisionService.js           # Backend API client (/api/v1: revisions, service-call-tree, create)
│
├── model/
│   └── models.js                    # Device model
│
├── css/
│   └── style.css                    # Custom styles
│
└── i18n/
    ├── i18n.properties              # Translations (English)
    └── i18n_de.properties           # Translations (German)
```

> **FSM I/O is split across `utils/`:** `FsmHttpClient` owns transport; `RevisionReadService`
> and `RevisionWriteService` own the read/write pipelines; `fsmPayloadUtils` holds the
> stateless transforms; `fsmConstants` centralizes magic strings. The `/api/v1/activity-revisions`
> and `/api/v1/service-call-tree` routes are read-only; `/api/v1/create-revision` is the only
> write path.
>
> **Sandbox vs DevOps files:** `manifest.yaml`, `mta.yaml`, and `appconfig.json` have a
> local-only sandbox variant (never committed) and a committed DevOps variant — see
> [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md).

---

## 🐛 Troubleshooting

### View Logs

```bash
cf logs tns-fsm-revisionext-ui-sandbox --recent   # recent buffered logs
cf logs tns-fsm-revisionext-ui-sandbox            # live tail
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Web UI extension shows nothing / 401 on first call | JWT session not established before `/api/v1/*` fired | Check logs for `SHELL-INIT: session issued`. If `SHELL-INIT: rejected — JWT validation failed`, the JWKS URL/region is wrong (`FSM_JWKS_URL`). If `AUTH: rejected ... source=none`, the Bearer token didn't attach (bootstrap ordering). |
| Created revision doesn't appear in the table | Its smartform is still **open** on an Original-only table, OR the revision activity wasn't linked | Open revision smartforms show with red "Open" status. If a row is fully missing, verify `previousActivity` was set (the post-create Activity PATCH) and the SC carries `Z_RevisionOfActivity` + `Z_revisionNumber`. |
| New revision isn't in the **planning list** - not dispatchable, not editable | The original ServiceCall was closed and its `status` was copied onto the revision SC (FSM hides the activities of a closed SC) | Fixed: the revision SC is written with `status = '-2'` and the activity with `DRAFT` / `DISPATCHING` on create; the fields are omitted on append so the original's closed status can never be PATCHed over a revision. If it recurs, run `SELECT w.statusCode, w.statusName FROM ServiceCall w WHERE w.code = '<sc>-<act>-Rev-NNN'` - `-1` "Closed" means the transform didn't run. Remember `-1` as a **type** code is "Inspection"; don't read it as the status. |
| `405 METHOD_NOT_ALLOWED` on SC write | Wrong HTTP method for create vs append | Create uses **POST** to the collection (no id, no `forceUpdate`); append uses **PATCH** to the SC id. |
| `Argument validation failed (field=businessPartner) ... Exactly one value out of id/code/externalId` | A reference object carried multiple identifiers | Handled by `reduceIdentifierRefs` in `fsmPayloadUtils` (id → externalId → code). If a new ref type appears, confirm it isn't excluded. |
| `Cannot invoke "Object.toString()" because "value" is null` | Explicit `null` sent on create | Handled by `stripNulls` in `fsmPayloadUtils`. Check the logged payload for any remaining nulls. |
| `... not part of ActivityDTO_V43` on the SC write | A read-only / unknown field reached the activity write DTO | The read shape is not the write shape. `workflowStep(s)` and friends are stripped in `transformRevisionActivity`; add the rejected field to that strip list. |
| Revision number repeats (e.g. two Rev-2) | A second create fired before the first revision's smartform was visible, or gappy historical data | Numbering counts existing revision rows; open rows now count too. Gappy legacy data (Rev-3 with no Rev-1) can collide - the UDF-based create-or-append check absorbs most cases. |
| Wrong next revision number per table | Per-table count includes only that table's rows | Expected: each smartform table numbers its own revisions. |
| No tables shown | No closed **and approved** inspection smartforms on the original activity | Tables form only from **closed** inspection smartforms on the Original whose approval status is `Genehmigt`. Check the `[DEBUG][approval]` logs: `rows=0` means no linker row was found (query/field issue); a status other than `'Genehmigt'` (e.g. `'Offen'`) means the original isn't approved yet and is correctly hidden. |
| `CA-202 ... doesn't have a unique code [<sc>-Rev-NNN]` | Two revisioned activities under one parent SC collided on the old `<origCode>-Rev-NNN` code format | Fixed by the `<origCode>-<actCode>-Rev-NNN` code format (unique per original activity). If it recurs, verify both assembly sites (`RevisionWriteService.revisionCode` and `fsmPayloadUtils` `tree.code`) match. |
| Code column not clickable / links to nothing | Destination lookup failed, so `activityUrl` came back empty | Check for `[DEBUG][deeplink] destination lookup failed` in the logs. The link needs the `FSM_OAUTH_CONNECT` base URL + `X-Company-ID`; empty company id yields a non-navigable link. |
| Context not detected | Not opened from FSM Web UI | Ensure launched from FSM Web UI; standalone mode has no real context. |
| FSM calls fail with auth errors | Destination misconfigured | Verify the `FSM_OAUTH_CONNECT` destination, OAuth credentials, and `account`/`company` additional properties. |
| Deploy fails to bind / 404 on staging | Destination service instance missing | Create `fsm-revisionext-destination` (unsuffixed) in the subaccount before deploy. |

### Backend Error Logs

On a failed write, the backend logs the failing step, status, url, and FSM's response body on one line:

```
[createRevision] SC POST FAILED status=400 url=... body={...}
[createRevision] Smartform POST FAILED status=... url=... body={...}
[createRevision] Activity PATCH FAILED status=... url=... body={...}
```

Auth rejections log as `AUTH: rejected ... source=<cookie|bearer|none>`. Successful
writes do not log (kept quiet by design).

---

## 📝 Application Details

|                          |                                              |
|--------------------------|----------------------------------------------|
| **App Name**             | RevisionExt                                  |
| **Module Name**          | com.tns.fsm.revisionext.app                  |
| **CF App Name**          | tns-fsm-revisionext-ui (DevOps) / tns-fsm-revisionext-ui-sandbox (local) |
| **Framework**            | SAP UI5 (Fiori) + Node.js Express            |
| **UI5 Theme**            | sap_horizon                                  |
| **Deployment Platform**  | SAP Business Technology Platform (Cloud Foundry, eu10-004) |
| **Node.js Version**      | 18+                                          |
| **Destination**          | FSM_OAUTH_CONNECT (OAuth2 client credentials) |
| **Outbound Auth**        | OAuth 2.0 via BTP Destination Service        |
| **Inbound Auth**         | FSM JWT verification + session token (Web UI active); Mobile Tier-1 auth-key pending |
| **Operated Context**     | FSM Web UI Shell extension (Mobile/Standalone retained) |

---

## 🚀 Current Status

### ✅ Implemented

**Context & Integration**
- Web UI Shell context resolution with `selectedActivityId` preference
- Mobile Web Container + Standalone context paths retained
- Inbound Web UI auth: FSM JWT verification → session token → Bearer on `/api/v1/*`

**Revision Read Pipeline**
- Activity revision tree resolution (Original + `-7` revisions, joined to SC revision numbers)
- Inspection smartform detection (template tagged "Inspection")
- Approval gate: only `Genehmigt` originals form tables (`Linker_Object` UDO lookup)
- Per-chain table grouping via `Z_PreviousChecklist`
- Open/Closed status per revision row (color-coded); Original shows closed-only
- Attachment resolution per populated row
- Per-table live revision numbering
- Tables sorted newest-first by root smartform last-changed
- Per-row activity deep-links for the clickable Code column

**Revision Write Pipeline**
- One-click Create Revision per table (confirm → execute → refresh)
- ServiceCall header + Activity + smartform payload assembly
- UDF-based create-or-append: one SC + one Activity per revision level, shared across tables
- SC code `<origCode>-<actCode>-Rev-NNN` (unique per original activity; fixes CA-202 sibling collision)
- Revision SC/activity forced plannable on create (SC `status = -2`, activity `DRAFT` / `DISPATCHING`); the same fields omitted on append, so a closed original can never be copied over a revision and a planner's scheduling survives
- Identifier-reference reduction + null stripping for FSM validation
- `previousActivity` + `Z_Activity_Type` set via post-create Activity PATCH
- `Z_FollowUpRevisions` maintenance on the original activity (new activities only)
- UUID v4 generation for new smartforms; activity-UUID substitution between calls

**UI**
- Per-smartform tables, collapsible (collapsed on load), newest-first
- Search filter + Expand/Collapse All
- Original-row highlighting
- Confirmation + success dialogs
- Responsive layout

**Architecture / Tooling**
- FSM backend split into focused `utils/` modules (HTTP client, read/write services, payload utils, constants)
- German + English i18n bundles
- Sandbox + mtar deployment split (local `cf push` / DevOps mtar)

### 📋 Planned

- **Mobile Tier-1 auth** — Authentication-Key validation on the Web Container POST (before any Mobile rollout)
- **Cross-context binding** on `/web-container-context` (assert the requested session key matches the token's context)
- **Input validation / UUID guards** on `/api/v1/*` params (CoreSQL injection hardening)
- Persistent session/context storage (currently in-memory; requires `instances: 1`)
- Eventual-consistency handling on post-create refresh (brief retry if FSM lags)
- Collision guard for gappy legacy revision numbering

---

## 🔐 Security Notes

> **Status: as-built (Web UI active path).** Inbound authentication is implemented
> for the Web UI Shell flow. See [docs/SECURITY.md](docs/SECURITY.md) for the full
> model, threat table, and known gaps.

**Implemented**
- **Inbound (Web UI):** the FSM Shell JWT is verified against FSM's JWKS (RS256
  allow-list, `FSMJwtValidator`) at `/api/v1/shell-session-init`, which issues a
  session token. The `requireSession` middleware guards every `/api/v1/*` route;
  the token rides as `Authorization: Bearer <token>` with a sliding 60-min TTL.
- **Outbound OAuth** to FSM via the BTP Destination Service (`FSM_OAUTH_CONNECT`);
  credentials live in VCAP_SERVICES (BTP-managed), tokens cached in memory only.
- **Session/context** stored **in memory**, cleared on restart. HTTPS enforced by CF.

**Known gaps (tracked in `docs/SECURITY.md`)**
- **Mobile Tier-1 auth-key check is NOT implemented.** The Mobile entry POST issues
  a session cookie but does not validate an Authentication Key. The app is operated
  Web-UI-only, so this is an accepted gap — but it must be closed before any Mobile
  rollout. Do not enable the Mobile path until then.
- **Cross-context binding** on `/web-container-context` is recommended hardening.
- **Input validation / UUID guards** on `/api/v1/*` params (CoreSQL) recommended.

---

## 📄 License

Internal use only - Company proprietary.

---

**Last Updated:** September 2026