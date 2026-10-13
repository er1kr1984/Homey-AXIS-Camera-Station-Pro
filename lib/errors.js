'use strict';

// Errors with a code the app can turn into a clear, translated message.
//   unreachable       Camera Station can't be reached (off, wrong address, network)
//   login_failed      username or password not accepted
//   no_rights         the Camera Station user lacks the rights for this action
//   unsupported       this Camera Station version has no web client / WebRTC service
//   cert_changed      the server's certificate differs from the one trusted at login
//   too_many_streams  Homey is already relaying as many live streams as it can
//   not_configured    no Camera Station has been set up yet

class AcsError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']);

// Best-effort code for any error from the ACS client.
function classify(err) {
  if (!err) return 'unknown';
  if (err.code && !NETWORK_CODES.has(err.code) && typeof err.code === 'string' && !/^E[A-Z]/.test(err.code)) return err.code;
  if (NETWORK_CODES.has(err.code) || /timeout|socket hang up/i.test(err.message || '')) return 'unreachable';
  if (/HTTP 401|login failed/i.test(err.message || '')) return 'login_failed';
  if (/HTTP 403|forbidden|not authorized|unauthorized/i.test(err.message || '')) return 'no_rights';
  return 'unknown';
}

module.exports = { AcsError, classify };
