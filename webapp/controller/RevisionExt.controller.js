sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/base/i18n/Localization",
    "com/tns/fsm/revisionext/app/utils/ContextService",
    "com/tns/fsm/revisionext/app/utils/RevisionService"
], (Controller, JSONModel, MessageBox, Localization, ContextService, RevisionService) => {
    "use strict";

    return Controller.extend("com.tns.fsm.revisionext.app.controller.RevisionExt", {

        onInit() {
            this.getView().setModel(new JSONModel({
                busy: true,
                contextLoaded: false,
                showError: false,
                context: {},
                revisionsBusy: false,
                tables: [],
                activities: [],
                noSmartforms: false,
                originalServiceCallId: null,
                originalActivityId: null,
                originalCode: null
            }), "view");

            this._loadContext();
        },

        /** Resource bundle accessor. */
        _i18n() {
            return this.getView().getModel("i18n").getResourceBundle();
        },

        /** Get a translated text, with optional placeholder args. */
        _t(sKey, aArgs) {
            return this._i18n().getText(sKey, aArgs);
        },

        /**
         * Formatter: revision label for a row.
         * @param {boolean} bIsOriginal
         * @param {number|null} iRevisionNumber
         * @param {string} sOriginal - i18n>revisionOriginal
         * @param {string} sLabel - i18n>revisionLabel (with {0})
         * @param {string} sUnknown - i18n>revisionLabelUnknown
         */
        formatRevisionLabel(bIsOriginal, iRevisionNumber, sOriginal, sLabel, sUnknown) {
            if (bIsOriginal) {
                return sOriginal;
            }
            if (iRevisionNumber == null) {
                return sUnknown;
            }
            // sLabel is "Rev-{0}"; substitute manually (parts already resolved).
            return sLabel.replace("{0}", iRevisionNumber);
        },

        /**
         * Formatter: smartform status text.
         * @param {boolean} bHasSmartform
         * @param {boolean} bClosed
         * @param {string} sClosed - i18n>statusClosed
         * @param {string} sOpen - i18n>statusOpen
         */
        formatStatusText(bHasSmartform, bClosed, sClosed, sOpen) {
            if (!bHasSmartform) {
                return "";
            }
            return bClosed === true ? sClosed : sOpen;
        },

        async _loadContext() {
            const oModel = this.getView().getModel("view");

            try {
                const context = await ContextService.getContext();

                // Apply the FSM UI language BEFORE flipping contextLoaded (which
                // makes the translatable content visible). setLanguage fires
                // localizationChanged, which the i18n ResourceModel honors, so
                // all {i18n>...} bindings re-resolve. Shell context exposes
                // .locale, mobile exposes .language; accept either.
                this._setAppLanguage(context.locale || context.language);

                oModel.setProperty("/context", context);
                oModel.setProperty("/contextLoaded", true);
                oModel.setProperty("/busy", false);

                console.log("FSM context loaded:", {
                    source: context.source,
                    user: context.userName,
                    company: context.companyName,
                    objectType: context.objectType,
                    cloudId: context.cloudId
                });

                this._objectId = context.cloudId;
                this._loadRevisions(context.cloudId);

            } catch (error) {
                console.warn("FSM context not available:", error.message);
                oModel.setProperty("/showError", true);
                oModel.setProperty("/busy", false);
            }
        },

        /**
         * Set the application language from the FSM context.
         * Normalizes 'de-DE' / 'de_DE' -> 'de', restricts to the languages this
         * app ships bundles for, and only switches when it actually differs.
         * Must run before the translatable content becomes visible.
         * @param {string} language - FSM locale (e.g. 'de', 'en', 'de-DE')
         * @private
         */
        _setAppLanguage(language) {
            if (!language) return;

            const SUPPORTED = ["en", "de"];
            const langCode = language.toString().toLowerCase().split("-")[0].split("_")[0];
            if (SUPPORTED.indexOf(langCode) === -1) return;

            const currentLang = Localization.getLanguage() || "";
            const currentLangCode = currentLang.toLowerCase().split("-")[0].split("_")[0];

            if (langCode !== currentLangCode) {
                console.log(`Setting language to '${langCode}' (from FSM context)`);
                Localization.setLanguage(langCode);
            }
        },

        async _loadRevisions(objectId) {
            const oModel = this.getView().getModel("view");

            if (!objectId) {
                console.warn("No objectId in context; skipping revision load.");
                return;
            }

            oModel.setProperty("/revisionsBusy", true);

            try {
                const result = await RevisionService.getActivityRevisions(objectId);
                const activities = result.activities || [];
                const tables = result.tables || [];

                // Per-table UI state: collapsed by default, visible (for search).
                tables.forEach(t => {
                    t.expanded = false;
                    t.visible = true;
                });

                oModel.setProperty("/activities", activities);
                oModel.setProperty("/tables", tables);
                oModel.setProperty("/allExpanded", false);
                oModel.setProperty("/originalServiceCallId", result.originalServiceCallId || null);
                oModel.setProperty("/originalActivityId", result.originalActivityId || null);
                oModel.setProperty("/originalCode", result.originalCode || null);
                oModel.setProperty("/noSmartforms", tables.length === 0 && activities.length > 0);

                console.log(`Loaded ${tables.length} smartform table(s), ${activities.length} activity row(s) for ${objectId}`);
            } catch (error) {
                console.error("Failed to load revisions:", error.message);
                oModel.setProperty("/activities", []);
                oModel.setProperty("/tables", []);
                oModel.setProperty("/noSmartforms", false);
            } finally {
                oModel.setProperty("/revisionsBusy", false);
            }
        },

        /**
         * Per-table Create Revision. Builds the next-revision preview, shows a
         * confirmation dialog (basic info + Create/Close). On Create, executes
         * the full flow (PATCH SC -> POST smartform -> PATCH follow-up), shows a
         * success dialog, and refreshes the tables.
         *
         * @param {sap.ui.base.Event} oEvent - button press event
         */
        async onCreateRevision(oEvent) {
            const oModel = this.getView().getModel("view");

            // The pressed button's binding context is the table object.
            const oCtx = oEvent.getSource().getBindingContext("view");
            const oSmartform = oCtx ? {
                rootSmartformId: oCtx.getProperty("rootSmartformId"),
                lastSmartformId: oCtx.getProperty("lastSmartformId"),
                rootPruefberichtNr: oCtx.getProperty("rootPruefberichtNr"),
                nextRevisionNumber: oCtx.getProperty("nextRevisionNumber")
            } : null;

            const sServiceCallId = oModel.getProperty("/originalServiceCallId");
            const sKeepActivityId = oModel.getProperty("/originalActivityId");
            const sOriginalCode = oModel.getProperty("/originalCode");

            if (!sServiceCallId) {
                MessageBox.warning(this._t("warnNoServiceCall"));
                return;
            }

            // Build the preview (basic info for the confirmation dialog).
            oModel.setProperty("/busy", true);
            let preview;
            try {
                preview = await RevisionService.getServiceCallTree(sServiceCallId, sKeepActivityId, sOriginalCode, oSmartform);
            } catch (error) {
                console.error("Failed to build revision preview:", error.message);
                MessageBox.error(this._t("errPreparing", [error.message]));
                return;
            } finally {
                oModel.setProperty("/busy", false);
            }

            const nextRev = preview.nextRevisionNumber;
            const revisionCode = preview.revisionCode || "";
            const activityCode = preview.activityCode || "";
            const scExists = preview.serviceCallExists;
            const actExists = preview.activityExists;
            const smartformDescription = (preview.smartformPayload && preview.smartformPayload.description) || "";

            const sInfo =
                this._t("confNextRevision", [nextRev != null ? nextRev : this._t("unknown")]) + "\n" +
                this._t("confServiceCall", [
                    revisionCode,
                    scExists ? this._t("stateScExists") : this._t("stateScNew")
                ]) + "\n" +
                this._t("confActivity", [
                    activityCode,
                    actExists ? this._t("stateActExists") : this._t("stateActNew")
                ]) + "\n" +
                this._t("confSmartformDescription", [smartformDescription]);

            const sCreate = this._t("actionCreate");
            MessageBox.confirm(sInfo, {
                title: this._t("dlgCreateTitle"),
                actions: [sCreate, MessageBox.Action.CLOSE],
                emphasizedAction: sCreate,
                onClose: (sAction) => {
                    if (sAction === sCreate) {
                        this._executeCreateRevision(sServiceCallId, sKeepActivityId, sOriginalCode, oSmartform);
                    }
                }
            });
        },

        /**
         * Execute the create-revision flow, then show success and refresh.
         */
        async _executeCreateRevision(sServiceCallId, sKeepActivityId, sOriginalCode, oSmartform) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/busy", true);
            try {
                const result = await RevisionService.createRevision(sServiceCallId, sKeepActivityId, sOriginalCode, oSmartform);
                const nextRev = result.nextRevisionNumber;
                const sfDesc = result.smartformDescription || "";

                // Refresh tables with new data before showing success.
                if (this._objectId) {
                    await this._loadRevisions(this._objectId);
                }

                MessageBox.success(
                    this._t("msgRevisionCreated", [nextRev, sfDesc]),
                    { title: this._t("dlgCreatedTitle") }
                );
            } catch (error) {
                console.error("Failed to create revision:", error.message);
                MessageBox.error(this._t("errCreating", [error.message]));
            } finally {
                oModel.setProperty("/busy", false);
            }
        },

        /**
         * Filter the smartform tables by description (case-insensitive substring).
         * Toggles each table's `visible` flag; empty query shows all.
         * @param {sap.ui.base.Event} oEvent
         */
        onSearchTables(oEvent) {
            const oModel = this.getView().getModel("view");
            const sQuery = (oEvent.getParameter("newValue") || oEvent.getParameter("query") || "").trim().toLowerCase();
            const aTables = oModel.getProperty("/tables") || [];

            aTables.forEach(t => {
                const desc = (t.smartformDescription || "").toLowerCase();
                const name = (t.smartformName || "").toLowerCase();
                t.visible = !sQuery || desc.indexOf(sQuery) !== -1 || name.indexOf(sQuery) !== -1;
            });

            oModel.setProperty("/tables", aTables);
            oModel.refresh(true);
        },

        /**
         * Expand or collapse all smartform tables at once.
         */
        onToggleExpandAll() {
            const oModel = this.getView().getModel("view");
            const bExpand = !oModel.getProperty("/allExpanded");
            const aTables = oModel.getProperty("/tables") || [];

            aTables.forEach(t => { t.expanded = bExpand; });

            oModel.setProperty("/tables", aTables);
            oModel.setProperty("/allExpanded", bExpand);
            oModel.refresh(true);
        }

    });
});