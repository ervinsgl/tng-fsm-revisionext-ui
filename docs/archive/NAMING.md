# Naming Conventions for TNS FSM Extensions

> **Scope:** This document applies to all SAP BTP extensions for FSM in the TNS estate.
> All future apps in this portfolio should follow these conventions from initial setup.
> 
> **Status:** Active.
> **Owner:** [Team or person responsible — fill in]
> **Last updated:** June 2026 (TNG→TNS estate rename; recorded the sandbox+mtar env-suffix deviation)

## Purpose

This document defines naming conventions for SAP BTP extensions of FSM. The goal is
**operational legibility at scale**: when an admin opens BTP Cockpit, a developer
opens a code editor, or an operator reads logs, they should be able to identify
which app, environment, and resource they're looking at without ambiguity.

These conventions implement Programmierrichtlinie für SAP-Erweiterungen §6.1
(naming) and §7 (versioning). Deviations require approval per §12.

---

## Identifiers at a glance

This table shows the naming pattern for every identifier across an FSM extension.
The "Example" column uses a hypothetical equipment-list app to illustrate.

| Aspect | Pattern | Example: Equipment List app |
|---|---|---|
| App ID (`manifest.json`) | `com.tns.fsm.<capability>.app` | `com.tns.fsm.equipmentlist.app` |
| CF app name | `tns-fsm-<capability>-<artifact>-<env>` | `tns-fsm-equipmentlist-ui-dev` |
| CF route (auto-generated) | `<cf-app-name>.cfapps.<region>.hana.ondemand.com` | `tns-fsm-equipmentlist-ui-dev-<orgslug>.cfapps.eu10-004.hana.ondemand.com` |
| Service binding (destination) | `fsm-<capability>-destination-<env>` | `fsm-equipmentlist-destination-dev` |
| Service binding (other) | `fsm-<capability>-<service-type>-<env>` | `fsm-equipmentlist-xsuaa-dev` |
| Controller file | `<Capability>.controller.js` | `EquipmentList.controller.js` |
| View file | `<Capability>.view.xml` | `EquipmentList.view.xml` |
| Local repo folder | `tns-fsm-<capability>-<artifact>` (no env) | `tns-fsm-equipmentlist-ui` |
| GitHub repo name | `tns-fsm-<capability>-<artifact>` | `tns-fsm-equipmentlist-ui` |
| `package.json` `name` field | `tns-fsm-<capability>-<artifact>` | `tns-fsm-equipmentlist-ui` |
| `xs-security.json` `xsappname` | `com.tns.fsm.<capability>.app` (matches App ID) | `com.tns.fsm.equipmentlist.app` |

---

## Field definitions

**`<capability>`**
What the app does. Short, lowercase, no separators. Examples used so far:
`revisionext`, `equipmentlist` (planned). Avoid abbreviations that aren't
immediately obvious to the team — `tmext` would be ambiguous.

**`<artifact>`**
What kind of deployable thing this is.
- `ui` — UI5 frontend app (Fiori freestyle or generated)
- `srv` — backend service if you split frontend and backend (rare)
- `flow` — workflow apps
- `api` — pure API services without UI

For FSM extensions following the current pattern (UI5 + Express backend in one
deployable), use `ui` — the backend is bundled with the frontend, but the deployed
artifact is conceptually a UI app.

**`<env>`**
Deployment environment.
- `dev` — development
- `test` — testing/QA
- `prod` — production

Each environment is a separate CF deployment with separate bindings.

**`<service-type>`** (for service bindings)
The BTP service category.
- `destination` — Destination Service (FSM API connectivity)
- `xsuaa` — XSUAA / IAS (when used; not used by current FSM extensions)
- `connectivity` — On-Premise connectivity
- `html5-repo` — HTML5 Application Repository (when applicable)

---

## Per-environment deployment

Each environment is a separate CF deployment. App ID stays the same across
environments — it's the namespace, not the deployment.

