# Sandbox + mtar Deployment Split — Migration Playbook (RevisionExt)

> **Scope:** This is the app-specific version of the deployment-split playbook,
> specialized for **RevisionExt** (`revisionext` = `revisionext`). It applies the
> "local sandbox via `manifest.yaml`, DevOps DEV/QA/PROD via `mta.yaml` (mtar
> transport)" model, the `tng` → `tns` naming correction, and the destination-name
> consolidation.
>
> **This app is a Web UI Shell extension** (not a Mobile WebContainer app). Steps
> that are Mobile-specific in the generic playbook (the `FSM_WEBCONTAINER_AUTH_KEY`,
> the Web Container URL cutover) are adapted here for the Web UI reality.
>
> **Note on code structure:** the backend FSM layer was refactored out of the old
> single `FSMService.js` into `utils/` modules. The BTP destination config name now
> lives in `utils/fsmConstants.js` (`DESTINATION_NAME`), not `FSMService.js`.
>
> **Time required:** ~30-45 minutes, plus FSM Admin coordination for the Shell
> extension URL cutover.

For naming conventions see [NAMING.md](NAMING.md). For the full app rename
procedure (App ID, controllers, views) see [RENAME.md](RENAME.md) — this playbook
assumes the App ID is already correct and only covers deployment identifiers,
the `tng`→`tns` correction, and the destination consolidation.

---

## The model

Two deployment paths that differ from each other but stay internally consistent:

| | **Local sandbox** | **DevOps DEV/QA/PROD** |
|---|---|---|
| File used | `manifest.yaml` | `mta.yaml` |
| Command | `cf push` | `npm run build:mta` + `cf deploy` |
| CF app name | `tns-fsm-revisionext-ui-sandbox` | `tns-fsm-revisionext-ui` |
| Route | pinned `-sandbox-...` | auto-generated (`default-route: true`) |
| Destination service | `fsm-revisionext-destination` | `fsm-revisionext-destination` |
| Subaccount | your personal sandbox | DevOps-owned, separate per env |

**Why the DevOps app name omits `<env>`:** DEV/QA/PROD are separate subaccounts
(separate spaces, domains, auto-generated routes). The environment is encoded by
*which subaccount* the mtar lands in, so an `<env>` suffix on the app name is
redundant. This is a documented deviation from the default
`tns-fsm-revisionext-ui-<env>` convention — see NAMING.md.

**Why the sandbox name carries `-sandbox`:** purely to guarantee the local app
can never collide with the pipeline-owned `tns-fsm-revisionext-ui` app or hijack
its route.

**Why one unsuffixed destination everywhere:** the destination service instance
(`fsm-revisionext-destination`) is the same name in every subaccount, created and
configured per-subaccount in cockpit. No `-dev`/`-qa`/`-prod` suffix. This keeps
`manifest.yaml` and `mta.yaml` referencing an identical binding name.

---

## Per-app values (RevisionExt)

These are the concrete values for this app. The current (pre-migration) identifiers
are shown alongside the target so the rename deltas are explicit.

| Token | Target value | Current (pre-migration) |
|---|---|---|
| `revisionext` | `revisionext` | `revisionext` |
| App ID | `com.tns.fsm.revisionext.app` | `com.tng.fsm.revisionext.app` |
| mta ID | `tns.fsm.revisionext.ui` | (none — no mta.yaml yet) |
| DevOps CF app | `tns-fsm-revisionext-ui` | `tng-fsm-revisionext-ui-dev` |
| Sandbox CF app | `tns-fsm-revisionext-ui-sandbox` | (none) |
| Destination service | `fsm-revisionext-destination` | `fsm-revisionext-destination-dev` |
| BTP destination config | `FSM_OAUTH_CONNECT` | `FSM_OAUTH_CONNECT` (set in `fsmConstants.js`) |

> The **BTP destination config name** (what `utils/fsmConstants.js` `DESTINATION_NAME`
> reads, i.e. `FSM_OAUTH_CONNECT`) is separate from the **destination service
> instance name** (what `manifest.yaml`/`mta.yaml` bind to, i.e.
> `fsm-revisionext-destination`). The service instance grants access to the config.
> Don't conflate them.

