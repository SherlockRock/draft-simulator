// A recording fake of Sequelize's queryInterface for migration shape tests.
// No connection: every call is pushed onto `calls` as { method, args } and
// resolves. `sequelize.transaction(cb)` runs cb with a token transaction and
// records begin/commit/rollback so tests can check atomicity.
//
// `onQuery(sql, options)` (optional) answers raw queries: whatever it returns
// is what `sequelize.query` resolves with, so a test can feed a migration the
// rows a SELECT would find (e.g. a `down` that refuses when rows exist).
const { Sequelize } = require("sequelize");

function createRecordingQueryInterface({ onQuery } = {}) {
  const calls = [];
  const transaction = { id: "fake-transaction" };

  const record = (method) => async (...args) => {
    calls.push({ method, args });
  };

  const query = async (...args) => {
    calls.push({ method: "query", args });
    return onQuery ? onQuery(...args) : undefined;
  };

  const queryInterface = {
    createTable: record("createTable"),
    dropTable: record("dropTable"),
    addColumn: record("addColumn"),
    removeColumn: record("removeColumn"),
    changeColumn: record("changeColumn"),
    addIndex: record("addIndex"),
    removeIndex: record("removeIndex"),
    addConstraint: record("addConstraint"),
    removeConstraint: record("removeConstraint"),
    bulkInsert: record("bulkInsert"),
    bulkUpdate: record("bulkUpdate"),
    sequelize: {
      query,
      transaction: async (callback) => {
        calls.push({ method: "transaction:begin", args: [] });
        try {
          const result = await callback(transaction);
          calls.push({ method: "transaction:commit", args: [] });
          return result;
        } catch (error) {
          calls.push({ method: "transaction:rollback", args: [] });
          throw error;
        }
      },
    },
  };

  return { queryInterface, calls, transaction, Sequelize };
}

// Calls of one method, in order.
function callsTo(calls, method) {
  return calls.filter((call) => call.method === method);
}

// Normalised SQL of every raw query, whitespace collapsed.
function rawSql(calls) {
  return callsTo(calls, "query").map((call) =>
    String(call.args[0]).replace(/\s+/g, " ").trim(),
  );
}

module.exports = { createRecordingQueryInterface, callsTo, rawSql };
