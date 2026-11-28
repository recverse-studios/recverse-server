/**
 * RecVerse Server Authentication - Cloudflare Workers Version
 * JWT validation, password hashing, and token generation
 * Uses jsonwebtoken and bcryptjs via nodejs_compat
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import config from '../config.js';

/**
 * Generate a JWT token
 * @param {Object} payload - Token payload
 * @param {Object} options - JWT sign options
 * @returns {string} Signed JWT token
 */
export function generateToken(payload, options = {}) {
  const secret = config.jwt.secret;
  const defaultOptions = {
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: config.jwt.accessTokenTtl,
  };
  return jwt.sign(payload, secret, { ...defaultOptions, ...options });
}

/**
 * Verify a JWT token
 * @param {string} token - JWT token string
 * @returns {Object|null} Decoded payload or null if invalid
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    });
  } catch (e) {
    return null;
  }
}

/**
 * Hash a password using bcrypt
 * @param {string} password - Plain text password
 * @returns {Promise<string>} Bcrypt hash
 */
export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

/**
 * Verify a password against bcrypt hash
 * @param {string} password - Plain text password
 * @param {string} hash - Bcrypt hash
 * @returns {Promise<boolean>} True if password matches
 */
export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Hash a token for storage (SHA-256)
 * @param {string} token - Token string
 * @returns {string} SHA-256 hash
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a 6-digit numeric code
 * @returns {string} 6-digit code
 */
export function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Hash a code for storage
 * @param {string} code - Code string
 * @returns {string} SHA-256 hash
 */
export function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Get current ISO timestamp
 * @returns {string} ISO 8601 timestamp
 */
export function now() {
  return new Date().toISOString();
}
