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
        }

    };
});