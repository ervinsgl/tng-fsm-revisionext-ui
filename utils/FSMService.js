/**
 * FSMService.js
 *
 * Backend service for SAP FSM (Field Service Management) API integration.
 *
 * Scope (revision extension):
 * - Authenticated Query API requests (/api/query/v1)
 * - Read closed ChecklistInstances (smartforms) for an Activity, enrich each
 *   with its ChecklistTemplate name, filter to those tagged "Inspection", and
 *   attach their Attachment file names.
 *
 * Query chain (no CoreSQL joins; JS glue between sequential HTTP queries,
 * using IN clauses with deduplicated, batched IDs - no per-row looping):
 *   1. ChecklistInstance  WHERE object.objectId = <activity> AND closed = true
 *   2. ChecklistTemplate  WHERE id IN (<distinct template ids>)   -> name, tags
 *   3. ChecklistTag       WHERE id IN (<distinct tag ids>)        -> name
 *   --> keep only instances whose template carries the "Inspection" tag
 *   4. Attachment         WHERE sourceObject.objectId IN (<surviving ids>)
 *
 * The outbound destination name is defined ONCE below (DESTINATION_NAME).
 * If the destination ever changes, change it in that single place.
 *
 * @file FSMService.js
 * @module utils/FSMService
 * @requires axios
 * @requires ./DestinationService
 * @requires ./TokenCache
 */
const axios = require('axios');
const DestinationService = require('./DestinationService');
const TokenCache = require('./TokenCache');

/**
 * The single BTP destination used for all outbound FSM calls in this app.
 * Change here only.
 * @type {string}
 */
const DESTINATION_NAME = 'FSM_S4E';

/**
 * The tag name a smartform's template must carry to be shown.
 * @type {string}
 */
const REQUIRED_TAG = 'Inspection';

class FSMService {
    constructor() {
        /**
         * Default FSM account/company configuration.
         * Used as a fallback when the destination does not carry these values.
         * @type {{account: string, company: string}}
         */
        this.config = {
            account: 'TUEV-NORD_T1',
            company: 'TUEV-NORD_S4E'
        };
    }

