const assert = require('node:assert/strict');
const test = require('node:test');
const { parseTrainingBalance } = require('./training-balance');

test('training balance parses Garmin ACWR from the real nested shape', () => {
  const raw = {
    training_status: {
      mostRecentTrainingLoadBalance: {
        metricsTrainingLoadBalanceDTOMap: {
          '123': {
            trainingBalanceFeedbackPhrase: 'BALANCED',
            monthlyLoadAerobicLow: 301.4,
            monthlyLoadAerobicLowTargetMin: 250,
            monthlyLoadAerobicLowTargetMax: 400,
          },
        },
      },
      mostRecentTrainingStatus: {
        latestTrainingStatusData: {
          '123': {
            trainingStatus: 2,
            trainingStatusFeedbackPhrase: 'PRODUCTIVE',
            acuteTrainingLoadDTO: {
              dailyAcuteChronicWorkloadRatio: 1.17,
              acwrStatus: 'OPTIMAL',
            },
          },
        },
      },
    },
  };
  const parsed = parseTrainingBalance(raw);
  assert.deepEqual(parsed.acwr, { ratio: 1.17, status: 'OPTIMAL' });
  assert.deepEqual(parsed.training_status, { phrase: 'PRODUCTIVE', code: 2 });
  assert.equal(parsed.load_focus.bars[0].value, 301);
  assert.equal(parseTrainingBalance({}), null);
});
