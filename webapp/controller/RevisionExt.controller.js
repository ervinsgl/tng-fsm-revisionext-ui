sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "com/tng/fsm/revisionext/app/utils/ContextService",
    "com/tng/fsm/revisionext/app/utils/RevisionService"
], (Controller, JSONModel, MessageBox, MessageToast, ContextService, RevisionService) => {
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
                noSmartforms: false
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
         * Gather all selected rows across every smartform table and, for now,
         * show their Smartform Description + Activity Code. If nothing is
         * selected, prompt the user to select at least one row.
         */
        onCreateRevision() {
            const oContainer = this.byId("tablesContainer");
            const aTables = oContainer ? oContainer.getItems() : [];

            const aSelected = [];
            aTables.forEach(oTable => {
                if (!oTable.getSelectedItems) return; // not a table
                oTable.getSelectedItems().forEach(oItem => {
                    const oRow = oItem.getBindingContext("view").getObject();
                    aSelected.push({
                        smartformDescription: oRow.smartformDescription || "(no smartform)",
                        code: oRow.code || "(no code)",
                        revisionLabel: oRow.revisionLabel || ""
                    });
                });
            });

            if (aSelected.length === 0) {
                MessageToast.show("Select at least one row to create a revision.");
                return;
            }

            const sList = aSelected
                .map(s => `• ${s.revisionLabel} — Code ${s.code} — ${s.smartformDescription}`)
                .join("\n");

            MessageBox.information(
                `Selected ${aSelected.length} row(s) to create a revision for:\n\n${sList}`,
                { title: "Create Revision" }
            );
        }

    });
});