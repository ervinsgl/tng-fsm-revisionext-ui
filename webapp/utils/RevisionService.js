/**
 * RevisionService.js
 *
 * Frontend data-access module for the revision workflow. Owns all calls to
 * the app's backend /api/* routes (which proxy to FSM). Keeps HTTP/data
 * concerns out of controllers and out of ContextService (which only resolves
 * FSM context).
 *
 * Note: requests to /api/v1/* are augmented by the global fetch wrapper in
 * Component.js, which adds the `Authorization: Bearer <session token>` header
 * in the Web UI flow. That is why no auth header appears in this file.
 *
 * @file webapp/utils/RevisionService.js
 * @module com.tns.fsm.revisionext.app.utils.RevisionService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Fetch the activity revision tree reshaped into per-smartform tables.
         *
         * @param {string} objectId - Activity UUID (context.cloudId)
         * @returns {Promise<{activities: Array<Object>, tables: Array<Object>,
         *          originalServiceCallId?: string, originalActivityId?: string,
         *          originalCode?: string}>}
         *          `activities` = lineage rows (original first); `tables` = one per
         *          approved original smartform, each with rows, rootSmartformId,
         *          lastSmartformId, rootPruefberichtNr and nextRevisionNumber.
         * @throws {Error} on any non-2xx answer (e.g. 502 when the backend cannot
         *         build the view) — the caller shows the load-error strip.
         */
        async getActivityRevisions(objectId) {
            if (!objectId) return { activities: [], tables: [] };

            const url = `/api/v1/activity-revisions?objectId=${encodeURIComponent(objectId)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Activity revisions HTTP ${response.status}`);

            const data = await response.json();
            return data.data || { activities: [], tables: [] };
        },

        /**
         * Build the next-revision payload (SC + activity + smartform) from the
         * original ServiceCall and the pressed table's smartform. No writes —
         * used for the confirmation dialog.
         *
         * @param {string} serviceCallId - original activity's ServiceCall id
         * @param {string} keepActivityId - original activity id to retain
         * @param {string} originalCode - original activity code
         * @param {Object} [smartform] - { rootSmartformId, lastSmartformId, rootPruefberichtNr, nextRevisionNumber }
         * @returns {Promise<{payload: Object, nextRevisionNumber: number,
         *          smartformPayload: (Object|null), revisionCode: string,
         *          activityCode: string, serviceCallExists: boolean,
         *          activityExists: boolean}>}
         *          `smartformPayload` is ONE smartform object (or null), not an array.
         *          The backend also returns further fields the UI does not use.
         */
        async getServiceCallTree(serviceCallId, keepActivityId, originalCode, smartform) {
            if (!serviceCallId) throw new Error("No serviceCallId provided");

            let url = `/api/v1/service-call-tree?serviceCallId=${encodeURIComponent(serviceCallId)}`;
            if (keepActivityId) {
                url += `&keepActivityId=${encodeURIComponent(keepActivityId)}`;
            }
            if (originalCode) {
                url += `&originalCode=${encodeURIComponent(originalCode)}`;
            }
            if (smartform) {
                if (smartform.rootSmartformId) {
                    url += `&rootSmartformId=${encodeURIComponent(smartform.rootSmartformId)}`;
                }
                if (smartform.lastSmartformId) {
                    url += `&lastSmartformId=${encodeURIComponent(smartform.lastSmartformId)}`;
                }
                if (smartform.rootPruefberichtNr) {
                    url += `&rootPruefberichtNr=${encodeURIComponent(smartform.rootPruefberichtNr)}`;
                }
                if (smartform.nextRevisionNumber != null) {
                    url += `&nextRevisionNumber=${encodeURIComponent(smartform.nextRevisionNumber)}`;
                }
            }

            const response = await fetch(url);
            if (!response.ok) {
                let msg = `Service call tree HTTP ${response.status}`;
                try { const e = await response.json(); if (e && e.message) msg = e.message; } catch (ignore) { /* noop */ }
                throw new Error(msg);
            }

            const data = await response.json();
            return data.data || {};
        },

        /**
         * Execute the create-revision flow (SC create/append -> activity link ->
         * POST smartform -> PATCH original activity follow-up). Retry-safe on
         * the backend. Returns a summary.
         *
         * @param {string} serviceCallId - original activity's ServiceCall id
         * @param {string} keepActivityId - original activity id
         * @param {string} originalCode - original activity code
         * @param {Object} smartform - { rootSmartformId, lastSmartformId, rootPruefberichtNr, nextRevisionNumber }
         * @returns {Promise<{nextRevisionNumber: number, revisionCode: string,
         *          activityCode: string, smartformDescription: string,
         *          newActivityId: string, supportingPersonAdded: boolean,
         *          smartformExisted: boolean, followUpWritten: boolean}>}
         *          The UI uses nextRevisionNumber and smartformDescription; the
         *          other fields are informational.
         * @throws {Error} with the backend's bare error message (the controller
         *         adds the translated "Failed to create revision" prefix).
         */
        async createRevision(serviceCallId, keepActivityId, originalCode, smartform) {
            if (!serviceCallId) throw new Error("No serviceCallId provided");

            const response = await fetch("/api/v1/create-revision", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ serviceCallId, keepActivityId, originalCode, smartform })
            });
            if (!response.ok) {
                let msg = `Create revision HTTP ${response.status}`;
                try { const e = await response.json(); if (e && e.message) msg = e.message; } catch (ignore) { /* noop */ }
                throw new Error(msg);
            }
            const data = await response.json();
            return data.data || {};
        }

    };
});
