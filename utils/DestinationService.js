/**
 * DestinationService.js
 *
 * Backend service for SAP BTP Destination Service integration.
 * Retrieves destination configurations from BTP for FSM API connectivity.
 *
 * Key Features:
 * - Read Destination Service credentials from VCAP_SERVICES
 * - Authenticate with Destination Service using OAuth
 * - Fetch destination configuration by name
 * - Cache the destination in memory with a TTL (default 10 min)
 *
 * Why the cache: every FSM call starts with getDestination(), and each
 * uncached lookup costs TWO outbound HTTPS calls (BTP OAuth token + the
 * destination itself). A single table load runs ~27 FSM queries, so without
 * the cache ~54 of ~81 outbound calls were repeated destination lookups. The
 * destination is static configuration, so a short TTL is safe.
 *
 * Cache behaviour:
 * - Keyed by destination name; per process (instances: 1).
 * - Concurrent callers during a refresh share ONE in-flight request
 *   (the read pipeline fans out with Promise.all).
 * - Failures are never cached: the next call tries BTP again.
 * - Each caller gets its own copy, so a caller mutating the result cannot
 *   affect other callers or the cache.
 * - A destination change in the BTP cockpit takes effect after at most the
 *   TTL, or immediately on restart / restage.
 * - TTL override: env DESTINATION_CACHE_TTL_MS (milliseconds). 0 disables
 *   the cache; lookups running at the same moment are still shared.
 *
 * Note: the app does not use the `authTokens` part of the destination
 * response. The FSM token is fetched separately by TokenCache from the
 * destination's clientId/clientSecret, so caching the destination never
 * serves a stale FSM token.
 *
 * Environment Requirements:
 * - VCAP_SERVICES must contain bound destination service
 * - Destination must be configured in BTP cockpit
 *
 * Destination Configuration Contains:
 * - URL: FSM API base URL
 * - tokenServiceURL: OAuth token endpoint
 * - clientId/clientSecret: OAuth credentials
 *
 * @file DestinationService.js
 * @module utils/DestinationService
 * @requires axios
 */
const axios = require('axios');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve the cache TTL from the environment (read on each call so a
 * cf set-env + restage is honoured; invalid values fall back to the default).
 * @returns {number} TTL in ms (0 = cache disabled)
 */
function resolveTtlMs() {
    const raw = process.env.DESTINATION_CACHE_TTL_MS;
    if (raw == null || raw === '') return DEFAULT_TTL_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

class DestinationService {
    constructor() {
        /**
         * destinationName -> { value: Object, expires: number }
         * @type {Map<string, {value: Object, expires: number}>}
         * @private
         */
        this._cache = new Map();

        /**
         * destinationName -> Promise<Object> for a lookup in progress.
         * @type {Map<string, Promise<Object>>}
         * @private
         */
        this._inFlight = new Map();
    }

    /**
     * Get Destination Service credentials from VCAP_SERVICES.
     * @returns {Object} Destination service credentials
     * @throws {Error} If destination service is not bound
     */
    getCredentials() {
        const vcapServices = JSON.parse(process.env.VCAP_SERVICES || '{}');
        const destinationService = vcapServices.destination?.[0];

        if (!destinationService) {
            throw new Error('Destination service not bound to application');
        }

        return destinationService.credentials;
    }

    /**
     * Get destination configuration from BTP (cached, see file header).
     * @param {string} destinationName - Name of the destination in BTP
     * @returns {Promise<Object>} Destination configuration (a private copy)
     * @throws {Error} If destination cannot be loaded
     */
    async getDestination(destinationName) {
        const ttlMs = resolveTtlMs();

        if (ttlMs > 0) {
            const hit = this._cache.get(destinationName);
            if (hit && Date.now() < hit.expires) {
                return this._copy(hit.value);
            }
        }

        // Share a lookup already in progress with concurrent callers.
        let pending = this._inFlight.get(destinationName);
        if (!pending) {
            pending = this._fetchDestination(destinationName)
                .then(value => {
                    if (ttlMs > 0) {
                        this._cache.set(destinationName, { value, expires: Date.now() + ttlMs });
                    }
                    return value;
                })
                .finally(() => {
                    this._inFlight.delete(destinationName);
                });
            this._inFlight.set(destinationName, pending);
        }

        const value = await pending;
        return this._copy(value);
    }

    /**
     * Drop the cached destination(s). Next call fetches from BTP.
     * @param {string} [destinationName] - one name, or omit for all
     */
    clearCache(destinationName) {
        if (destinationName) this._cache.delete(destinationName);
        else this._cache.clear();
    }

    /**
     * Uncached lookup: BTP OAuth token + destination fetch (unchanged logic).
     * @param {string} destinationName
     * @returns {Promise<Object>}
     * @private
     */
    async _fetchDestination(destinationName) {
        try {
            const credentials = this.getCredentials();

            const tokenResponse = await axios.post(
                credentials.url + '/oauth/token',
                new URLSearchParams({
                    grant_type: 'client_credentials',
                    client_id: credentials.clientid,
                    client_secret: credentials.clientsecret
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            const accessToken = tokenResponse.data.access_token;

            const destinationResponse = await axios.get(
                `${credentials.uri}/destination-configuration/v1/destinations/${destinationName}`,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                }
            );

            return destinationResponse.data;

        } catch (error) {
            console.error('DestinationService: Error loading destination:', error.response?.data || error.message);
            throw new Error('Failed to load destination');
        }
    }

    /**
     * Deep copy so no caller can mutate the cached object.
     * @param {Object} value
     * @returns {Object}
     * @private
     */
    _copy(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }
}

module.exports = new DestinationService();
