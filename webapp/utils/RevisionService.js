/**
 * RevisionService.js
 *
 * Frontend data-access module for the revision workflow. Owns all calls to
 * the app's backend /api/* routes (which proxy to FSM). Keeps HTTP/data
 * concerns out of controllers and out of ContextService (which only resolves
 * FSM context).
 *
 * @file webapp/utils/RevisionService.js
 * @module com.tng.fsm.revisionext.app.utils.RevisionService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Fetch closed ChecklistInstances (smartforms) for an Activity.
         * @param {string} objectId - Activity UUID (context.cloudId)
         * @returns {Promise<Array<{id: string, description: string, name: string}>>}
         */
        async getChecklistInstances(objectId) {
            if (!objectId) return [];

            const url = `/api/checklist-instances?objectId=${encodeURIComponent(objectId)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Checklist instances HTTP ${response.status}`);

            const data = await response.json();
            return data.data || [];
        },

        /**
         * Fetch the activity revision tree reshaped into per-smartform tables.
         * Returns { activities, tables } where each table has activity-lineage
         * rows with smartform data on the original row.
         *
         * @param {string} objectId - Activity UUID (context.cloudId)
         * @returns {Promise<{activities: Array<Object>, tables: Array<Object>}>}
         */
        async getActivityRevisions(objectId) {
            if (!objectId) return { activities: [], tables: [] };

            const url = `/api/activity-revisions?objectId=${encodeURIComponent(objectId)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Activity revisions HTTP ${response.status}`);

            const data = await response.json();
            return data.data || { activities: [], tables: [] };
        },

        /**
         * Build the next-revision payload (SC + activity + smartform) from the
         * original ServiceCall and the pressed table's smartform.
         *
         * @param {string} serviceCallId - original activity's ServiceCall id
         * @param {string} keepActivityId - original activity id to retain
         * @param {string} originalCode - original activity code
         * @param {Object} [smartform] - { rootSmartformId, lastSmartformId, rootPruefberichtNr }
         * @returns {Promise<{payload: Object, nextRevisionNumber: number, smartformPayload: Array}>}
         */
        async getServiceCallTree(serviceCallId, keepActivityId, originalCode, smartform) {
            if (!serviceCallId) throw new Error("No serviceCallId provided");

            let url = `/api/service-call-tree?serviceCallId=${encodeURIComponent(serviceCallId)}`;
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
            if (!response.ok) throw new Error(`Service call tree HTTP ${response.status}`);

            const data = await response.json();
            return data.data || {};
        },

        /**
         * Execute the create-revision flow (PATCH SC -> POST smartform -> PATCH
         * original activity follow-up). Returns a summary.
         *
         * @param {string} serviceCallId - original activity's ServiceCall id
         * @param {string} keepActivityId - original activity id
         * @param {string} originalCode - original activity code
         * @param {Object} smartform - { rootSmartformId, lastSmartformId, rootPruefberichtNr, nextRevisionNumber }
         * @returns {Promise<Object>} { nextRevisionNumber, revisionCode, activityCode, smartformDescription, newActivityId }
         */
        async createRevision(serviceCallId, keepActivityId, originalCode, smartform) {
            if (!serviceCallId) throw new Error("No serviceCallId provided");

            const response = await fetch("/api/create-revision", {
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