| Env | CF app name | Service binding | URL |
|---|---|---|---|
| Dev | `tns-fsm-equipmentlist-ui-dev` | `fsm-equipmentlist-destination-dev` | `tns-fsm-equipmentlist-ui-dev-...cfapps...` |
| Test | `tns-fsm-equipmentlist-ui-test` | `fsm-equipmentlist-destination-test` | `tns-fsm-equipmentlist-ui-test-...cfapps...` |
| Prod | `tns-fsm-equipmentlist-ui-prod` | `fsm-equipmentlist-destination-prod` | `tns-fsm-equipmentlist-ui-prod-...cfapps...` |

App ID `com.tns.fsm.equipmentlist.app` stays the same in dev, test, and prod —
the namespace is environment-agnostic. Only the deployment-side identifiers vary.

> **Approved deviation (sandbox + mtar split):** Some apps — e.g. Revision
> Extension — deploy via the sandbox + mtar model (`SANDBOX_MTAR_MIGRATION.md`)
> rather than the `<env>`-suffixed scheme above. Under that model the environment
> is determined by **which subaccount** the mtar lands in (separate spaces/domains
> per env), so the CF app name omits `<env>` (`tns-fsm-<capability>-ui`) and the
> destination service is a single unsuffixed `fsm-<capability>-destination` reused
> in every subaccount. A local `-sandbox` app/route variant exists for hand
> `cf push` testing and is never committed. This deviation is approved per §12.

---

## Why these specific patterns

### Reverse-DNS for App IDs (`com.tns.fsm.<capability>.app`)

UI5 standard. Allows multiple apps to coexist in the same namespace tree without
collision. The `com.` prefix is convention from Java/Android, adopted by SAP.
The trailing `.app` segment distinguishes app identifiers from sub-modules within
an app (e.g., `com.tns.fsm.equipmentlist.controller.EquipmentList`).

### Hyphen-separated CF app names

Cloud Foundry restriction — app names cannot contain dots, only alphanumerics
and hyphens. The pattern `tns-fsm-<capability>-<artifact>-<env>` is sortable in
BTP cockpit listings (alphabetical sort groups all `tns-fsm-*` together, then
all `-equipmentlist-*` together within that, then `-ui-` artifacts within that).

### Capability-first in service bindings (`fsm-<capability>-destination-<env>`)

Drops the `tns-` prefix on service bindings to reduce visual noise in BTP cockpit.
All FSM-related services start with `fsm-`, making them easy to filter and identify.
The capability comes second (so they sort grouped by capability when listed
alphabetically). The artifact-type segment of the CF app name (`ui`) is omitted
here because it's implicit in the binding's existence (a binding only matters
because some app uses it).

### PascalCase for controller and view files (`<Capability>.controller.js`)

UI5 standard convention, matches how `Component.js` is named. The class declaration
inside (`Controller.extend("com.tns.fsm.<capability>.app.controller.<Capability>")`)
mirrors the file name.

### Folder name without `<env>` (`tns-fsm-<capability>-<artifact>`)

The folder is a single source repository, deployed to all environments from the
same git branch. Including `<env>` in the folder name would be misleading — there's
no separate folder per environment.

The folder name matches the GitHub repo name and the `package.json` name field.

### Why `xsappname` matches App ID

`xs-security.json#xsappname` is the SAP authorization service identifier. By
matching it to the UI5 App ID, both the security configuration and the namespace
identify the same logical app. Convention makes it easier to reason about
"is this a TNS FSM extension and which one."

---

## Things explicitly NOT defined here

These are decisions for separate documentation:

- **BTP space organization.** One space per env, or one space per capability? See
  [BTP architecture documentation, separate].
- **IAS tenant configuration.** Inbound auth for the FSM extensions does not use
  IAS — see `docs/SECURITY.md` for each app's auth model.
- **CI/CD pipeline naming.** Pipeline names, build artifact names, registry naming
  — see [CI/CD documentation, separate].
- **Documentation repository naming.** This document lives at `docs/NAMING.md`
  inside each app's repo for now. If a separate company-wide docs repo is created,
  this convention can be referenced from there.

