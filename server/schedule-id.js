const scheduleId = (value) => (/^-?\d+$/.test(value || '') ? value : null);

module.exports = { scheduleId };
