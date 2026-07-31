/**
 * fsmPayloadUtils.js
 *
 * Stateless transforms over FSM payload shapes. Every function here is pure in
 * the sense that it depends only on its arguments (no I/O, no destination/token
 * lookups, no `this`). Several MUTATE their argument in place and return it —
 * that contract is preserved exactly from the original FSMService methods so
 * callers behave identically; the mutation is noted per function.
 *
 * Two UDF wire shapes appear in this app and must not be confused:
 *   - composite-tree:  { udfMeta: { externalId }, value }
 *   - Data API (v4):   { meta:    { externalId }, value }
 * The helpers below operate on the composite-tree shape unless noted.
 *
 * Extracted from FSMService.js so they can be unit-tested in isolation and so
 * the read/write services no longer carry transform logic.
 *
 * @file utils/fsmPayloadUtils.js
 * @module utils/fsmPayloadUtils
 */
'use strict';

const { UDF, TYPE } = require('./fsmConstants');

/**
 * Read a UDF value from a composite-tree DTO's udfValues array.
 * Composite-tree shape differs from the Query API: each entry is
 * { udfMeta: { externalId }, value } rather than { name, value }.
 * @param {Object} dto - object carrying udfValues
 * @param {string} externalId - e.g. UDF.ACTIVITY_TYPE
 * @returns {string|null}
 */
function udfCompositeTree(dto, externalId) {
    const vals = (dto && dto.udfValues) || [];
    const hit = vals.find(u => u && u.udfMeta && u.udfMeta.externalId === externalId);
    return hit && hit.value != null ? hit.value : null;
}

/**
 * Upsert a UDF (by externalId) in a composite-tree udfValues array.
 * If a UDF with the externalId exists, its value is updated (udfMeta.id
 * preserved). Otherwise a new entry { udfMeta: { externalId }, value } is
 * pushed. MUTATES and returns the array.
 * @param {Array} udfValues
 * @param {string} externalId
 * @param {string} value
 * @returns {Array} the (mutated) udfValues
 */
