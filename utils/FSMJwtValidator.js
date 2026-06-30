/**
 * FSMJwtValidator.js
 *
 * Tier 2 of the inbound auth model (see SECURITY.md): cryptographic
 * verification of FSM-issued JWTs against FSM's public JWKS endpoint. Used by
 * the Web UI Shell flow — the frontend captures the Shell SDK's access_token
 * (RS256-signed JWT) and POSTs it to /api/v1/shell-session-init, which calls
 * verify() here before issuing a session token.
 *
 * Safety properties (ported from the reference app):
 *   - Algorithm allow-list (['RS256']) — blocks the alg:none downgrade and
 *     HS256/RS256 confusion attacks.
 *   - Public keys cached 24h — FSM keys rotate rarely; no per-request fetch.
 *   - JWKS fetch rate-limited (10/min) — caps re-fetching if the cache misses.
 *   - jsonwebtoken's default expiration / notBefore validation enabled.
 *
 * JWKS endpoint (DE region) is the default; override via FSM_JWKS_URL for other
 * regions/environments.
 *
 * @file utils/FSMJwtValidator.js
 * @module utils/FSMJwtValidator
 * @requires jsonwebtoken
 * @requires jwks-rsa
 */
'use strict';

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const DEFAULT_JWKS_URL = 'https://de.fsm.cloud.sap/api/oauth2/v2/.well-known/jwks.json';

class FSMJwtValidator {
    constructor() {
        this.jwksUri = process.env.FSM_JWKS_URL || DEFAULT_JWKS_URL;

        // jwks-rsa manages the kid -> public key cache and rate limiting.
        this.client = jwksClient({
            jwksUri: this.jwksUri,
            cache: true,
            cacheMaxAge: 24 * 60 * 60 * 1000, // 24h key cache
            rateLimit: true,
            jwksRequestsPerMinute: 10
        });

        // Bound getKey for jsonwebtoken's callback-style secret resolver.
        this._getKey = this._getKey.bind(this);
    }

    /**
     * jsonwebtoken key resolver: look up the signing key for the token's kid.
     * @param {Object} header - decoded JWT header ({ kid, alg })
     * @param {Function} callback - (err, signingKey)
     * @private
     */
    _getKey(header, callback) {
        this.client.getSigningKey(header.kid, (err, key) => {
            if (err) return callback(err);
            const signingKey = key.getPublicKey();
            callback(null, signingKey);
        });
    }

    /**
     * Verify an FSM-issued JWT. Resolves with the decoded payload on success,
     * rejects on any signature / expiry / algorithm failure.
     * @param {string} token - the raw JWT string
     * @returns {Promise<Object>} decoded, verified payload
     */
    verify(token) {
        return new Promise((resolve, reject) => {
            if (!token || typeof token !== 'string') {
                return reject(new Error('No token provided'));
            }
            jwt.verify(
                token,
                this._getKey,
                { algorithms: ['RS256'] }, // allow-list: RS256 only
                (err, decoded) => {
                    if (err) return reject(err);
                    resolve(decoded);
                }
            );
        });
    }
}

module.exports = new FSMJwtValidator();