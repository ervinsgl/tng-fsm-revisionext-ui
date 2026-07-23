/**
 * fsmConstants.js
 *
 * Single source of truth for the magic strings used across the FSM backend
 * services: BTP destination name, the required smartform tag, DTO version
 * strings, UDF externalIds, and FSM type codes.
 *
 * Why this file exists:
 * These literals were previously inlined (and repeated) throughout
 * FSMService.js. Centralising them means a DTO version bump, a UDF rename,
 * or a destination change is a one-line edit here instead of a search across
 * the whole service. Each group documents where its members are used so the
 * blast radius of a change is obvious.
 *
 * Nothing in this file performs I/O or holds state — it is a plain set of
 * frozen value objects, safe to require from anywhere on the backend.
 *
 * @file utils/fsmConstants.js
 * @module utils/fsmConstants
 */
'use strict';

/**
 * The single BTP destination used for ALL outbound FSM calls in this app.
 * Outbound OAuth (client-credentials) is configured on this destination in
 * the BTP cockpit. Change here only.
 * @type {string}
 */
const DESTINATION_NAME = 'FSM_OAUTH_CONNECT';

/**
 * The tag name a smartform's ChecklistTemplate must carry for the smartform
 * to be shown / treated as an inspection. Used by the read pipeline's
 * Inspection filter (getInspectionSmartformsForActivity).
 * @type {string}
 */
const REQUIRED_TAG = 'Inspection';

/**
 * Fallback FSM account/company, used only when the destination does not
 * carry account/company values of its own. Mirrors the old
 * FSMService.config defaults.
 * @type {{account: string, company: string}}
 */
const FSM_ACCOUNT_DEFAULTS = Object.freeze({
    account: 'TUEV-NORD_T1',
    company: 'TUEV-NORD_S4E'
});

/**
 * FSM DTO version strings, passed as the `dtos` query/data-API parameter.
 * FSM is version-pinned per DTO; when FSM upgrades a DTO you bump the number
 * HERE and every query/write using it follows.
 *
 * Usage map (read R / write W):
 *   ACTIVITY            R: _getActivityCore, _getRevisionActivities,
 *                          _getRevisionActivityId   W: _patchActivity
 *   ATTACHMENT          R: _getAttachmentForSmartform, _getAttachmentsBySourceIds
 *   CHECKLIST_INSTANCE  R: _getChecklistInstances, _getChecklistInstanceFull
 *                       W: _postChecklistInstance
 *   CHECKLIST_TEMPLATE  R: _getTemplatesByIds
 *   CHECKLIST_TAG       R: _getTagNamesByIds
 *   SERVICE_CALL        R: _getServiceCallIdByRevision, _getRevisionServiceCalls
 *
 * @type {Readonly<Object<string,string>>}
 */
const DTO = Object.freeze({
    ACTIVITY:           'Activity.43',
    ATTACHMENT:         'Attachment.19',
    CHECKLIST_INSTANCE: 'ChecklistInstance.20',
    CHECKLIST_TEMPLATE: 'ChecklistTemplate.21',
    CHECKLIST_TAG:      'ChecklistTag.10',
    SERVICE_CALL:       'ServiceCall.27'
});

/**
 * UDF externalIds referenced by the read and write pipelines. These are the
 * stable external identifiers of the custom fields in FSM; renaming a UDF in
 * FSM means changing it once here.
 *
 * Note on shape: the SAME externalId is written two ways depending on the API.
 *   - composite-tree payloads use { udfMeta: { externalId }, value }
 *   - Data API (v4) payloads use   { meta:    { externalId }, value }
 * The externalId value itself is identical; only the wrapper key differs.
 * These constants hold just the externalId.
 *
 * @type {Readonly<Object<string,string>>}
 */
const UDF = Object.freeze({
    // Revision ServiceCall markers (suffix-proof existence check).
    REVISION_OF_ACTIVITY:     'Z_RevisionOfActivity',
    REVISION_NUMBER:          'Z_revisionNumber',

    // Original-activity follow-up links (one line per created revision).
    FOLLOW_UP_REVISIONS:      'Z_FollowUpRevisions',

    // Revision-activity markers / links.
    ACT_REVISION_OF_ACTIVITY: 'Z_Act_RevisionOfActivity',
    UPDATE_ATTRIBUTES:        'Z_UpdateAttributes',
    ACTIVITY_TYPE:            'Z_Activity_Type',

    // Smartform (ChecklistInstance) chain + report number.
    PREVIOUS_CHECKLIST:       'Z_PreviousChecklist',
    PRUEFBERICHT_NR:          'Z_PruefberichtNr',

    // Attachment description.
    ATTACHMENT_DESCRIPTION:   'Z_Attachment_Description',

    // Original-activity UDFs removed from the revision activity.
    ACT_S4_ITEM_DESCRIPTION:  'Z_Act_S4ItemDescription',
    ACT_APPROVAL_HISTORY:     'Z_ActApprovalHistory'
});

/**
 * FSM type codes (string-valued in payloads).
 *
 * ServiceCall.type:
 *   ORIGINAL ('-1')  the original ServiceCall (informational; not written here)
 *   REVISION ('-8')  a revision ServiceCall header
 *
 * Activity Z_Activity_Type:
 *   REVISION_ACTIVITY ('-7')  a revision activity (set on create + relink)
 *
 * @type {Readonly<Object<string,string>>}
 */
const TYPE = Object.freeze({
    SERVICE_CALL_ORIGINAL: '-1',
    SERVICE_CALL_REVISION: '-8',
    ACTIVITY_REVISION:     '-7'
});

module.exports = {
    DESTINATION_NAME,
    REQUIRED_TAG,
    FSM_ACCOUNT_DEFAULTS,
    DTO,
    UDF,
    TYPE
};