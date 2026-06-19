sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "com/tng/fsm/revisionext/app/utils/ContextService",
    "com/tng/fsm/revisionext/app/utils/RevisionService"
], (Controller, JSONModel, MessageBox, ContextService, RevisionService) => {
    "use strict";

    return Controller.extend("com.tng.fsm.revisionext.app.controller.RevisionExt", {

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

        async _loadContext() {
            const oModel = this.getView().getModel("view");

            try {
                const context = await ContextService.getContext();

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

                oModel.setProperty("/activities", activities);
                oModel.setProperty("/tables", tables);
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
                MessageBox.warning("No ServiceCall found for the original activity.");
                return;
            }

            // Build the preview (basic info for the confirmation dialog).
            oModel.setProperty("/busy", true);
            let preview;
            try {
                preview = await RevisionService.getServiceCallTree(sServiceCallId, sKeepActivityId, sOriginalCode, oSmartform);
            } catch (error) {
                console.error("Failed to build revision preview:", error.message);
                MessageBox.error("Failed to prepare the revision: " + error.message);
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
                `Next revision number: ${nextRev != null ? nextRev : "(unknown)"}\n` +
                `Revision ServiceCall: ${revisionCode} ` +
                `(${scExists ? "EXISTS — activity will be appended" : "NEW — will be created"})\n` +
                `Revision Activity: ${activityCode} ` +
                `(${actExists ? "EXISTS — smartform attached" : "NEW — will be created"})\n` +
                `Smartform description: ${smartformDescription}`;

            MessageBox.confirm(sInfo, {
                title: "Create Revision",
                actions: ["Create", MessageBox.Action.CLOSE],
                emphasizedAction: "Create",
                onClose: (sAction) => {
                    if (sAction === "Create") {
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
                    `Revision number ${nextRev} made for smartform '${sfDesc}'.`,
                    { title: "Revision Created" }
                );
            } catch (error) {
                console.error("Failed to create revision:", error.message);
                MessageBox.error("Failed to create revision: " + error.message);
            } finally {
                oModel.setProperty("/busy", false);
            }
        }

    });
});