function upsertCompositeUdf(udfValues, externalId, value) {
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
 * Remove UDFs (by externalId) from a composite-tree udfValues array.
 * Returns a NEW filtered array (does not mutate the input array in place);
 * callers reassign the result, matching the original contract.
 * @param {Array} udfValues
 * @param {Array<string>} externalIds
 * @returns {Array}
 */
function removeCompositeUdfs(udfValues, externalIds) {
    if (!Array.isArray(udfValues)) return udfValues;
    const drop = new Set(externalIds);
    return udfValues.filter(u =>
        !(u && u.udfMeta && drop.has(u.udfMeta.externalId))
    );
}

/**
 * Transform a fetched ServiceCall composite-tree into the payload for a
 * NEW revision's ServiceCall header. MUTATES the header in place:
 *   - id -> existing SC id (append) or null (create)
 *   - code -> `<code>-<originalCode>-Rev-<NNN>` (unique per original activity)
 *   - subject -> the assembled code
 *   - type -> revision SC type
 *   - remove externalId + transient/child fields
 *   - upsert Z_RevisionOfActivity = originalCode, Z_revisionNumber = N
 * Activity segment is transformed later (separate step).
 *
 * @param {Object} tree - the (activity-filtered) composite tree
 * @param {string} originalCode - original activity code (e.g. '19846')
 * @param {number} nextRevisionNumber - last revision number + 1
 * @param {string|null} existingServiceCallId - id of the revision SC if it
 *        already exists (PATCH appends to it); null to create a new SC.
 * @returns {Object} the mutated tree
 */
function transformRevisionHeader(tree, originalCode, nextRevisionNumber, existingServiceCallId) {
    if (!tree || typeof tree !== 'object') return tree;

    const n = nextRevisionNumber;
    const padded = String(n).padStart(3, '0'); // 4 -> '004', max 999

    // id: existing SC id (append) or null (create). PATCH composite-tree
    // with X-Create-Or-Update branches on this.
    tree.id = existingServiceCallId || null;
    if (tree.code != null) {
        // Embed the original activity code so the revision SC code is unique
        // per original activity (e.g. '8200008332-33219-Rev-001'). Prevents the
        // CA-202 duplicate-SC-code collision when a parent SC has multiple
        // revisioned activities. Must match revisionCode in RevisionWriteService.
        tree.code = `${tree.code}-${originalCode}-Rev-${padded}`;
    }
    tree.subject = tree.code || `${originalCode} Rev-${n}`;
    // Revision ServiceCalls use TYPE.SERVICE_CALL_REVISION (original is
    // TYPE.SERVICE_CALL_ORIGINAL).
    tree.type = TYPE.SERVICE_CALL_REVISION;
    // externalId belongs to the original SC; the revision SC must not carry it.
    delete tree.externalId;

    // Remove transient / child-collection fields not wanted on the new header.
    ['lastChanged', 'chargeableEfforts', 'chargeableExpenses',
     'chargeableMaterials', 'chargeableMileages', 'createPerson',
     'resolution', 'reservedMaterials', 'attachments', 'requirements',
     'serviceContract'
    ].forEach(f => { delete tree[f]; });

    // Upsert the two revision UDFs.
    tree.udfValues = upsertCompositeUdf(tree.udfValues, UDF.REVISION_OF_ACTIVITY, String(originalCode));
    tree.udfValues = upsertCompositeUdf(tree.udfValues, UDF.REVISION_NUMBER, String(n));

    return tree;
}

/**
 * Transform the original activity segment into the NEW revision's activity.
 * MUTATES the activity in place:
 *   - id -> existing revision activity id or null; code -> activityCode;
 *     externalId -> original externalId + "-Rev-<NNN>" (null if none)
 *   - previousActivity -> originalActivityId (read pipeline filters on this)
 *   - subject -> `<originalCode> Rev-<N>` + bracketed attribute suffix
 *   - attachments -> null
 *   - remove transient/child fields (incl. supportingPersons — the revision
 *     activity must not inherit the original's supporting persons)
 *   - upsert Z_UpdateAttributes='true', Z_Act_RevisionOfActivity=<link>,
 *     Z_Activity_Type=revision type
 *   - remove Z_FollowUpRevisions, Z_Act_S4ItemDescription, Z_ActApprovalHistory
 *
 * @param {Object} act - the activity segment
 * @param {string} originalActivityId - original activity id (for the link)
 * @param {string} originalCode - original activity code
 * @param {number} nextRevisionNumber - last revision number + 1
 * @param {string} baseUrl - FSM base URL (for the link)
 * @param {string} companyId - numeric company id (for the link)
 * @param {string} activityCode - assembled revision activity code
 * @param {string|null} existingActivityId - existing revision activity id, or null
 * @returns {Object} the mutated activity
 */
function transformRevisionActivity(act, originalActivityId, originalCode, nextRevisionNumber, baseUrl, companyId, activityCode, existingActivityId) {
    if (!act || typeof act !== 'object') return act;

    const n = nextRevisionNumber;

    // id: existing revision activity id (append smartforms to it) or null
    // (create). code: "<originalCode>-Rev-<NNN>" so the one activity per
    // revision level is identifiable.
    act.id = existingActivityId || null;
    act.code = activityCode || null;

    // externalId gets the SAME "-Rev-<NNN>" suffix as the code, appended to
    // the ORIGINAL activity's externalId (e.g. "8200002222/110" ->
    // "8200002222/110-Rev-005"). Cleared if the original has no externalId.
    const revSuffix = `-Rev-${String(n).padStart(3, '0')}`;
    const origExternalId = (act.externalId != null && String(act.externalId).trim() !== '')
        ? String(act.externalId)
        : null;
    act.externalId = origExternalId ? `${origExternalId}${revSuffix}` : null;

    // Link the new activity to the original so the read pipeline finds it
    // as a revision (revision-activity query filters on previousActivity).
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
    // NOTE: FSM returns `workflowStep` (singular) on GET but rejects it on the
    // V43 write DTO (CA-09 "not part of ActivityDTO_V43"). Both spellings are
    // stripped — the read shape is not the write shape.
    ['lastChanged', 'remarks', 'contact', 'reservedMaterials', 'requirements',
     'region', 'workflowStep', 'workflowSteps', 'internalRemarks', 'internalRemarks2',
     'statusChangeReason', 'activityFeedbacks', 'plannedStartDate', 'plannedEndDate',
     'supportingPersons'
    ].forEach(f => { delete act[f]; });

    // Upsert revision UDFs.
    const base = (baseUrl || '').replace(/\/+$/, '');
    const link = `${base}/shell/#/planning-dispatching/activities/view/${originalActivityId}/details?selectedCompanyId=${companyId}`;
    act.udfValues = upsertCompositeUdf(act.udfValues, UDF.UPDATE_ATTRIBUTES, 'true');
    act.udfValues = upsertCompositeUdf(act.udfValues, UDF.ACT_REVISION_OF_ACTIVITY, link);
    act.udfValues = upsertCompositeUdf(act.udfValues, UDF.ACTIVITY_TYPE, TYPE.ACTIVITY_REVISION);

    // Remove UDFs only relevant to the original activity.
    act.udfValues = removeCompositeUdfs(act.udfValues, [
        UDF.FOLLOW_UP_REVISIONS,
        UDF.ACT_S4_ITEM_DESCRIPTION,
        UDF.ACT_APPROVAL_HISTORY
    ]);

    return act;
}

/**
 * Generate a random UUID v4 (lowercase, hyphenated). The 3rd group always
 * starts with '4' and the 4th group's first char is 8/9/a/b, per RFC 4122.
 * @returns {string}
 */
function uuidV4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * FSM requires exactly one of id/code/externalId on identifier-reference
 * objects (businessPartner, responsibles, serviceProduct, item, warehouse,
 * etc.). Recursively reduce any such reference to a single identifier,
 * preferring id, then externalId, then code. A "reference" is an object whose
 * keys are a subset of {id, code, externalId} with at least one set (so the
 * SC/activity headers, which have many other keys, are NOT touched).
 * udfMeta / meta are skipped (they legitimately carry id + externalId).
 * MUTATES in place.
 * @param {*} node
 * @returns {*}
 */
function reduceIdentifierRefs(node) {
    const REF_KEYS = ['id', 'code', 'externalId'];
    const present = v => v != null && String(v).trim() !== '';

    // Is this object an identifier reference (keys ⊆ ref-keys)?
    const isRefObject = obj => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        const keys = Object.keys(obj);
        return keys.length > 0 && keys.every(k => REF_KEYS.includes(k));
    };
    // Reduce a ref to a single identifier (id > externalId > code).
    // Returns true if a usable identifier remains, false if the ref is empty.
    const reduceRef = obj => {
        const keep = present(obj.id) ? 'id'
            : (present(obj.externalId) ? 'externalId'
            : (present(obj.code) ? 'code' : null));
        const value = keep ? obj[keep] : null;
        REF_KEYS.forEach(k => { delete obj[k]; });
        if (keep) { obj[keep] = value; return true; }
        return false; // no usable identifier
    };

    if (Array.isArray(node)) {
        // Recurse; drop any array element that is a now-empty reference.
        for (let i = node.length - 1; i >= 0; i--) {
            const el = node[i];
            if (isRefObject(el)) {
                if (!reduceRef(el)) node.splice(i, 1); // remove empty ref
            } else {
                reduceIdentifierRefs(el);
            }
        }
        return node;
    }

    if (node && typeof node === 'object') {
        Object.keys(node).forEach(k => {
            // UDF metas (udfMeta / meta) legitimately carry id + externalId;
            // the "exactly one identifier" rule is for ENTITY references, not
            // UDF metas. Leave them untouched.
            if (k === 'udfMeta' || k === 'meta') return;
            const child = node[k];
            if (isRefObject(child)) {
                // Reduce; if no usable identifier remains, drop the whole key.
                if (!reduceRef(child)) delete node[k];
            } else {
                reduceIdentifierRefs(child);
            }
        });
    }
    return node;
}

