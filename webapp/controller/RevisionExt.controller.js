sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "com/tng/fsm/revisionext/app/utils/ContextService",
    "com/tng/fsm/revisionext/app/utils/RevisionService"
], (Controller, JSONModel, ContextService, RevisionService) => {
    "use strict";

    return Controller.extend("com.tng.fsm.revisionext.app.controller.RevisionExt", {

        onInit() {
            this.getView().setModel(new JSONModel({
                busy: true,
                contextLoaded: false,
                showError: false,
                context: {},
                smartformsBusy: false,
                smartforms: [],
                rows: [],
                revisionsBusy: false,
                revisionRows: []
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

                // Once we have the Activity UUID (cloudId), load its smartforms.
                this._loadSmartforms(context.cloudId);

                // Also load the activity revision tree for this activity.
                this._loadRevisions(context.cloudId);

            } catch (error) {
                console.warn("FSM context not available:", error.message);
                oModel.setProperty("/showError", true);
                oModel.setProperty("/busy", false);
            }
        },

        async _loadSmartforms(objectId) {
            const oModel = this.getView().getModel("view");

            if (!objectId) {
                console.warn("No objectId in context; skipping smartform load.");
                return;
            }

            oModel.setProperty("/smartformsBusy", true);

            try {
                const smartforms = await RevisionService.getChecklistInstances(objectId);
                oModel.setProperty("/smartforms", smartforms);
                oModel.setProperty("/rows", this._toTableRows(smartforms));
                console.log(`Loaded ${smartforms.length} smartform(s) for ${objectId}`);
            } catch (error) {
                console.error("Failed to load smartforms:", error.message);
                oModel.setProperty("/smartforms", []);
                oModel.setProperty("/rows", []);
            } finally {
                oModel.setProperty("/smartformsBusy", false);
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
                const revisionRows = await RevisionService.getActivityRevisions(objectId);
                oModel.setProperty("/revisionRows", revisionRows);
                console.log(`Loaded ${revisionRows.length} revision row(s) for ${objectId}`);
            } catch (error) {
                console.error("Failed to load revisions:", error.message);
                oModel.setProperty("/revisionRows", []);
            } finally {
                oModel.setProperty("/revisionsBusy", false);
            }
        },

        /**
         * Flatten smartforms (each with N attachments) into table rows.
         * One row per attachment; a smartform with no attachments still
         * produces one row with empty attachment cells.
         *
         * Columns:
         *   smartformDescription - ChecklistInstance description (done)
         *   smartformName        - ChecklistTemplate name (done)
         *   attachmentDescription- Attachment UDF Z_Attachment_Description (TODO, empty)
         *   attachmentName       - Attachment fileName (done)
         *   revisionName         - revision/report name (TODO, empty)
         */
        _toTableRows(smartforms) {
            const rows = [];
            (smartforms || []).forEach(sf => {
                const atts = sf.attachments || [];
                if (atts.length === 0) {
                    rows.push({
                        smartformDescription: sf.description || "",
                        smartformName: sf.name || "",
                        attachmentDescription: "",
                        attachmentName: "",
                        revisionName: ""
                    });
                    return;
                }
                atts.forEach(att => {
                    rows.push({
                        smartformDescription: sf.description || "",
                        smartformName: sf.name || "",
                        attachmentDescription: "",
                        attachmentName: att.fileName || "",
                        revisionName: ""
                    });
                });
            });
            return rows;
        }

    });
});