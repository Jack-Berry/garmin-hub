const firstValue = (map) => (map ? Object.values(map)[0] : null);

function parseTrainingBalance(rawJson) {
  const statusBlock = rawJson?.training_status;
  const loadBalance = firstValue(
    statusBlock?.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap);
  const status = firstValue(
    statusBlock?.mostRecentTrainingStatus?.latestTrainingStatusData);
  if (!loadBalance && !status) return null;

  const bar = (key, label, value, min, max) => ({
    key,
    label,
    value: value != null ? Math.round(value) : null,
    target_min: min ?? null,
    target_max: max ?? null,
  });
  const acwr = status?.acuteTrainingLoadDTO;
  const acwrValue = acwr &&
    (acwr.dailyAcuteChronicWorkloadRatio != null || acwr.acwrStatus)
    ? {
        ratio: acwr.dailyAcuteChronicWorkloadRatio ?? null,
        status: acwr.acwrStatus || null,
      }
    : null;
  return {
    load_focus: loadBalance ? {
      feedback: loadBalance.trainingBalanceFeedbackPhrase || null,
      bars: [
        bar('low_aerobic', 'Low Aerobic', loadBalance.monthlyLoadAerobicLow,
          loadBalance.monthlyLoadAerobicLowTargetMin, loadBalance.monthlyLoadAerobicLowTargetMax),
        bar('high_aerobic', 'High Aerobic', loadBalance.monthlyLoadAerobicHigh,
          loadBalance.monthlyLoadAerobicHighTargetMin, loadBalance.monthlyLoadAerobicHighTargetMax),
        bar('anaerobic', 'Anaerobic', loadBalance.monthlyLoadAnaerobic,
          loadBalance.monthlyLoadAnaerobicTargetMin, loadBalance.monthlyLoadAnaerobicTargetMax),
      ],
    } : null,
    training_status: status ? {
      phrase: status.trainingStatusFeedbackPhrase || null,
      code: status.trainingStatus ?? null,
    } : null,
    acwr: acwrValue,
  };
}

module.exports = { parseTrainingBalance };
