/**
 * RevisionService.js
 *
 * Frontend data-access module for the revision workflow. Owns all calls to
 * the app's backend /api/* routes (which proxy to FSM). Keeps HTTP/data
 * concerns out of controllers and out of ContextService (which only resolves
 * FSM context).
 *
 * As Phase A grows, revision-smartform / attachment fetches live here too.
 *
 * @file webapp/utils/RevisionService.js
 * @module com.tng.fsm.revisionext.app.utils.RevisionService
 */
sap.ui.define([], () => {
    "use strict";

    return {

        /**
         * Fetch closed ChecklistInstances (smartforms) for an Activity.
         * Source-agnostic: both context sources resolve the Activity UUID
         * into context.cloudId, which is passed here as objectId.
         *
         * @param {string} objectId - Activity UUID (context.cloudId)
         * @returns {Promise<Array<{id: string, description: string}>>}
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
         * Fetch the activity revision tree for an Activity: original first,
         * then revisions ordered by revision number ascending.
         *
         * @param {string} objectId - Activity UUID (context.cloudId)
         * @returns {Promise<Array<{isOriginal: boolean, revisionLabel: string, revisionNumber: number|null, id: string, code: string|null, subject: string|null}>>}
         */
        async getActivityRevisions(objectId) {
            if (!objectId) return [];

            const url = `/api/activity-revisions?objectId=${encodeURIComponent(objectId)}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Activity revisions HTTP ${response.status}`);

            const data = await response.json();
            return data.data || [];
        }

    };
});