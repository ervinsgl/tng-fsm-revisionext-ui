/**
 * FsmHttpClient.js
 *
 * The single backend module that talks to FSM over HTTP. It owns destination
 * resolution, OAuth token retrieval, header/param assembly, and the two read
 * GETs that every higher-level service builds on (Query API + composite-tree).
 *
 * This is the ONLY file (besides DestinationService / TokenCache themselves)
 * that requires axios. The read and write services call into this client
 * rather than re-resolving destinations or rebuilding headers, so the
 * destination name, the six FSM headers, and the account/company fallback are
 * each defined exactly once here.
 *
 * @file utils/FsmHttpClient.js
 * @module utils/FsmHttpClient
 * @requires axios
 * @requires ./DestinationService
 * @requires ./TokenCache
 * @requires ./fsmConstants
 */
'use strict';

const axios = require('axios');
const DestinationService = require('./DestinationService');
const TokenCache = require('./TokenCache');
const { DESTINATION_NAME, FSM_ACCOUNT_DEFAULTS } = require('./fsmConstants');

class FsmHttpClient {
    /**
     * Build the account/company query params, falling back to the app
     * defaults when the destination does not carry its own values.
     * @param {Object} config - destination.destinationConfiguration
     * @returns {{account: string, company: string}}
     * @private
     */
    _baseParams(config) {
        return {
            account: config.account || FSM_ACCOUNT_DEFAULTS.account,
            company: config.company || FSM_ACCOUNT_DEFAULTS.company
        };
    }

    /**
     * Build the six standard FSM headers from the destination config, plus a
     * bearer token. Any extra headers (e.g. X-Create-Or-Update on writes) are
     * merged on top.
     * @param {Object} config - destination.destinationConfiguration
     * @param {string} token - OAuth bearer token
     * @param {Object} [extra] - additional headers to merge
     * @returns {Object} header map
     * @private
     */
    _buildHeaders(config, token, extra) {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Account-ID': config['URL.headers.X-Account-ID'],
            'X-Company-ID': config['URL.headers.X-Company-ID'],
            'X-Client-ID': config['URL.headers.X-Client-ID'],
            'X-Client-Version': config['URL.headers.X-Client-Version'],
            ...(extra || {})
        };
    }

    /**
     * Resolve destination + token + base headers/params for an FSM call.
     * The single entry point every request goes through.
     * @returns {Promise<{baseUrl: string, config: Object, params: Object, headers: Object}>}
     */
    async getRequestContext() {
        const destination = await DestinationService.getDestination(DESTINATION_NAME);
        const token = await TokenCache.getToken(destination);
        const config = destination.destinationConfiguration;
        return {
            baseUrl: config.URL,
            config,
            params: this._baseParams(config),
            headers: this._buildHeaders(config, token)
        };
    }

    /**
     * Make a Query API request (/api/query/v1).
     * @param {string} query - FSM CoreSQL query string
     * @param {string} dtos  - DTO version string (e.g. DTO.CHECKLIST_INSTANCE)
     * @returns {Promise<Object>} API response data ({ data: [...] })
     * @throws {Error} If the request fails
     */
    async makeQueryRequest(query, dtos) {
        try {
            const ctx = await this.getRequestContext();
            const url = `${ctx.baseUrl}/api/query/v1`;
            const params = { ...ctx.params, query, dtos };
            const response = await axios.get(url, { params, headers: ctx.headers });
            return response.data;
        } catch (error) {
            console.error('FsmHttpClient: Query API Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Fetch the full composite-tree of a ServiceCall, then keep only the
     * activity segment whose id matches keepActivityId (the original activity).
     * All other activities under the ServiceCall are dropped.
     *
     * @param {string} serviceCallId - ServiceCall to fetch
     * @param {string} [keepActivityId] - Activity id to retain; if omitted, no filter
     * @returns {Promise<Object>} the composite-tree object with activities filtered
     * @throws {Error} on request failure
     */
    async getServiceCallCompositeTree(serviceCallId, keepActivityId) {
        try {
            const ctx = await this.getRequestContext();
            const url = `${ctx.baseUrl}/api/fsm-connector/v1/composite-tree/service-calls/${serviceCallId}`;
            const response = await axios.get(url, { params: ctx.params, headers: ctx.headers });
            const tree = response.data || {};

            // Keep only the activity segment matching the original activity id.
            if (keepActivityId && Array.isArray(tree.activities)) {
                tree.activities = tree.activities.filter(act => act && act.id === keepActivityId);
            }
            return tree;
        } catch (error) {
            console.error('FsmHttpClient: Composite-tree Error:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Build a CoreSQL IN-list literal from an array of UUIDs.
     * Deduplicates and quotes each value: ['a','b'] -> "'a','b'".
     * @param {Array<string>} ids
     * @returns {string} comma-separated quoted list (empty string if no ids)
     */
    toInList(ids) {
        const unique = [...new Set((ids || []).filter(Boolean))];
        return unique.map(id => `'${id}'`).join(',');
    }
}

module.exports = new FsmHttpClient();