/**
 * Recursively remove every key whose value is null (FSM rejects explicit
 * nulls on create — it calls .toString() on them). Arrays are preserved
 * (elements recursed); objects drop null-valued keys. MUTATES in place.
 * @param {*} node
 * @returns {*}
 */
function stripNulls(node) {
    if (Array.isArray(node)) {
        node.forEach(el => stripNulls(el));
        return node;
    }
    if (node && typeof node === 'object') {
        Object.keys(node).forEach(k => {
            if (node[k] === null) {
                delete node[k];
            } else {
                stripNulls(node[k]);
            }
        });
    }
    return node;
}

/**
 * Build the Z_FollowUpRevisions update payload for the original activity
 * (Data API shape: { meta: { externalId }, value }).
 *
 * Appends a line for the new revision to the existing value, or creates the
 * value fresh if none exists. The new activity UUID is a placeholder
 * ('<NEW_ACTIVITY_UUID>') substituted by the caller once the activity exists.
 *
 * Line format: "<code> Rev-<N>: <activity link>"
 *
 * De-dup: any prior line for this same original + revision number is dropped
 * before appending, guarding against re-creating the same revision level
 * (e.g. a second smartform reaching the same level). The prefix must be
 * followed by a non-digit so "Rev-3" does not match "Rev-30". The app is the
 * sole writer of this field (no FSM Business Rule writes it), so the only
 * lines present are this app's own "<code> Rev-N: <url>" format.
 *
 * @param {string|null} existingValue - current Z_FollowUpRevisions value
 * @param {string} originalCode - activity code (e.g. '19846')
 * @param {number} nextRevisionNumber
 * @param {string} baseUrl
 * @param {string} companyId
 * @returns {Object} { udfValues: [{ meta: { externalId }, value }] }
 */
