# T&M Journal — Change Workflow (BAS → DevOps → DEV → QA → PROD)

How to take a change from idea to running in each environment, safely.

---

## The pieces you work with

- **BAS workspace** = a clone of the Azure DevOps repo (`tns.fsm.timematerial.ui`, in BAS-Git).
  This is where you edit, and what you commit. **The repo is the source of truth** — the
  pipeline builds and deploys from it, not from your local files.
- **Sandbox CF app** (`tns-fsm-timematerialext-ui-sandbox`) = your private running instance for
  testing, deployed by hand with `cf push`. Its deploy descriptors use `-sandbox` names and are
  **local only — never committed.**
- **Pipeline** = builds the `.mtar` and deploys. You don't run build/deploy by hand for the
  official environments.
- **Branch model (UNIFY):**
  - `feature/*` → `develop` (via PR) → deploys to **DEV**
  - `develop` → `main` (via PR) → creates the **cTMS transport** to **QA**, then **PROD**

---

## Part A — Make and ship a change

### 1. Start from an up-to-date `develop`
```
git checkout develop
git pull
git checkout -b feature/<short-name>
```

### 2. Make the code change in BAS
Edit the code files (`routes/`, `utils/`, `webapp/`, `index.js`, etc.).

### 3. (Recommended) Test it in your sandbox first
Deploy the current code to the sandbox app and check it from FSM:
```
cf push -f <sandbox-manifest>     # or your in-place sandbox manifest
```
Launch the sandbox from its own FSM registration (Mobile + Web UI) and confirm the change works.
This is what the sandbox is for — prove it before it enters the official flow.

### 4. Stage ONLY the files you meant to change
```
git status
git diff <file>            # check each diff before staging
git add <only the intended files>
```
**Commit:** code files, and `mta.yaml` / `manifest.yaml` **only if** you intentionally changed the
repo versions (the `-dev` / `default-route` ones).
**Never stage:** `secrets.mtaext`, any `-sandbox`-named descriptor, `node_modules`, real secret values.

> Safety check before committing:
> ```
> git diff --cached | grep -i sandbox    # expect NOTHING
> ```

### 5. Commit with a clear message
```
git commit -m "<what changed and why>"
```

### 6. Push the branch
```
git push
```

### 7. Open a Pull Request into `develop`
- **Into:** `develop` (never `main` for a feature branch).
- **Reviewers:** Pieper, Böhme, Schrader.
- **Description:** what changed and why (one or two lines is enough).

### 8. Pipeline runs on the PR
Expect **Build** to pass. **DeployDev** behaves per the pipeline setup; a destination-missing
error is environment setup, not your code.

### 9. Merge to `develop` → DEV deploy
Once reviewed and merged, the pipeline deploys the change to **DEV**.

### 10. Promote to QA / PROD (separate, deliberate step)
When DEV is verified, open a PR **`develop` → `main`**. Merging it creates the **cTMS transport**;
QA (then PROD) is released through cTMS / Cloud ALM, not straight from Git.

---

## Part B — Guardrails (the things that actually bite)

- **Code only across the sandbox/repo boundary.** Move `routes/`, `utils/`, `webapp/`, `index.js`,
  etc. Never carry `-sandbox` `manifest.yaml` / `mta.yaml` into the repo.
- **Run `git diff --cached | grep -i sandbox` before every push.** Zero hits expected.
- **Never commit secrets.** No real `FSM_WEBCONTAINER_AUTH_KEY`, no clientSecret, no
  `secrets.mtaext`. The `.gitignore` covers these — keep it that way.
- **Keep the three destination references consistent** when you touch the destination name:
  - `manifest.yaml` / `mta.yaml` → service **instance** name (`fsm-timematerialext-destination`)
  - `FSMService.js` → destination **entry** name (`this.destinationName = 'FSM_OAUTH_CONNECT'`)
  - The entry Dennis configures in the cockpit must also be `FSM_OAUTH_CONNECT`.
- **Don't reinstall npm on the corporate network** unless needed — it can hit the proxy
  corruption. The committed `package-lock.json` is the trusted one; build happens in the pipeline
  (clean network).

---

## Part C — Per-environment runtime setup (NOT code — done once per environment)

These are not solved by a PR. They must exist in each space/subaccount:

1. **Destination service _instance_** `fsm-timematerialext-destination` — **before deploy**
   (missing = the 404 deploy error).
2. **Destination _entry_** `FSM_OAUTH_CONNECT` configured with URL + credentials; **clientSecret
   pasted after import** (it isn't carried over) — before the app calls FSM.
3. **Env var** `FSM_WEBCONTAINER_AUTH_KEY` (mandatory — app exits on startup without it) — set on
   the app **after deploy**. Each environment gets its **own** key.
4. **Env var** `FSM_JWKS_URL` — optional; defaults to the DE-region URL in code, set only to
   override for another region.
5. **Read the deployed route** (`cf app <name>` or cockpit) and **register it in that
   environment's FSM** (Mobile + Web UI) — after deploy.

---

## Quick reference — where things live

| Thing | Where |
|---|---|
| Source of truth | Azure DevOps repo (`tns.fsm.timematerial.ui`) |
| Your editor | BAS (workspace = repo clone) |
| Your test instance | sandbox CF app (`cf push`, local descriptors) |
| Build + deploy | pipeline (DEV) / cTMS + Cloud ALM (QA, PROD) |
| `FSM_WEBCONTAINER_AUTH_KEY` read | `index.js` (mandatory; app exits if missing) |
| `FSM_JWKS_URL` read | `FSMJwtValidator.js` (optional; DE default) |
| Destination entry name | `FSMService.js` → `this.destinationName` |
