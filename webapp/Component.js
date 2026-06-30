sap.ui.define([
    "sap/ui/core/UIComponent",
    "com/tng/fsm/revisionext/app/model/models"
], (UIComponent, models) => {
    "use strict";

    return UIComponent.extend("com.tng.fsm.revisionext.app.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // Install a global fetch wrapper that attaches the FSM Web UI
            // session token (Bearer) to every /api/v1/* request. The token is
            // set on window.__fsmSessionToken by ContextService after the Shell
            // session-init succeeds. Mobile flow uses the cookie instead and is
            // unaffected (no token present -> no header added).
            this._installAuthFetch();

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // enable routing
            this.getRouter().initialize();
        },

        /**
         * Wrap window.fetch once so /api/v1/* requests carry the Bearer session
         * token when one is present. Idempotent: guarded by a flag so repeated
         * Component inits (e.g. in tests) don't stack wrappers.
         * @private
         */
        _installAuthFetch() {
            if (window.__fsmAuthFetchInstalled) {
                return;
            }
            window.__fsmAuthFetchInstalled = true;

            const originalFetch = window.fetch.bind(window);
            window.fetch = function (resource, init) {
                const url = (typeof resource === "string") ? resource : (resource && resource.url) || "";
                const token = window.__fsmSessionToken;
                if (token && url.indexOf("/api/v1/") !== -1) {
                    init = init || {};
                    const headers = new Headers(init.headers || {});
                    if (!headers.has("Authorization")) {
                        headers.set("Authorization", "Bearer " + token);
                    }
                    init.headers = headers;
                }
                return originalFetch(resource, init);
            };
        }
    });
});