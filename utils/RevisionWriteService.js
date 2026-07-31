/**
 * RevisionWriteService.js
 *
 * The WRITE half of the FSM revision workflow. Builds the next-revision
 * payloads and executes the create flow: PATCH/POST the ServiceCall
 * composite-tree, POST the ChecklistInstance smartform, and PATCH the original
 * activity's follow-up links + the new activity's previousActivity.
 *
 * Collaborators:
 *   - FsmHttpClient   : all HTTP (query, composite-tree GET, request context)
 *   - fsmPayloadUtils : the stateless payload transforms
 *   - RevisionReadService : the three suffix-proof existence checks + the
 *                           fallback next-number computation
 *   - DestinationService  : base URL + company id for the revision deep-links
 *   - fsmConstants    : destination name, DTO versions, UDF ids, type codes
 *
 * @file utils/RevisionWriteService.js
 * @module utils/RevisionWriteService
 * @requires axios
 * @requires ./FsmHttpClient
 * @requires ./fsmPayloadUtils
 * @requires ./RevisionReadService
 * @requires ./DestinationService
 * @requires ./fsmConstants
 */
'use strict';

const axios = require('axios');
const fsmHttp = require('./FsmHttpClient');
const payloadUtils = require('./fsmPayloadUtils');
const readSvc = require('./RevisionReadService');
const DestinationService = require('./DestinationService');
const { DESTINATION_NAME, FSM_ACCOUNT_DEFAULTS, DTO, UDF, TYPE } = require('./fsmConstants');

class RevisionWriteService {

    // ─────────────────────────────────────────────────────────────────
    //  SMARTFORM PAYLOAD BUILDERS
    // ─────────────────────────────────────────────────────────────────

    /**
     * Fetch the full ChecklistInstance DTO for a smartform id. Used to copy
     * template/language/content/etc. into a new revision's smartform payload.
     * @param {string} smartformId
     * @returns {Promise<Object|null>} the raw w object, or null
     * @private
     */
    async _getChecklistInstanceFull(smartformId) {
        const query = `SELECT w FROM ChecklistInstance w WHERE w.id = '${smartformId}'`;
        const data = await fsmHttp.makeQueryRequest(query, DTO.CHECKLIST_INSTANCE);
        if (!data.data || data.data.length === 0) return null;
        return data.data[0].w || null;
    }

    /**
     * Assemble the new-revision smartform payload (single-element array). Copies
     * the original (root) smartform's fields, prefixes the description with
     * "Revision - <N>: ", links Z_PreviousChecklist to the last smartform in the
     * table (or the original), sets Z_PruefberichtNr from the original, and
     * attaches a fresh checklistId. object.objectId is a placeholder for the new
     * activity (filled in once the activity is actually created).
     *
     * @param {string} rootSmartformId - original (root) smartform id for the table
     * @param {string} previousChecklistId - last smartform in the table (Z_PreviousChecklist)
     * @param {string|null} pruefberichtNr - original smartform's Z_PruefberichtNr
     * @param {number} nextRevisionNumber - last revision number + 1
     * @param {string|null} activityObjectId - existing revision activity id, or null
     * @returns {Promise<Array>} single-element smartform payload array
     * @private
     */
    async _buildRevisionSmartformPayload(rootSmartformId, previousChecklistId, pruefberichtNr, nextRevisionNumber, activityObjectId) {
        const root = await this._getChecklistInstanceFull(rootSmartformId);
        if (!root) return [];

        const n = nextRevisionNumber;
        const baseDescription = (root.description && root.description.trim()) ? root.description.trim() : '';

        return [{
            template: root.template || null,
            description: `Revision - ${n}: ${baseDescription}`,
            language: root.language || null,
            mandatory: true,
            content: root.content || null,
            inactive: false,
            createPerson: root.createPerson || null,
            version: root.version != null ? root.version : null,
            responsiblePerson: root.responsiblePerson || null,
            closed: false,
            udfValues: [
                { meta: { externalId: UDF.PREVIOUS_CHECKLIST }, value: previousChecklistId || rootSmartformId },
                { meta: { externalId: UDF.PRUEFBERICHT_NR }, value: pruefberichtNr != null ? pruefberichtNr : '' }
            ],
            checklistId: payloadUtils.uuidV4(),
            syncStatus: 'IN_CLOUD',
            object: {
                // Existing revision activity id (smartform attaches to it) or the
                // placeholder, set once the activity is created.
                objectId: activityObjectId || '<NEW_ACTIVITY_UUID>',
                objectType: 'ACTIVITY'
            }
        }];
    }

