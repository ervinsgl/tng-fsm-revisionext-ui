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
         * Per-table Create Revision. Reads the pressed button's table context
         * to get that table's root smartform id, builds the next-revision
         * payload (SC + activity, same base for every table), and shows the
         * original smartform UUID + next revision number + payload.
         *
         * @param {sap.ui.base.Event} oEvent - button press event
         */
        async onCreateRevision(oEvent) {
            const oModel = this.getView().getModel("view");

            // The pressed button's binding context is the table object.
            const oCtx = oEvent.getSource().getBindingContext("view");
            const sRootSmartformId = oCtx ? oCtx.getProperty("rootSmartformId") : null;
            const oSmartform = oCtx ? {
                rootSmartformId: oCtx.getProperty("rootSmartformId"),
                lastSmartformId: oCtx.getProperty("lastSmartformId"),
                rootPruefberichtNr: oCtx.getProperty("rootPruefberichtNr")
            } : null;

            const sServiceCallId = oModel.getProperty("/originalServiceCallId");
            const sKeepActivityId = oModel.getProperty("/originalActivityId");
            const sOriginalCode = oModel.getProperty("/originalCode");

            if (!sServiceCallId) {
                MessageBox.warning("No ServiceCall found for the original activity.");
                return;
            }

            oModel.setProperty("/busy", true);
            try {
                const result = await RevisionService.getServiceCallTree(sServiceCallId, sKeepActivityId, sOriginalCode, oSmartform);
                const payload = result.payload || {};
                const nextRev = result.nextRevisionNumber;
                const smartformPayload = result.smartformPayload || [];

                const sText =
                    `Original smartform UUID: ${sRootSmartformId || "(unknown)"}\n` +
                    `Next revision number: ${nextRev != null ? nextRev : "(unknown)"}\n\n` +
                    `=== ServiceCall + Activity payload ===\n` +
                    JSON.stringify(payload, null, 2) +
                    `\n\n=== Smartform payload ===\n` +
                    JSON.stringify(smartformPayload, null, 2);

                MessageBox.information(sText, {
                    title: "Create Revision — New Revision Payload",
                    contentWidth: "40rem"
                });
            } catch (error) {
                console.error("Failed to build revision payload:", error.message);
                MessageBox.error("Failed to build the new revision payload: " + error.message);
            } finally {
                oModel.setProperty("/busy", false);
            }
        }

    });
});