    /**
     * Make a Query API request (/api/query/v1).
     * @param {string} query - FSM CoreSQL query string
     * @param {string} dtos  - DTO version string (e.g. 'ChecklistInstance.20')
     * @returns {Promise<Object>} API response data ({ data: [...] })
     * @throws {Error} If the request fails
     */
    async makeQueryRequest(query, dtos) {
        try {
            const destination = await DestinationService.getDestination(DESTINATION_NAME);
            const token = await TokenCache.getToken(destination);

            const config = destination.destinationConfiguration;
            const baseUrl = config.URL;
            const queryUrl = `${baseUrl}/api/query/v1`;

            const queryParams = {
                query,
                dtos,
                account: config.account || this.config.account,
                company: config.company || this.config.company
            };

            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                'X-Account-ID': config['URL.headers.X-Account-ID'],
                'X-Company-ID': config['URL.headers.X-Company-ID'],
                'X-Client-ID': config['URL.headers.X-Client-ID'],
                'X-Client-Version': config['URL.headers.X-Client-Version']
            };

            const response = await axios.get(queryUrl, { params: queryParams, headers });
            return response.data;

        } catch (error) {
            console.error('FSMService: Query API Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Read a UDF value from a composite-tree DTO's udfValues array.
     * Composite-tree shape differs from the Query API: each entry is
     * { udfMeta: { externalId }, value } rather than { name, value }.
     * @param {Object} dto - object carrying udfValues
     * @param {string} externalId - e.g. 'Z_Activity_Type'
     * @returns {string|null}
     * @private
     */
    _udfCompositeTree(dto, externalId) {
        const vals = (dto && dto.udfValues) || [];
        const hit = vals.find(u => u && u.udfMeta && u.udfMeta.externalId === externalId);
        return hit && hit.value != null ? hit.value : null;
    }

    /**
     * Fetch the full composite-tree of a ServiceCall, then keep only the
     * activity segment whose id matches keepActivityId (the original activity).
     * All other activities under the ServiceCall are dropped.
     *
     * @param {string} serviceCallId - ServiceCall to fetch (original's object.objectId)
     * @param {string} [keepActivityId] - Activity id to retain; if omitted, no filter
     * @returns {Promise<Object>} the composite-tree object with activities filtered
     * @throws {Error} on request failure
     */
    async getServiceCallCompositeTree(serviceCallId, keepActivityId) {
        const destination = await DestinationService.getDestination(DESTINATION_NAME);
        const token = await TokenCache.getToken(destination);

        const config = destination.destinationConfiguration;
        const baseUrl = config.URL;
        const url = `${baseUrl}/api/fsm-connector/v1/composite-tree/service-calls/${serviceCallId}`;

        const params = {
            account: config.account || this.config.account,
            company: config.company || this.config.company
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Account-ID': config['URL.headers.X-Account-ID'],
            'X-Company-ID': config['URL.headers.X-Company-ID'],
            'X-Client-ID': config['URL.headers.X-Client-ID'],
            'X-Client-Version': config['URL.headers.X-Client-Version']
        };

        try {
            const response = await axios.get(url, { params, headers });
            const tree = response.data || {};

            // Keep only the activity segment matching the original activity id.
            if (keepActivityId && Array.isArray(tree.activities)) {
                tree.activities = tree.activities.filter(act => act && act.id === keepActivityId);
            }
            return tree;
        } catch (error) {
            console.error('FSMService: Composite-tree Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Upsert a UDF (by externalId) in a composite-tree udfValues array.
     * If a UDF with the externalId exists, its value is updated (udfMeta.id
     * preserved). Otherwise a new entry { udfMeta: { externalId }, value } is
     * pushed. Mutates and returns the array.
     * @param {Array} udfValues
     * @param {string} externalId
     * @param {string} value
     * @returns {Array} the (mutated) udfValues
     * @private
     */
    _upsertCompositeUdf(udfValues, externalId, value) {
        const arr = Array.isArray(udfValues) ? udfValues : [];
        const existing = arr.find(u => u && u.udfMeta && u.udfMeta.externalId === externalId);
        if (existing) {
            existing.value = value; // keep existing udfMeta.id
        } else {
            arr.push({ udfMeta: { externalId }, value });
        }
        return arr;
    }

    /**
     * Transform a fetched ServiceCall composite-tree into the payload for a
     * NEW revision's ServiceCall header. Mutates the header in place:
     *   - id -> null
     *   - code -> `<code>-Rev-<NNN>` (N = nextRevisionNumber, NNN zero-padded to 3)
     *   - subject -> `<originalCode> Rev-<N>`
     *   - remove transient/child fields
     *   - upsert Z_RevisionOfActivity = originalCode, Z_revisionNumber = N
     * Activity segment is transformed later (separate step).
     *
     * @param {Object} tree - the (activity-filtered) composite tree
     * @param {string} originalCode - original activity code (e.g. '19846')
     * @param {number} nextRevisionNumber - last revision number + 1
     * @param {string|null} existingServiceCallId - id of the revision SC if it
     *        already exists (PATCH appends to it); null to create a new SC.
     * @returns {Object} the mutated tree
     * @private
     */
    _transformRevisionHeader(tree, originalCode, nextRevisionNumber, existingServiceCallId) {
        if (!tree || typeof tree !== 'object') return tree;

        const n = nextRevisionNumber;
        const padded = String(n).padStart(3, '0'); // 4 -> '004', max 999

        // id: existing SC id (append) or null (create). PATCH composite-tree
        // with X-Create-Or-Update branches on this.
        tree.id = existingServiceCallId || null;
        if (tree.code != null) {
            tree.code = `${tree.code}-Rev-${padded}`;
        }
        tree.subject = `${originalCode} Rev-${n}`;
        // externalId belongs to the original SC; the revision SC must not carry it.
        delete tree.externalId;

        // Remove transient / child-collection fields not wanted on the new header.
        ['lastChanged', 'chargeableEfforts', 'chargeableExpenses',
         'chargeableMaterials', 'chargeableMileages', 'createPerson',
         'resolution', 'reservedMaterials', 'attachments', 'requirements',
         'serviceContract'
        ].forEach(f => { delete tree[f]; });

        // Upsert the two revision UDFs.
        tree.udfValues = this._upsertCompositeUdf(tree.udfValues, 'Z_RevisionOfActivity', String(originalCode));
        tree.udfValues = this._upsertCompositeUdf(tree.udfValues, 'Z_revisionNumber', String(n));

        return tree;
    }

    /**
     * Remove UDFs (by externalId) from a composite-tree udfValues array.
     * Mutates and returns the array.
     * @param {Array} udfValues
     * @param {Array<string>} externalIds
     * @returns {Array}
     * @private
     */
    _removeCompositeUdfs(udfValues, externalIds) {
        if (!Array.isArray(udfValues)) return udfValues;
        const drop = new Set(externalIds);
        return udfValues.filter(u =>
            !(u && u.udfMeta && drop.has(u.udfMeta.externalId))
        );
    }

    /**
     * Transform the original activity segment into the NEW revision's activity.
     * Mutates the activity in place:
     *   - id / code / externalId -> null
     *   - subject -> `<originalCode> Rev-<N>` + bracketed attribute suffix
     *   - attachments -> null
     *   - remove transient/child fields
     *   - upsert Z_UpdateAttributes='true', Z_Act_RevisionOfActivity=<link>,
     *     Z_Activity_Type='-7'
     *   - remove Z_FollowUpRevisions, Z_Act_S4ItemDescription
     *
     * @param {Object} act - the activity segment
     * @param {string} originalActivityId - original activity id (for the link)
     * @param {string} originalCode - original activity code
     * @param {number} nextRevisionNumber - last revision number + 1
     * @param {string} baseUrl - FSM base URL (for the link)
     * @param {string} companyId - numeric company id (for the link)
     * @returns {Object} the mutated activity
     * @private
     */
    _transformRevisionActivity(act, originalActivityId, originalCode, nextRevisionNumber, baseUrl, companyId, activityCode, existingActivityId) {
        if (!act || typeof act !== 'object') return act;

        const n = nextRevisionNumber;

        // id: existing revision activity id (append smartforms to it) or null
        // (create). code: "<originalCode>-Rev-<NNN>" so the one activity per
        // revision level is identifiable.
        act.id = existingActivityId || null;
        act.code = activityCode || null;
        act.externalId = null;

        // Link the new activity to the original so the read pipeline finds it
        // as a revision (_getRevisionActivities filters on previousActivity).
        act.previousActivity = originalActivityId;

        // Subject: "<code> Rev-<N>" + the bracketed attribute suffix kept from
        // the original subject (everything from the first '[' onward).
        const subjectPrefix = `${originalCode} Rev-${n}`;
        if (typeof act.subject === 'string') {
            const bracketIdx = act.subject.indexOf('[');
            const suffix = bracketIdx >= 0 ? ' ' + act.subject.slice(bracketIdx) : '';
            act.subject = subjectPrefix + suffix;
        } else {
            act.subject = subjectPrefix;
        }

        act.attachments = null;

        // Remove transient / child-collection fields.
        ['lastChanged', 'remarks', 'contact', 'reservedMaterials', 'requirements',
         'region', 'workflowSteps', 'internalRemarks', 'internalRemarks2',
         'statusChangeReason', 'activityFeedbacks', 'plannedStartDate', 'plannedEndDate'
        ].forEach(f => { delete act[f]; });

        // Upsert revision UDFs.
        const base = (baseUrl || '').replace(/\/+$/, '');
        const link = `${base}/shell/#/planning-dispatching/activities/view/${originalActivityId}/details?selectedCompanyId=${companyId}`;
        act.udfValues = this._upsertCompositeUdf(act.udfValues, 'Z_UpdateAttributes', 'true');
        act.udfValues = this._upsertCompositeUdf(act.udfValues, 'Z_Act_RevisionOfActivity', link);
        act.udfValues = this._upsertCompositeUdf(act.udfValues, 'Z_Activity_Type', '-7');

        // Remove UDFs only relevant to the original activity.
        act.udfValues = this._removeCompositeUdfs(act.udfValues, ['Z_FollowUpRevisions', 'Z_Act_S4ItemDescription']);

        return act;
    }

    /**
     * Generate a random UUID v4 (lowercase, hyphenated). The 3rd group always
     * starts with '4' and the 4th group's first char is 8/9/a/b, per RFC 4122.
     * @returns {string}
     * @private
     */
    _uuidV4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Fetch the full ChecklistInstance DTO for a smartform id. Used to copy
     * template/language/content/etc. into a new revision's smartform payload.
     * @param {string} smartformId
     * @returns {Promise<Object|null>} the raw w object, or null
     * @private
     */
    async _getChecklistInstanceFull(smartformId) {
        const query = `SELECT w FROM ChecklistInstance w WHERE w.id = '${smartformId}'`;
        const data = await this.makeQueryRequest(query, 'ChecklistInstance.20');
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
                { meta: { externalId: 'Z_PreviousChecklist' }, value: previousChecklistId || rootSmartformId },
                { meta: { externalId: 'Z_PruefberichtNr' }, value: pruefberichtNr != null ? pruefberichtNr : '' }
            ],
            checklistId: this._uuidV4(),
            syncStatus: 'IN_CLOUD',
            object: {
                // Existing revision activity id (smartform attaches to it) or the
                // placeholder, set once the activity is created.
                objectId: activityObjectId || '<NEW_ACTIVITY_UUID>',
                objectType: 'ACTIVITY'
            }
        }];
    }

    /**
     * Build the new-revision ServiceCall payload for the activity in context.
     * Fetches the original's ServiceCall composite tree, keeps the original
     * activity segment, and transforms the header for the NEXT revision.
     *
     * The next revision number is computed LIVE here (max existing
     * Z_revisionNumber + 1) so repeated calls increment correctly.
     *
     * If smartform inputs are supplied (rootSmartformId etc.), the matching
     * new-revision smartform payload is assembled and returned too.
     *
     * @param {string} originalServiceCallId - original activity's ServiceCall id
     * @param {string} originalActivityId - original activity id (segment to keep)
     * @param {string} originalCode - original activity code (e.g. '19846')
     * @param {Object} [smartform] - { rootSmartformId, lastSmartformId, rootPruefberichtNr, nextRevisionNumber }
     * @returns {Promise<{payload: Object, nextRevisionNumber: number, smartformPayload: Array}>}
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
            const scNumberMap = await this._getRevisionServiceCalls(originalCode);
            let maxNum = 0;
            scNumberMap.forEach(num => { if (num != null && num > maxNum) maxNum = num; });
            nextRevisionNumber = maxNum + 1;
        }

        // Link parts (base URL + company id) for the activity's revision link.
        const destination = await DestinationService.getDestination(DESTINATION_NAME);
        const dcfg = destination.destinationConfiguration;
        const baseUrl = dcfg.URL || '';
        const companyId = dcfg['URL.headers.X-Company-ID'] || '';

        const tree = await this.getServiceCallCompositeTree(originalServiceCallId, originalActivityId);

        // Revision ServiceCall code is the ORIGINAL ServiceCall's code (tree.code,
        // e.g. '8200002124') + suffix — NOT the activity code (originalCode, e.g.
        // '19846'). Check if that SC already exists: if so PATCH appends to it
        // (keep its id); otherwise a new SC is created (id null).
        const padded = String(nextRevisionNumber).padStart(3, '0');
        const baseScCode = tree.code != null ? tree.code : originalCode;
        const revisionCode = `${baseScCode}-Rev-${padded}`;
        const existingServiceCallId = await this._getServiceCallIdByCode(revisionCode);

        // Revision activity code = original activity code + same suffix
        // (e.g. '19846-Rev-003'). One activity per revision level; check if it
        // already exists (attach smartforms to it) or must be created.
        const activityCode = `${originalCode}-Rev-${padded}`;
        const existingActivityId = await this._getActivityIdByCode(activityCode);

        // Header transform (id = existing SC id or null).
        this._transformRevisionHeader(tree, originalCode, nextRevisionNumber, existingServiceCallId);

        // Capture the original activity's Z_FollowUpRevisions BEFORE the
        // transform strips it (the activity transform removes this UDF).
        let existingFollowUps = null;
        if (Array.isArray(tree.activities)) {
            const origAct = tree.activities.find(a => a && a.id === originalActivityId) || tree.activities[0];
            if (origAct) existingFollowUps = this._udfCompositeTree(origAct, 'Z_FollowUpRevisions');
        }

        // Activity transform: code = revision code, id = existing activity id
        // (append smartforms) or null (create).
        if (Array.isArray(tree.activities)) {
            tree.activities = tree.activities.map(act =>
                this._transformRevisionActivity(act, originalActivityId, originalCode, nextRevisionNumber, baseUrl, companyId, activityCode, existingActivityId)
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
            if (smartformPayload) this._stripNulls(smartformPayload);
        }

        // Follow-up revisions PATCH payload for the ORIGINAL activity: ONLY when
        // a NEW revision activity is created (not when attaching a smartform to
        // an existing revision activity — that would duplicate the line).
        const followUpPayload = existingActivityId
            ? null
            : this._buildFollowUpRevisionsPayload(existingFollowUps, originalCode, nextRevisionNumber, baseUrl, companyId);

        // FSM rejects explicit nulls on create (Object.toString() on null).
        // Strip every null key/value pair from the SC payload. On the create
        // branch this also removes the (now-null) id, leaving the key absent.
        this._stripNulls(tree);

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
            account: dcfg.account || this.config.account
        };
    }

    /**
     * Recursively remove every key whose value is null (FSM rejects explicit
     * nulls on create — it calls .toString() on them). Arrays are preserved
     * (elements recursed); objects drop null-valued keys. Mutates in place.
     * @param {*} node
     * @returns {*}
     * @private
     */
    _stripNulls(node) {
        if (Array.isArray(node)) {
            node.forEach(el => this._stripNulls(el));
            return node;
        }
        if (node && typeof node === 'object') {
            Object.keys(node).forEach(k => {
                if (node[k] === null) {
                    delete node[k];
                } else {
                    this._stripNulls(node[k]);
                }
            });
        }
        return node;
    }

    /**
     * Build the Z_FollowUpRevisions update payload for the original activity.
     * Appends a line for the new revision to the existing value, or creates the
     * value fresh if none exists. New activity UUID is a placeholder.
     *
     * Line format: "\n<code> Rev-<N> - Rev-Nr. <N>: <activity link>"
     *
     * @param {string|null} existingValue - current Z_FollowUpRevisions value
     * @param {string} originalCode - activity code (e.g. '19846')
     * @param {number} nextRevisionNumber
     * @param {string} baseUrl
     * @param {string} companyId
     * @returns {Object} { udfValues: [{ meta: { externalId }, value }] }
     * @private
     */
    _buildFollowUpRevisionsPayload(existingValue, originalCode, nextRevisionNumber, baseUrl, companyId) {
        const n = nextRevisionNumber;
        const base = (baseUrl || '').replace(/\/+$/, '');
        const link = `${base}/shell/#/planning-dispatching/activities/view/<NEW_ACTIVITY_UUID>/details?selectedCompanyId=${companyId}`;
        const newLine = `\n${originalCode} Rev-${n} - Rev-Nr. ${n}: ${link}`;

        const prior = (existingValue != null && String(existingValue).trim() !== '') ? String(existingValue) : '';
        const value = prior + newLine;

        return {
            udfValues: [
                { meta: { externalId: 'Z_FollowUpRevisions' }, value }
            ]
        };
    }

    /**
     * Fetch the attachment for a specific smartform on a specific activity.
     * Matched by BOTH sourceObject.objectId (smartform) and object.objectId
     * (activity), so each smartform row gets its own activity-specific file.
     * Returns the first attachment found, or null if none.
     *
     * @param {string} smartformId - ChecklistInstance id (sourceObject.objectId)
     * @param {string} activityId  - Activity id (object.objectId)
     * @returns {Promise<{fileName: string, description: string}|null>}
     * @private
     */
    async _getAttachmentForSmartform(smartformId, activityId) {
        if (!smartformId || !activityId) return null;

        const query = `SELECT w.udf.Z_Attachment_Description, w.fileName FROM Attachment w WHERE w.sourceObject.objectId = '${smartformId}' AND w.object.objectId = '${activityId}'`;
        const data = await this.makeQueryRequest(query, 'Attachment.19');

        if (!data.data || data.data.length === 0) return null;

        const w = data.data[0].w;
        return {
            fileName: w.fileName || '',
            description: this._udf(w, 'Z_Attachment_Description') || ''
        };
    }

    /**
     * Build a CoreSQL IN-list literal from an array of UUIDs.
     * Deduplicates and quotes each value: ['a','b'] -> "'a','b'".
     * @param {Array<string>} ids
     * @returns {string} comma-separated quoted list (empty string if no ids)
     * @private
     */
    _toInList(ids) {
        const unique = [...new Set((ids || []).filter(Boolean))];
        return unique.map(id => `'${id}'`).join(',');
    }

    // ========================================
    // CHECKLIST INSTANCES (SMARTFORMS)
    // ========================================

    /**
     * Query 1 - closed ChecklistInstances for an Activity.
     * Carries the template UUID through so the chain can resolve names/tags.
     *
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<{id: string, description: string, template: string}>>}
     * @private
     */
    async _getChecklistInstances(objectId) {
        const query = `SELECT w.id, w.template, w.description, w.closed, w.udf.Z_PreviousChecklist, w.udf.Z_PruefberichtNr FROM ChecklistInstance w WHERE w.object.objectId = '${objectId}'`;
        const data = await this.makeQueryRequest(query, 'ChecklistInstance.20');

        if (!data.data || data.data.length === 0) return [];

        return data.data.map(item => {
            const w = item.w;
            const desc = (w.description && w.description.trim()) ? w.description.trim() : null;
            return {
                id: w.id,
                // Smartform Description: real description, else fall back to the ID.
                description: desc ? `${desc} (${w.id})` : w.id,
                // Clean description (no ID concat) for table cells.
                rawDescription: desc || '',
                template: w.template || null,
                // Open/closed status (now that open smartforms are shown too).
                closed: w.closed === true,
                // Z_PreviousChecklist links a smartform to its predecessor;
                // when it equals own id, the smartform is an original (root).
                // Selecting w.udf.Z_PreviousChecklist explicitly makes FSM return
                // it inside udfValues WITH the `name` field (a bare SELECT w omits
                // `name`, leaving only meta/value, which cannot be matched).
                previousChecklist: this._udf(w, 'Z_PreviousChecklist'),
                // Z_PruefberichtNr (report number) carried for the smartform payload.
                pruefberichtNr: this._udf(w, 'Z_PruefberichtNr')
            };
        });
    }

    /**
     * Query 2 - ChecklistTemplates by id (batched IN clause).
     * Requests w.id explicitly so results can be keyed back to instances.
     * @param {Array<string>} templateIds
     * @returns {Promise<Map<string, {name: string, tags: Array<string>}>>}
     * @private
     */
    async _getTemplatesByIds(templateIds) {
        const inList = this._toInList(templateIds);
        if (!inList) return new Map();

        const query = `SELECT w.id, w.name, w.tags FROM ChecklistTemplate w WHERE w.id IN (${inList})`;
        const data = await this.makeQueryRequest(query, 'ChecklistTemplate.21');

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (w && w.id) {
                    map.set(w.id, { name: w.name || null, tags: w.tags || [] });
                }
            });
        }
        return map;
    }

    /**
     * Query 3 - ChecklistTag names by id (batched IN clause).
     * Requests w.id explicitly so each name maps back to its tag UUID.
     * @param {Array<string>} tagIds
     * @returns {Promise<Map<string, string>>} Map of tag id -> tag name.
     * @private
     */
    async _getTagNamesByIds(tagIds) {
        const inList = this._toInList(tagIds);
        if (!inList) return new Map();

        const query = `SELECT w.id, w.name FROM ChecklistTag w WHERE w.id IN (${inList})`;
        const data = await this.makeQueryRequest(query, 'ChecklistTag.10');

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (w && w.id) map.set(w.id, w.name || null);
            });
        }
        return map;
    }

    /**
     * Query 4 - Attachments for a set of source objects (batched IN clause).
     * Groups results by sourceObject.objectId, since one smartform may have
     * several attachments.
     * @param {Array<string>} sourceObjectIds - ChecklistInstance UUIDs
     * @returns {Promise<Map<string, Array<{id: string, fileName: string}>>>}
     *          Map of sourceObject id -> array of attachments.
     * @private
     */
    async _getAttachmentsBySourceIds(sourceObjectIds) {
        const inList = this._toInList(sourceObjectIds);
        if (!inList) return new Map();

        const query = `SELECT w FROM Attachment w WHERE w.sourceObject.objectId IN (${inList})`;
        const data = await this.makeQueryRequest(query, 'Attachment.19');

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                const srcId = w && w.sourceObject ? w.sourceObject.objectId : null;
                if (!srcId) return;
                if (!map.has(srcId)) map.set(srcId, []);
                map.get(srcId).push({ id: w.id, fileName: w.fileName || null });
            });
        }
        return map;
    }

    /**
     * Orchestrate the three-query chain for an Activity and return the
     * smartforms whose template is tagged "Inspection".
     *
     * @param {string} objectId - Activity objectId from the FSM context
     * @returns {Promise<Array<{id: string, description: string, name: string, attachments: Array<{id: string, fileName: string}>}>>}
     *          UI-shaped list. Only Inspection-tagged instances are included,
     *          each with its attachments (may be empty).
     */
    async getInspectionSmartformsForActivity(objectId) {
        try {
            if (!objectId) return [];

            // 1) Instances for the activity.
            const instances = await this._getChecklistInstances(objectId);
            if (instances.length === 0) return [];

            // 2) Resolve template name + tags for all distinct templates at once.
            const templateIds = instances.map(i => i.template).filter(Boolean);
            const templateMap = await this._getTemplatesByIds(templateIds);

            // 3) Resolve all distinct tag UUIDs across those templates at once.
            const allTagIds = [];
            templateMap.forEach(t => { (t.tags || []).forEach(id => allTagIds.push(id)); });
            const tagNameMap = await this._getTagNamesByIds(allTagIds);

            // Glue: attach template name, decide Inspection membership, filter.
            const result = [];
            instances.forEach(inst => {
                const tmpl = inst.template ? templateMap.get(inst.template) : null;
                if (!tmpl) return; // no template resolved -> cannot qualify

                const tagNames = (tmpl.tags || []).map(id => tagNameMap.get(id)).filter(Boolean);
                const isInspection = tagNames.includes(REQUIRED_TAG);
                if (!isInspection) return; // filtered out

                result.push({
                    id: inst.id,
                    description: inst.description,
                    rawDescription: inst.rawDescription || '',
                    previousChecklist: inst.previousChecklist || null,
                    pruefberichtNr: inst.pruefberichtNr || null,
                    closed: inst.closed === true,
                    name: tmpl.name || null,
                    attachments: []
                });
            });

            if (result.length === 0) return [];

            // 4) Attachments for the surviving smartforms only (batched IN).
            const survivingIds = result.map(r => r.id);
            const attachmentMap = await this._getAttachmentsBySourceIds(survivingIds);
            result.forEach(r => {
                r.attachments = attachmentMap.get(r.id) || [];
            });

            return result;
        } catch (error) {
            console.error('FSMService: Error building inspection smartforms:', error.message);
            return [];
        }
    }

    // ========================================
    // ACTIVITY REVISION TREE
    // ========================================

    /**
     * Read a UDF value by name from a DTO's udfValues array.
     * @param {Object} w - DTO object that may carry udfValues
     * @param {string} udfName - e.g. 'Z_revisionNumber'
     * @returns {string|null}
     * @private
     */
    _udf(w, udfName) {
        const vals = (w && w.udfValues) || [];
        const hit = vals.find(u => u && u.name === udfName);
        return hit && hit.value != null ? hit.value : null;
    }

    /**
     * Activity core fields by Activity id.
     * Used both to classify the context activity (original vs revision) and
     * to read the original's code/subject/serviceCallId.
     * object.objectId is the activity's parent ServiceCall id.
     * @param {string} activityId
     * @returns {Promise<{id: string, previousActivity: string|null, code: string|null, subject: string|null, serviceCallId: string|null}|null>}
     * @private
     */
    async _getActivityCore(activityId) {
        const query = `SELECT w.id, w.previousActivity, w.code, w.subject, w.object.objectId FROM Activity w WHERE w.id = '${activityId}'`;
        const data = await this.makeQueryRequest(query, 'Activity.43');

        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return {
            id: w.id || activityId,
            previousActivity: w.previousActivity || null,
            code: w.code != null ? w.code : null,
            subject: w.subject != null ? w.subject : null,
            // CoreSQL returns the dotted alias as a flat key on w.
            serviceCallId: w['object.objectId'] || (w.object ? w.object.objectId : null) || null
        };
    }

    /**
     * Look up a ServiceCall id by its code. Used to decide whether a revision
     * ServiceCall already exists (append) or must be created.
     * @param {string} code - e.g. '8200002124-Rev-002'
     * @returns {Promise<string|null>} existing SC id, or null if none
     * @private
     */
    async _getServiceCallIdByCode(code) {
        if (!code) return null;
        const query = `SELECT w.id FROM ServiceCall w WHERE w.code = '${code}'`;
        const data = await this.makeQueryRequest(query, 'ServiceCall.27');
        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return (w && w.id) ? w.id : null;
    }

    /**
     * Look up an Activity id by its code. Used to decide whether a revision
     * activity already exists (attach smartforms to it) or must be created.
     * @param {string} code - e.g. '19846-Rev-002'
     * @returns {Promise<string|null>} existing activity id, or null if none
     * @private
     */
    async _getActivityIdByCode(code) {
        if (!code) return null;
        const query = `SELECT w.id FROM Activity w WHERE w.code = '${code}'`;
        const data = await this.makeQueryRequest(query, 'Activity.43');
        if (!data.data || data.data.length === 0) return null;
        const w = data.data[0].w;
        return (w && w.id) ? w.id : null;
    }

    /**
     * Revision ServiceCalls for an original activity code.
     * Maps ServiceCall id -> revision number via the Z_revisionNumber UDF.
     * @param {string} originalCode - the original activity's code (e.g. '19846')
     * @returns {Promise<Map<string, number>>} ServiceCall id -> revision number
     * @private
     */
    async _getRevisionServiceCalls(originalCode) {
        if (!originalCode) return new Map();

        const query = `SELECT w.id, w.udf.Z_RevisionOfActivity, w.udf.Z_revisionNumber FROM ServiceCall w WHERE w.udf.Z_RevisionOfActivity = '${originalCode}'`;
        const data = await this.makeQueryRequest(query, 'ServiceCall.27');

        const map = new Map();
        if (data.data) {
            data.data.forEach(item => {
                const w = item.w;
                if (!w || !w.id) return;
                const num = this._udf(w, 'Z_revisionNumber');
                map.set(w.id, num != null ? parseInt(num, 10) : null);
            });
        }
        return map;
    }

    /**
     * Revision Activities for an original activity id.
     * object.objectId on these rows is the ServiceCall id, used to join the
     * revision number from _getRevisionServiceCalls.
     * @param {string} originalActivityId
     * @returns {Promise<Array<{id: string, serviceCallId: string|null, subject: string|null, code: string|null}>>}
     * @private
     */
    async _getRevisionActivities(originalActivityId) {
        const query = `SELECT w.id, w.object.objectId, w.subject, w.code FROM Activity w WHERE w.previousActivity = '${originalActivityId}' AND w.udf.Z_Activity_Type = '-7'`;
        const data = await this.makeQueryRequest(query, 'Activity.43');

        if (!data.data) return [];
        return data.data.map(item => {
            const w = item.w;
            return {
                id: w.id || null,
                // CoreSQL returns the dotted alias as a flat key on w.
                serviceCallId: w['object.objectId'] || (w.object ? w.object.objectId : null) || null,
                subject: w.subject != null ? w.subject : null,
                code: w.code != null ? w.code : null
            };
        });
    }

    /**
     * Build the activity revision tree for the activity currently in context.
     *
     * Resolves the original activity (whether context is the original or a
     * revision), then lists the original plus all its revisions ordered by
     * revision number ascending.
     *
     * @param {string} contextActivityId - Activity id from the FSM context
     * @returns {Promise<Array<{isOriginal: boolean, revisionLabel: string, revisionNumber: number|null, id: string, code: string|null, subject: string|null}>>}
     */
    async getActivityRevisionTree(contextActivityId) {
        try {
            if (!contextActivityId) return [];

            // 1) Classify the context activity.
            const ctx = await this._getActivityCore(contextActivityId);
            if (!ctx) return [];

            // 2) Resolve the original activity (id + code + subject + serviceCallId).
            let original;
            if (!ctx.previousActivity) {
                // Context IS the original.
                original = { id: ctx.id, code: ctx.code, subject: ctx.subject, serviceCallId: ctx.serviceCallId };
            } else {
                // Context is a revision; previousActivity is the original's id.
                const orig = await this._getActivityCore(ctx.previousActivity);
                if (!orig) return [];
                original = { id: orig.id, code: orig.code, subject: orig.subject, serviceCallId: orig.serviceCallId };
            }

            // 3) Revision ServiceCalls (id -> revision number) by original code.
            const scNumberMap = await this._getRevisionServiceCalls(original.code);

            // 4) Revision Activities for the original, joined to revision number.
            const revActivities = await this._getRevisionActivities(original.id);

            const revisions = revActivities.map(ra => {
                const num = ra.serviceCallId ? scNumberMap.get(ra.serviceCallId) : null;
                return {
                    isOriginal: false,
                    revisionNumber: (num != null ? num : null),
                    revisionLabel: (num != null ? `Rev-${num}` : 'Rev-?'),
                    id: ra.id,
                    code: ra.code,
                    subject: ra.subject
                };
            });

            // Sort by revision number ascending; unknowns last.
            revisions.sort((a, b) => {
                if (a.revisionNumber == null) return 1;
                if (b.revisionNumber == null) return -1;
                return a.revisionNumber - b.revisionNumber;
            });

            // 5) Original first, then revisions.
            const originalRow = {
                isOriginal: true,
                revisionNumber: 0,
                revisionLabel: 'Original',
                id: original.id,
                code: original.code,
                subject: original.subject,
                serviceCallId: original.serviceCallId
            };

            return [originalRow, ...revisions];
        } catch (error) {
            console.error('FSMService: Error building activity revision tree:', error.message);
            return [];
        }
    }

    /**
     * Resolve a smartform's root (original) id by following the
     * Z_PreviousChecklist chain until a self-reference is found.
     * A smartform whose previousChecklist === own id is itself a root.
     * Guards against missing links and cycles.
     *
     * @param {string} smartformId
     * @param {Map<string, Object>} byId - id -> smartform { id, previousChecklist }
     * @returns {string|null} root smartform id, or null if unresolvable
     * @private
     */
    _resolveRootChecklistId(smartformId, byId) {
        let currentId = smartformId;
        const seen = new Set();

        while (currentId && !seen.has(currentId)) {
            seen.add(currentId);
            const sf = byId.get(currentId);
            if (!sf) return null; // predecessor not among fetched smartforms
            const prev = sf.previousChecklist;
            if (!prev || prev === currentId) {
                return currentId; // self-reference (or no link) => this is the root
            }
            currentId = prev;
        }
        return null; // cycle or dead end
    }

    /**
     * Build the per-smartform table structure across the whole activity tree.
     *
     * Fetches Inspection smartforms for EVERY activity (original + revisions),
     * then groups them into tables by their root (original) smartform, using
     * the Z_PreviousChecklist chain. Within each table, every smartform sits
     * on the row of the activity it belongs to.
     *
     * Row shape (per table):
     *   revisionLabel, code, id, subject        - activity columns
     *   smartformDescription, smartformName     - populated where a smartform
     *                                             exists for that activity
     *   attachmentDescription, attachmentName   - attachment columns
     *   statusText, closed                      - smartform Open/Closed status
     *   isOriginal, hasSmartform                - flags
     *
     * @param {string} contextActivityId - Activity id from the FSM context
     * @returns {Promise<{activities: Array<Object>, tables: Array<Object>}>}
     */
    async getActivityTreeWithSmartforms(contextActivityId) {
        try {
            const tree = await this.getActivityRevisionTree(contextActivityId);
            if (!tree || tree.length === 0) {
                return { activities: [], tables: [] };
            }

            // Shared activity lineage (already ordered: original, then revisions).
            const activities = tree.map(a => ({
                isOriginal: !!a.isOriginal,
                revisionLabel: a.revisionLabel,
                code: a.code != null ? a.code : '',
                id: a.id,
                subject: a.subject != null ? a.subject : ''
            }));

            // Original activity's ServiceCall id + activity id, for the Create
            // Revision composite-tree fetch (we GET the original's ServiceCall
            // and keep only the activity segment matching the original).
            const originalEntry = tree.find(a => a.isOriginal) || {};
            const originalServiceCallId = originalEntry.serviceCallId || null;
            const originalActivityId = originalEntry.id || null;
            const originalCode = originalEntry.code || null;

            // 1) Fetch Inspection smartforms for every activity, tag with activityId.
            const perActivity = await Promise.all(
                activities.map(async act => {
                    const sfs = await this.getInspectionSmartformsForActivity(act.id);
                    return (sfs || []).map(sf => ({ ...sf, activityId: act.id }));
                })
            );
            // On the ORIGINAL activity, only show CLOSED smartforms (open ones are
            // still being worked on and shouldn't form a table). On REVISION
            // activities, show both (status column reflects open/closed).
            const allSmartforms = perActivity.flat().filter(sf =>
                sf.activityId !== originalActivityId || sf.closed === true
            );

            // 2) Index by id for chain resolution.
            const byId = new Map();
            allSmartforms.forEach(sf => byId.set(sf.id, sf));

            // 3) Group every smartform under its resolved root (via the
            //    Z_PreviousChecklist chain). Each smartform belongs to exactly
            //    one root's bucket.
            const smartformsByRoot = new Map(); // rootId -> [smartform, ...]
            allSmartforms.forEach(sf => {
                const rootId = this._resolveRootChecklistId(sf.id, byId);
                if (!rootId) return;
                if (!smartformsByRoot.has(rootId)) smartformsByRoot.set(rootId, []);
                smartformsByRoot.get(rootId).push(sf);
            });

            // Roots = smartforms on the ORIGINAL activity that are their own
            // root (previousChecklist self/null). One table per root.
            const roots = allSmartforms.filter(sf =>
                sf.activityId === originalActivityId &&
                (!sf.previousChecklist || sf.previousChecklist === sf.id)
            );

            // Activity lookup (lineage order preserved) for row construction.
            const activityById = new Map();
            activities.forEach(act => activityById.set(act.id, act));

            // 4) Build one table per root. Rows are ONLY the activities whose
            //    smartforms belong to this root's chain (per-chain), with the
            //    original activity always present. Built in lineage order.
            const tables = roots.map(root => {
                const bucket = smartformsByRoot.get(root.id) || [];

                // The activity ids this table covers: every activity carrying a
                // smartform in this root's chain, plus the original activity.
                const sfByActivityId = new Map(); // activityId -> smartform (first wins)
                bucket.forEach(sf => {
                    if (!sfByActivityId.has(sf.activityId)) {
                        sfByActivityId.set(sf.activityId, sf);
                    }
                });
                const coveredActivityIds = new Set(sfByActivityId.keys());
                coveredActivityIds.add(originalActivityId); // original row always shown

                // Rows in lineage order, restricted to covered activities.
                const rows = activities
                    .filter(act => coveredActivityIds.has(act.id))
                    .map(act => {
                        const sf = sfByActivityId.get(act.id) || null;
                        return {
                            isOriginal: act.isOriginal,
                            revisionLabel: act.revisionLabel,
                            code: act.code,
                            id: act.id,
                            subject: act.subject,
                            smartformId: sf ? sf.id : '',
                            smartformDescription: sf ? (sf.rawDescription || sf.description || '') : '',
                            smartformName: sf ? (sf.name || '') : '',
                            attachmentDescription: '',
                            attachmentName: '',
                            hasSmartform: !!sf,
                            // Open/Closed status for the smartform on this row.
                            closed: sf ? (sf.closed === true) : false,
                            statusText: sf ? (sf.closed === true ? 'Closed' : 'Open') : ''
                        };
                    });

                return {
                    rootSmartformId: root.id,
                    smartformName: root.name || '',
                    smartformDescription: root.rawDescription || root.description || '',
                    rootPruefberichtNr: root.pruefberichtNr || null,
                    rows: rows
                };
            });

            // Per table: the LAST populated smartform row (highest revision with
            // a smartform). Rows are ordered Original -> Rev-1 -> ...; walk from
            // the end. Falls back to the root smartform if only it is populated.
            // Also compute this table's next revision number = (number of
            // revision rows in THIS table) + 1. Counting is per-table (per
            // smartform lineage), not global to the original activity.
            tables.forEach(t => {
                let lastId = t.rootSmartformId;
                for (let i = t.rows.length - 1; i >= 0; i--) {
                    if (t.rows[i].hasSmartform && t.rows[i].smartformId) {
                        lastId = t.rows[i].smartformId;
                        break;
                    }
                }
                t.lastSmartformId = lastId;

                const revisionRowCount = t.rows.filter(r => !r.isOriginal).length;
                t.nextRevisionNumber = revisionRowCount + 1;
            });

            // 5) Fetch attachments for every populated row (smartform + activity)
            //    and fill the attachment columns. Empty rows are skipped.
            const populatedRows = [];
            tables.forEach(t => {
                t.rows.forEach(row => {
                    if (row.hasSmartform && row.smartformId) {
                        populatedRows.push(row);
                    }
                });
            });

            await Promise.all(populatedRows.map(async row => {
                const att = await this._getAttachmentForSmartform(row.smartformId, row.id);
                if (att) {
                    row.attachmentName = att.fileName || '';
                    row.attachmentDescription = att.description || '';
                }
            }));

            return { activities, tables, originalServiceCallId, originalActivityId, originalCode };
        } catch (error) {
            console.error('FSMService: Error building tree with smartforms:', error.message);
            return { activities: [], tables: [] };
        }
    }
}

module.exports = new FSMService();