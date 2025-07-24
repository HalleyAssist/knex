'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.getDialectByNameOrAlias = void 0;
const { resolveClientNameWithAliases } = require('../util/helpers');
const dbNameToDialectLoader = Object.freeze({
  postgres: () => require('./postgres'),
  sqlite3: () => require('./sqlite3'),
});
/**
 * Gets the Dialect object with the given client name or throw an
 * error if not found.
 *
 * NOTE: This is a replacement for prior practice of doing dynamic
 * string construction for imports of Dialect objects.
 */
function getDialectByNameOrAlias(clientName) {
  const resolvedClientName = resolveClientNameWithAliases(clientName);
  const dialectLoader = dbNameToDialectLoader[resolvedClientName];
  if (!dialectLoader) {
    throw new Error(`Invalid clientName given: ${clientName}`);
  }
  return dialectLoader();
}
exports.getDialectByNameOrAlias = getDialectByNameOrAlias;
//# sourceMappingURL=index.js.map