---

## Step 1 — `tng` → `tns` correction

Sweep the whole repo. The correct estate name is **TNS**, not TNG.

```bash
grep -rn "tng\|TNG" . 2>/dev/null | grep -v node_modules | grep -v .git/
```

Replace in code/config (case-sensitive, dotted and slashed forms both appear in
App-ID-bearing files):

```bash
# slashed module paths (sap.ui.define, Component.js)
find . -type f \( -name "*.js" -o -name "*.xml" -o -name "*.json" -o -name "*.html" \) \
    -not -path "./node_modules/*" -not -path "./.git/*" \
    -exec sed -i 's|com/tng/fsm/|com/tns/fsm/|g' {} +

# dotted namespace (class declarations, manifest, xs-security, ui5*.yaml)
find . -type f \( -name "*.js" -o -name "*.xml" -o -name "*.json" -o -name "*.html" -o -name "*.yaml" \) \
    -not -path "./node_modules/*" -not -path "./.git/*" \
    -exec sed -i 's|com\.tng\.fsm\.|com.tns.fsm.|g' {} +

# deploy identifiers (CF app names, package.json name, service bindings)
find . -type f \( -name "*.yaml" -o -name "*.json" \) \
    -not -path "./node_modules/*" -not -path "./.git/*" \
    -exec sed -i 's|tng-fsm-|tns-fsm-|g' {} +
```

Then hand-check the docs (README, NAMING, SECURITY, SETUP, RENAME) for prose
references to "TNG"/"TNG estate":

```bash
grep -rn "TNG\|tng" *.md docs/ 2>/dev/null | grep -v .git/
```

Re-run the first grep until it returns nothing load-bearing. NAMING.md title and
scope line are common stragglers.

**RevisionExt-specific files to re-verify after the sweep** (all carry the App ID
or deploy identifiers):
- `manifest.json`, `Component.js`, `index.html`, `ui5*.yaml` — App ID
  (`com.tns.fsm.revisionext.app`) in `sap.ui.define` paths and class names.
- `xs-security.json` — `xsappname: com.tns.fsm.revisionext.app`.
- `webapp/util(s)/RevisionExt.controller.js` + `RevisionService.js` + `ContextService.js`
  — `sap.ui.define` dependency paths like `com/tns/fsm/revisionext/app/utils/...`.
- `manifest.yaml` / `package.json` — the `tng-fsm-…` → `tns-fsm-…` app name and the
  `fsm-revisionext-destination-dev` service binding (the `-dev` suffix is dropped in
  Step 3, separate from the tng→tns change).
- The backend `utils/` modules do **not** carry the App ID (they're plain Node
  `require` modules), so the sweep won't touch them — no action needed there.

---

## Step 2 — `mta.yaml` (DevOps transport file)

Target shape — substitute `revisionext`:

```yaml
_schema-version: "3.2"
ID: tns.fsm.revisionext.ui
version: 1.0.0
description: <App description> (side-by-side, Node.js/Express + SAPUI5)

parameters:
  enable-parallel-deployments: true

modules:
  - name: tns-fsm-revisionext-ui          # NO -dev / -env suffix
    type: nodejs
    path: .
    parameters:
      buildpack: nodejs_buildpack
      command: npm start
      memory: 512M                          # RevisionExt currently uses 512M
      disk-quota: 512M
      default-route: true                   # CF auto-generates host per subaccount
    requires:
      - name: fsm-revisionext-destination
    build-parameters:
      builder: custom
      commands:
        - npm ci --omit=dev
      ignore:
        - ".git/"
        - "docs/"
        - "dist/"
        - "resources/"
        - "mta_archives/"
        - "*.mtaext"

resources:
  - name: fsm-revisionext-destination
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: fsm-revisionext-destination
```

Checklist:
- [ ] Module `name` is unsuffixed (`tns-fsm-revisionext-ui`).
- [ ] `requires` and `resources` both reference the **same** unsuffixed
      destination service name.
