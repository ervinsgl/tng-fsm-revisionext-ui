sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "com/tng/fsm/revisionext/app/utils/ContextService"
], (Controller, JSONModel, ContextService) => {
    "use strict";

    return Controller.extend("com.tng.fsm.revisionext.app.controller.RevisionExt", {
 
        onInit() {
            this.getView().setModel(new JSONModel({
                busy: true,
                contextLoaded: false,
                showError: false,
                context: {}
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
 
            } catch (error) {
                console.warn("FSM context not available:", error.message);
                oModel.setProperty("/showError", true);
                oModel.setProperty("/busy", false);
            }
        }
 
    });
});