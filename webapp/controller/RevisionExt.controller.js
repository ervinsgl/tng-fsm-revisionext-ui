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
                smartforms: []
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
                console.log(`Loaded ${smartforms.length} smartform(s) for ${objectId}`);
            } catch (error) {
                console.error("Failed to load smartforms:", error.message);
                oModel.setProperty("/smartforms", []);
            } finally {
                oModel.setProperty("/smartformsBusy", false);
            }
        }

    });
});