- [ ] `service-name` byte-matches the instance that actually exists in the target
      subaccount (see Step 6).
- [ ] `memory` matches the app. RevisionExt's current `manifest.yaml` uses `512M`;
      keep `512M` unless profiling shows it can drop.

---

## Step 3 — `manifest.yaml` (local sandbox file)

Keep the "do not commit" header. Target shape:

```yaml
# ============================================================
#  SANDBOX / LOCAL ONLY — DO NOT COMMIT TO THE DEVOPS REPO
#  Personal test instance. The official DEV app is owned by
#  the pipeline and uses the unsuffixed name/route.
#  NEVER copy the "-sandbox" name or route into the repo's
#  mta.yaml — it would hijack the pipeline app/route.
# ============================================================

applications:
  - name: tns-fsm-revisionext-ui-sandbox
    memory: 512M
    disk_quota: 512M
    instances: 1
    buildpacks:
      - nodejs_buildpack
    command: npm start
    path: .
    routes:
      - route: tns-fsm-revisionext-ui-sandbox-<orgslug>.cfapps.eu10-004.hana.ondemand.com
    services:
      - fsm-revisionext-destination       # unsuffixed — same instance as mta.yaml
```

Checklist:
- [ ] App name and route carry `-sandbox`.
- [ ] `services:` references the unsuffixed destination (NOT a `-dev` variant).
- [ ] Route's `<orgslug>` and `<region>` match your sandbox subaccount.

> **Best practice:** add `manifest.yaml` to `.gitignore` so the DevOps repo can
> only ever build from `mta.yaml`. The file's own header says don't commit it.

---

## Step 4 — `package.json`

Two things:

```jsonc
{
  "name": "tns-fsm-revisionext-ui",        // hyphenated, matches folder/repo
  "scripts": {
    // target the DevOps app name; do NOT delete the shared destination here
    "undeploy": "cf delete tns-fsm-revisionext-ui -f"
  }
}
```

> **Never `cf delete-service fsm-revisionext-destination` in an undeploy script.**
> The destination is shared across every environment/app in the subaccount;
> deleting it via a routine undeploy breaks everything else bound to it.

---

## Step 5 — `utils/fsmConstants.js` (verify destination config name)

The BTP destination config name lives in `utils/fsmConstants.js` (after the FSM
service refactor — it is no longer in a single `FSMService.js`). Confirm it:

```bash
grep -n "DESTINATION_NAME" utils/fsmConstants.js
```

Should read `FSM_OAUTH_CONNECT`. This is the FSM-side destination *config* name,
not the service instance. It does not carry an env suffix — the same config name
is used in every subaccount.

```javascript
const DESTINATION_NAME = 'FSM_OAUTH_CONNECT';
```

> The destination **service instance** (bound in `manifest.yaml`/`mta.yaml`) is
> `fsm-revisionext-destination`; the destination **config** read here is
> `FSM_OAUTH_CONNECT`. Both must exist in each target subaccount (Step 6).

---

## Step 6 — Subaccount prerequisites (per environment)

In **each** target subaccount (your sandbox, and each DevOps env), before deploy:

```bash
# 1. The destination SERVICE INSTANCE must exist with the unsuffixed name
cf services
cf create-service destination lite fsm-revisionext-destination   # if missing

# 2. The BTP DESTINATION CONFIG must be configured in cockpit
#    (Connectivity > Destinations), e.g. FSM_OAUTH_CONNECT, with OAuth creds
#    + additional properties (account, company, X-Account-ID, etc.)
```

If the service instance name doesn't match the binding in your yaml, the push/deploy
fails to bind. This is the single most common failure point.

---

## Step 7 — Deploy + cutover (sandbox, Web UI)

This app is a **Web UI Shell extension**. There is no `FSM_WEBCONTAINER_AUTH_KEY`
(Mobile Tier-1 is not implemented — see SECURITY.md), so the app does **not** fail
on start for a missing auth key. The only auth-related env var is the JWKS URL,
which has a working default but is set explicitly here for clarity.