---

## Practical scenarios

### Starting a new app

1. Pick the `<capability>` name (must be unique across the FSM extension portfolio).
2. Create a new GitHub repo named `tns-fsm-<capability>-ui`.
3. Create the local folder with the same name.
4. In `manifest.json`, set `sap.app.id = "com.tns.fsm.<capability>.app"`.
5. In `package.json`, set `name = "tns-fsm-<capability>-ui"`.
6. In `xs-security.json`, set `xsappname = "com.tns.fsm.<capability>.app"`.
7. In `manifest.yaml`, set the CF app name and service binding per the per-env table.
8. Name the main controller and view file after the capability in PascalCase.
9. Reference this document in the README so future maintainers know the conventions.

### Adding a new environment

1. Create new CF service binding: `fsm-<capability>-destination-<new-env>`.
2. Adjust `manifest.yaml` (or use a per-env manifest variant) for the new CF app
   name `tns-fsm-<capability>-ui-<new-env>`.
3. Set the env-specific environment variables.
4. Deploy.

App ID, controller name, view name, and folder name do NOT change between environments.

### Renaming an existing app

This is a substantial undertaking — see the rename guide used for the
`mobileappwebcontainer` → `com.tns.fsm.revisionext.app` migration. Future renames
should follow a similar phased approach: controller/view files first, then
manifest.yaml + package.json, then App ID via find-and-replace, then deploy.

---

## Rationale (for the curious or skeptical)

These conventions are deliberately verbose. Short names like `tmjournal` would
be more typeable. We accept the verbosity for these reasons:

1. **Multiple apps in one BTP estate.** When there are 5 apps in a space, short
   names like `tmjournal`, `equipment`, `routing` provide no context about who
   owns them or what platform they integrate with. Long names like
   `tns-fsm-tmjournal-ui-dev` immediately tell an operator what they're looking at.

2. **Auditability.** Programmierrichtlinie §6 specifies naming conventions
   precisely because audits care. A consistent pattern across all extensions
   makes audits easier — auditors can verify "all FSM extensions follow the
   pattern" rather than "let me check each app individually."

3. **Future-proofing.** Adding `<env>` suffixes lets us scale to dev/test/prod
   without rename. Including `<capability>` lets us add more apps without naming
   conflicts. Including `<artifact>` lets us add backend services or workflows
   without conflicting with the UI app's name.

4. **Cost: minimal.** Long names are typed once in configuration files. Day-to-day
   work doesn't suffer — `cf logs <app-name>` works the same regardless of name
   length, and tab completion handles it.

The verbosity is a one-time cost for permanent legibility benefit.

---

## When to revisit this document

Update this document whenever any of the following change:

- A new identifier type is added (e.g., a new BTP service that needs naming).
- An existing pattern is changed company-wide.
- The Programmierrichtlinie itself is updated and conflicts arise.
- A new artifact type is introduced (e.g., the company starts deploying CAP
  apps that need different naming).

The "Last updated" line at the top of this document MUST be kept current.

---

## Appendix: Existing apps following this convention

| App | App ID | CF app (DevOps) | CF app (sandbox) | Destination | Folder |
|---|---|---|---|---|---|
| Revision Extension | `com.tns.fsm.revisionext.app` | `tns-fsm-revisionext-ui` | `tns-fsm-revisionext-ui-sandbox` | `fsm-revisionext-destination` | `tns-fsm-revisionext-ui` |

> **Note on the env suffix:** Revision Extension follows the **sandbox + mtar
> deployment split** (see `SANDBOX_MTAR_MIGRATION.md`), an approved deviation from
> the `<env>`-suffixed convention below. The DevOps app name omits `<env>` (the
> environment is encoded by which subaccount the mtar lands in), and the
> destination service is a single unsuffixed `fsm-revisionext-destination` reused
> across environments. A local `-sandbox` variant exists for hand-`cf push`
> testing and is never committed.

This list will grow as more apps are added.