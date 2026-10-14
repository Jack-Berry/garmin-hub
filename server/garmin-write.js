const crypto = require('crypto');

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const pacerInput = (mode, params) => {
  if (!['push', 'reconcile'].includes(mode)) return params;
  return {
    ...params,
    _idempotency_key: crypto.createHash('sha256')
      .update(stableJson(params)).digest('hex').slice(0, 20),
  };
};

const createWriteGate = () => {
  let running = false;
  return {
    enter() {
      if (running) return false;
      running = true;
      return true;
    },
    leave() { running = false; },
  };
};

module.exports = { stableJson, pacerInput, createWriteGate };