function buildFollowUpRevisionsPayload(existingValue, originalCode, nextRevisionNumber, baseUrl, companyId) {
    const n = nextRevisionNumber;
    const base = (baseUrl || '').replace(/\/+$/, '');
    const link = `${base}/shell/#/planning-dispatching/activities/view/<NEW_ACTIVITY_UUID>/details?selectedCompanyId=${companyId}`;
    // Label format: "<code> Rev-<N>: <link>"
    const newLine = `${originalCode} Rev-${n}: ${link}`;

    const prior = (existingValue != null) ? String(existingValue) : '';
    const revPrefix = `${originalCode} Rev-${n}`;
    const keptLines = prior
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (trimmed === '') return false; // drop blank lines
            // Drop any prior line for this same original + revision number.
            // The prefix must be followed by a non-digit (':', ' ', '[', '-')
            // so "Rev-3" does NOT match "Rev-30".
            if (trimmed.startsWith(revPrefix)) {
                const nextChar = trimmed.charAt(revPrefix.length);
                if (nextChar === '' || !/[0-9]/.test(nextChar)) return false;
            }
            return true;
        });

    keptLines.push(newLine);
    const value = '\n' + keptLines.join('\n');

    return {
        udfValues: [
            { meta: { externalId: UDF.FOLLOW_UP_REVISIONS }, value }
        ]
    };
}

module.exports = {
    udfCompositeTree,
    upsertCompositeUdf,
    removeCompositeUdfs,
    transformRevisionHeader,
    transformRevisionActivity,
    uuidV4,
    reduceIdentifierRefs,
    stripNulls,
    buildFollowUpRevisionsPayload
};