```bash
cf push                                    # creates tns-fsm-revisionext-ui-sandbox

# Set the FSM JWKS endpoint (default is the DE region; set explicitly).
cf set-env tns-fsm-revisionext-ui-sandbox FSM_JWKS_URL \
  'https://de.fsm.cloud.sap/api/oauth2/v2/.well-known/jwks.json'
cf restage tns-fsm-revisionext-ui-sandbox

# verify clean start
cf logs tns-fsm-revisionext-ui-sandbox --recent | grep -E "running on port"
```

Then point the **FSM Shell extension URL** at the new `-sandbox` route. (This is the
Web UI extension registration, NOT a Web Container URL — that field is for Mobile.)

```bash
cf app tns-fsm-revisionext-ui-sandbox     # copy the route
# FSM Admin > Company > Extensions / Shell Plugins > [RevisionExt] > URL:
#   https://<route>/        (the Shell extension loads the app root via GET /)
```

**Verify end-to-end in FSM Web UI** (not Mobile): open an activity, launch the
extension, and confirm in the logs:

```bash
cf logs tns-fsm-revisionext-ui-sandbox
# expect, in order:
#   SHELL-INIT: session issued | user: <user>
#   (then 200s on /api/v1/activity-revisions — no "AUTH: rejected" lines)
```

If you see `SHELL-INIT: rejected — JWT validation failed`, the JWKS URL/region is
wrong or the token is invalid. If you see `AUTH: rejected ... source=none` on a data
call, the Bearer token didn't attach (bootstrap ordering) — see SECURITY.md.

**Coexist-then-delete:** keep the old app (`tng-fsm-revisionext-ui-dev`) running
until the new sandbox app is verified end-to-end from FSM Web UI. The Shell
extension URL holds one URL, so the cutover moment is when you change it —
reversible by switching back. Once Web UI launches work against the sandbox app,
delete the old:

```bash
cf delete tng-fsm-revisionext-ui-dev -f
# do NOT delete the destination service — reuse it
# (note: the old service was fsm-revisionext-destination-dev; the new unsuffixed
#  fsm-revisionext-destination must exist — see Step 6 — before deleting anything)
```

---

## Step 8 — Docs

Update each app's docs to match:
- **README.md** — header CF app name (note both sandbox + DevOps), destination
  service name, destination config name, deploy section (both `cf push` and
  `build:mta`/`cf deploy` paths), and any `cf` commands using the app name.
- **NAMING.md** — record the env-suffix deviation if not already there; add the
  app to the appendix table; bump "Last updated".
- **SECURITY.md** — update any `cf set-env`/`cf restage` commands that name the CF
  app (now `tns-fsm-revisionext-ui` / `-sandbox`), and the env-var table.
- **SETUP.md / RENAME.md** — sweep for the old `tng-…-dev` app name and the
  `fsm-revisionext-destination-dev` service name.
- **This file (SANDBOX_MTAR_MIGRATION.md)** — already app-specific; keep the
  per-app tracker row current.

---

## Quick verification sweep (run before committing)

```bash
# no stale tng anywhere
grep -rn "tng\|TNG" . 2>/dev/null | grep -v node_modules | grep -v .git/

# no stale -dev deploy identifiers or suffixed destination
grep -rn "ui-dev\b\|-destination-dev" manifest.yaml mta.yaml package.json README.md

# mta module name unsuffixed, destination matches in all 3 spots
grep -nE "name:|service-name:" mta.yaml

# sandbox binds the unsuffixed destination
grep -n "fsm-.*-destination" manifest.yaml

# App ID consistent
grep -rn "com.tns.fsm.revisionext.app" manifest.json xs-security.json ui5*.yaml index.html Component.js | wc -l
```

All should come back consistent with the table in "Per-app values (RevisionExt)".

---

## Per-app tracker

| App | tng→tns | mta.yaml | manifest.yaml | package.json | docs | deployed + cutover |
|---|---|---|---|---|---|---|
| `inspreppdfviewext` | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ in progress |
| `revisionext` | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |