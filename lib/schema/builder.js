const { EventEmitter } = require('events');
const toArray = require('lodash/toArray');
const assign = require('lodash/assign');
const { addQueryContext } = require('../util/helpers');
const saveAsyncStack = require('../util/save-async-stack');
const {
  augmentWithBuilderInterface,
} = require('../builder-interface-augmenter');

// Constructor for the builder instance, typically called from
// `knex.builder`, accepting the current `knex` instance,
// and pulling out the `client` and `grammar` from the current
// knex instance.
class SchemaBuilder extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this._sequence = [];

    if (client.config) {
      this._debug = client.config.debug;
      saveAsyncStack(this, 4);
    }
  }

  withSchema(schemaName) {
    this._schema = schemaName;
    return this;
  }

  toString() {
    return this.toQuery();
  }

  toSQL() {
    return this.client.schemaCompiler(this).toSQL();
  }

  async generateDdlCommands() {
    return await this.client.schemaCompiler(this).generateDdlCommands();
  }
}

// Each of the schema builder methods just add to the
// "_sequence" array for consistency.
for(let method of [
  'createTable',
  'createTableIfNotExists',
  'createTableLike',
  'createView',
  'createViewOrReplace',
  'createMaterializedView',
  'refreshMaterializedView',
  'dropView',
  'dropViewIfExists',
  'dropMaterializedView',
  'dropMaterializedViewIfExists',
  'createSchema',
  'createSchemaIfNotExists',
  'dropSchema',
  'dropSchemaIfExists',
  'createExtension',
  'createExtensionIfNotExists',
  'dropExtension',
  'dropExtensionIfExists',
  'table',
  'alterTable',
  'view',
  'alterView',
  'hasTable',
  'hasColumn',
  'dropTable',
  'renameTable',
  'renameView',
  'dropTableIfExists',
  'raw',
]) {
  SchemaBuilder.prototype[method] = function () {
    if (method === 'table') method = 'alterTable';
    else if (method === 'view') method = 'alterView';
    this._sequence.push({
      method,
      args: toArray(arguments),
    });
    return this;
  };
}

SchemaBuilder.extend = (methodName, fn) => {
  if (
    Object.prototype.hasOwnProperty.call(SchemaBuilder.prototype, methodName)
  ) {
    throw new Error(
      `Can't extend SchemaBuilder with existing method ('${methodName}').`
    );
  }

  assign(SchemaBuilder.prototype, { [methodName]: fn });
};

augmentWithBuilderInterface(SchemaBuilder);
addQueryContext(SchemaBuilder);

module.exports = SchemaBuilder;