    // ─────────────────────────────────────────────────────────────────
    //  PAYLOAD ASSEMBLY
    // ─────────────────────────────────────────────────────────────────

    /**
     * Build the new-revision ServiceCall payload for the activity in context.
     * Fetches the original's ServiceCall composite tree, keeps the original
     * activity segment, and transforms the header for the NEXT revision.
     *
     * If smartform inputs are supplied (rootSmartformId etc.), the matching
     * new-revision smartform payload is assembled and returned too.
     *
     * @param {string} originalServiceCallId - original activity's ServiceCall id
     * @param {string} originalActivityId - original activity id (segment to keep)
     * @param {string} originalCode - original activity code (e.g. '19846')
     * @param {Object} [smartform] - { rootSmartformId, lastSmartformId, rootPruefberichtNr, nextRevisionNumber }
     * @returns {Promise<Object>}
     */
    async buildNewRevisionPayload(originalServiceCallId, originalActivityId, originalCode, smartform) {
        // Per-table next revision number = (revision rows in this table) + 1,
        // computed during table building and passed in here. Counting is
        // per smartform lineage, not global to the original activity.
        let nextRevisionNumber = (smartform && smartform.nextRevisionNumber != null)
            ? parseInt(smartform.nextRevisionNumber, 10)
            : null;

        // Fallback (no per-table value supplied): global max + 1.
        if (nextRevisionNumber == null || isNaN(nextRevisionNumber)) {
            const scNumberMap = await readSvc.getRevisionServiceCalls(originalCode);
            let maxNum = 0;
            scNumberMap.forEach(num => { if (num != null && num > maxNum) maxNum = num; });
            nextRevisionNumber = maxNum + 1;
        }

        // Link parts (base URL + company id) for the activity's revision link.
        const destination = await DestinationService.getDestination(DESTINATION_NAME);
        const dcfg = destination.destinationConfiguration;
        const baseUrl = dcfg.URL || '';
        const companyId = dcfg['URL.headers.X-Company-ID'] || '';

        const tree = await fsmHttp.getServiceCallCompositeTree(originalServiceCallId, originalActivityId);

        // Revision ServiceCall code = ORIGINAL ServiceCall code + ORIGINAL
        // activity code + suffix (e.g. '8200008332-33219-Rev-001'). Embedding
        // the activity code makes the SC code unique per original activity, so
        // two activities under the same parent SC no longer collide on
        // '<sc>-Rev-NNN' (was CA-202: duplicate SC code). One SC + one activity
        // per original activity per revision level. Existence is checked via
        // revision UDFs below (suffix-proof), not this code.
        const padded = String(nextRevisionNumber).padStart(3, '0');
        const baseScCode = tree.code != null ? tree.code : originalCode;
        const revisionCode = `${baseScCode}-${originalCode}-Rev-${padded}`;
        // Suffix-proof existence check by revision UDFs (NOT bare code): FSM
        // auto-suffixes duplicate SC codes, so a code match would never find the
        // SC we just created and we'd create a new one every time.
        const existingServiceCallId = await readSvc.getServiceCallIdByRevision(originalCode, nextRevisionNumber);

        // Revision activity code = original activity code + same suffix
        // (e.g. '19846-Rev-003'). One activity per revision level; check if it
        // already exists (attach smartforms to it) or must be created. Matched
        // via its ServiceCall (object.objectId), which is suffix-proof.
        const activityCode = `${originalCode}-Rev-${padded}`;
        const existingActivityId = await readSvc.getRevisionActivityId(originalActivityId, existingServiceCallId);

        // Header transform (id = existing SC id or null).
        payloadUtils.transformRevisionHeader(tree, originalCode, nextRevisionNumber, existingServiceCallId);

        // Capture the original activity's Z_FollowUpRevisions BEFORE the
        // transform strips it (the activity transform removes this UDF).
        let existingFollowUps = null;
        if (Array.isArray(tree.activities)) {
            const origAct = tree.activities.find(a => a && a.id === originalActivityId) || tree.activities[0];
            if (origAct) existingFollowUps = payloadUtils.udfCompositeTree(origAct, UDF.FOLLOW_UP_REVISIONS);
        }

        // Activity transform: code = revision code, id = existing activity id
        // (append smartforms) or null (create).
        if (Array.isArray(tree.activities)) {
            tree.activities = tree.activities.map(act =>
                payloadUtils.transformRevisionActivity(act, originalActivityId, originalCode, nextRevisionNumber, baseUrl, companyId, activityCode, existingActivityId)
            );
        }

        // Smartform payload (per the table whose button was pressed). The
        // smartform attaches to the existing revision activity if present;
        // otherwise to the placeholder (filled once the activity is created).
        // FSM POST ChecklistInstance takes the object directly (no array wrap).
        let smartformPayload = null;
        if (smartform && smartform.rootSmartformId) {
            const arr = await this._buildRevisionSmartformPayload(
                smartform.rootSmartformId,
                smartform.lastSmartformId,
                smartform.rootPruefberichtNr,
                nextRevisionNumber,
                existingActivityId
            );
            smartformPayload = (arr && arr.length) ? arr[0] : null;
            if (smartformPayload) payloadUtils.stripNulls(smartformPayload);
        }

        // Follow-up revisions PATCH payload for the ORIGINAL activity: ONLY when
        // a NEW revision activity is created (not when attaching a smartform to
        // an existing revision activity — that would duplicate the line).
        const followUpPayload = existingActivityId
            ? null
            : payloadUtils.buildFollowUpRevisionsPayload(existingFollowUps, originalCode, nextRevisionNumber, baseUrl, companyId);

        // FSM requires exactly one of id/code/externalId on reference objects.
        // Reduce them (prefer id, then externalId, then code) before stripping
        // nulls (reduction may itself leave a single non-null key).
        payloadUtils.reduceIdentifierRefs(tree);

        // FSM rejects explicit nulls on create (Object.toString() on null).
        // Strip every null key/value pair from the SC payload. On the create
        // branch this also removes the (now-null) id, leaving the key absent.
        payloadUtils.stripNulls(tree);

        return {
            payload: tree,
            nextRevisionNumber,
            smartformPayload,
            serviceCallExists: !!existingServiceCallId,
            existingServiceCallId: existingServiceCallId || null,
            activityExists: !!existingActivityId,
            existingActivityId: existingActivityId || null,
            activityCode,
            revisionCode,
            followUpPayload,
            originalActivityId,
            originalServiceCallId,
            companyId,
            account: dcfg.account || FSM_ACCOUNT_DEFAULTS.account
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  WRITE HTTP HELPERS
    // ─────────────────────────────────────────────────────────────────

    /**
     * PATCH (append) or POST (create) a ServiceCall composite-tree. Returns the
     * response body (the saved tree, with real ids on created entities).
     * @param {Object} payload - the transformed SC tree
     * @param {string|null} serviceCallId - existing SC id (append) or null (create)
     * @returns {Promise<Object>} saved composite tree
     * @private
     */
    async _patchServiceCallCompositeTree(payload, serviceCallId) {
        const ctx = await fsmHttp.getRequestContext();
        const headers = { ...ctx.headers, 'X-Create-Or-Update': 'true' };

        // Create (no existing id) -> POST to the collection (no forceUpdate).
        // Update (existing id)    -> PATCH to that resource (with forceUpdate).
        const isUpdate = !!serviceCallId;
        const url = isUpdate
            ? `${ctx.baseUrl}/api/fsm-connector/v1/composite-tree/service-calls/${serviceCallId}`
            : `${ctx.baseUrl}/api/fsm-connector/v1/composite-tree/service-calls`;
        const method = isUpdate ? 'patch' : 'post';
        const params = isUpdate
            ? { ...ctx.params, forceUpdate: true }
            : { ...ctx.params };

        try {
            const response = await axios.request({ method, url, data: payload, params, headers });
            return response.data || {};
        } catch (error) {
            console.error(`[createRevision] SC ${method.toUpperCase()} FAILED status=${error.response?.status} url=${url} body=${JSON.stringify(error.response?.data || error.message)}`);
            throw error;
        }
    }

    /**
     * POST a new ChecklistInstance (smartform).
     * @param {Object} payload - the smartform object
     * @returns {Promise<Object>} created smartform
     * @private
     */
    async _postChecklistInstance(payload) {
        const ctx = await fsmHttp.getRequestContext();
        const url = `${ctx.baseUrl}/api/data/v4/ChecklistInstance`;
        const params = { ...ctx.params, dtos: DTO.CHECKLIST_INSTANCE };
        try {
            const response = await axios.post(url, payload, { params, headers: ctx.headers });
            return response.data || {};
        } catch (error) {
            console.error(`[createRevision] Smartform POST FAILED status=${error.response?.status} url=${url} body=${JSON.stringify(error.response?.data || error.message)}`);
            throw error;
        }
    }

    /**
     * PATCH an Activity (used to set previousActivity / Z_Activity_Type on the
     * new revision activity, and to update the original's Z_FollowUpRevisions).
     * @param {string} activityId
     * @param {Object} payload
     * @returns {Promise<Object>}
     * @private
     */
    async _patchActivity(activityId, payload) {
        const ctx = await fsmHttp.getRequestContext();
        const url = `${ctx.baseUrl}/api/data/v4/Activity/${activityId}`;
        const params = { ...ctx.params, dtos: DTO.ACTIVITY, forceUpdate: true };
        try {
            const response = await axios.patch(url, payload, { params, headers: ctx.headers });
            return response.data || {};
        } catch (error) {
            console.error(`[createRevision] Activity PATCH FAILED status=${error.response?.status} url=${url} body=${JSON.stringify(error.response?.data || error.message)}`);
            throw error;
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  CREATE FLOW
    // ─────────────────────────────────────────────────────────────────

    /**
     * Execute the full create-revision flow:
     *   1) PATCH/POST the ServiceCall composite-tree (create or append).
     *   2) Resolve the revision activity's real id (known on append; found by
     *      assembled code in the response on create).
     *   2b) On create, PATCH the new activity to persist previousActivity +
     *      Z_Activity_Type (composite-tree create does not persist these).
     *   3) POST the smartform with object.objectId = that activity id.
     *   4) On create, PATCH the original activity's Z_FollowUpRevisions with the
     *      real activity link substituted.
     *
     * The payload is rebuilt fresh here so the revision number / existence
     * checks reflect current FSM state at execution time.
     *
     * @returns {Promise<Object>} { nextRevisionNumber, revisionCode, activityCode, smartformDescription, newActivityId }
     */
    async createRevision(originalServiceCallId, originalActivityId, originalCode, smartform) {
        const built = await this.buildNewRevisionPayload(originalServiceCallId, originalActivityId, originalCode, smartform);
        const {
            payload, smartformPayload, followUpPayload,
            existingServiceCallId, activityCode, revisionCode, nextRevisionNumber
        } = built;

        // 1) PATCH/POST ServiceCall (create or append).
        const savedTree = await this._patchServiceCallCompositeTree(payload, existingServiceCallId);

        // 2) Resolve the revision activity's real id.
        //    Append case: we already know it (existingActivityId).
        //    Create case: find it in the response by its assembled code.
        let newActivityId = built.existingActivityId || null;
        if (!newActivityId) {
            const savedActivities = Array.isArray(savedTree.activities) ? savedTree.activities : [];
            const savedActivity = savedActivities.find(a => a && a.code === activityCode);
            newActivityId = savedActivity ? savedActivity.id : null;
        }
        if (!newActivityId) {
            throw new Error(`Revision activity (code ${activityCode}) not found in ServiceCall response.`);
        }

        // 2b) composite-tree create does NOT persist previousActivity on a new
        //     child activity, so the read pipeline (which filters on it) won't
        //     find the revision. Set it via a direct Activity PATCH. Only needed
        //     when the activity was newly created (existing ones already link).
        if (!built.existingActivityId) {
            const linkPayload = {
                previousActivity: originalActivityId,
                udfValues: [
                    { meta: { externalId: UDF.ACTIVITY_TYPE }, value: TYPE.ACTIVITY_REVISION }
                ]
            };
            await this._patchActivity(newActivityId, linkPayload);
        }

        // 3) POST smartform, with object.objectId = the real activity id.
        let smartformDescription = '';
        if (smartformPayload) {
            if (smartformPayload.object) smartformPayload.object.objectId = newActivityId;
            smartformDescription = smartformPayload.description || '';
            await this._postChecklistInstance(smartformPayload);
        }

        // 4) PATCH original activity's Z_FollowUpRevisions (only when new activity).
        if (followUpPayload) {
            // Substitute the placeholder link with the real activity id.
            (followUpPayload.udfValues || []).forEach(u => {
                if (u && typeof u.value === 'string') {
                    u.value = u.value.split('<NEW_ACTIVITY_UUID>').join(newActivityId);
                }
            });
            await this._patchActivity(originalActivityId, followUpPayload);
        }

        return {
            nextRevisionNumber,
            revisionCode,
            activityCode,
            smartformDescription,
            newActivityId
        };
    }
}

module.exports = new RevisionWriteService();